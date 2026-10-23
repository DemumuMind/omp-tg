import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { InlineKeyboardMarkup } from "grammy/types";
import { escapeFor } from "../utils/escape.ts";
import type { Config } from "../config/env.ts";
import type { Logger } from "../utils/logger.ts";
import {
  AvailableCommandsSchema,
  type BashResult,
  type ImageContent,
  type ModelInfo,
  type PromptResult,
  type SessionState,
  type SessionStats,
  type UiResponsePayload,
} from "./protocol.ts";
import { extractImages, extractTextDelta, extractToolActivity } from "./protocol.ts";
import { StreamRenderer } from "../telegram/stream.ts";
import { sessionDir, sessionKey } from "../telegram/session-key.ts";
import type { Sender, Target } from "../telegram/sender.ts";
import { UiController } from "./ui-controller.ts";
import type { GatewayCommand } from "../telegram/commands.ts";
import { extractMediaTags, stripMediaTags } from "../telegram/media-tags.ts";
import { resolveSandboxPath } from "../telegram/sandbox.ts";
import { synthesizeSpeech } from "../tts/client.ts";
import { plainTextForTts } from "../tts/text.ts";

export interface SessionClient {
  start(): Promise<{ protocolVersion: number; sessionFile?: string; resumed: boolean }>;
  prompt(message: string, images?: ImageContent[]): Promise<string>;
  waitForPrompt(id: string): Promise<PromptResult>;
  waitForSettle(since?: number): Promise<void>;
  readonly settleEpoch: number;
  abort(): Promise<void>;
  newSession(): Promise<void>;
  getState(): Promise<SessionState>;
  getAvailableCommands(): Promise<unknown>;
  getAvailableModels(): Promise<ModelInfo[]>;
  setModel(provider: string, modelId: string): Promise<ModelInfo>;
  getSessionStats(): Promise<SessionStats>;
  exportHtml(outputPath: string): Promise<string>;
  setSessionName(name: string): Promise<void>;
  switchSession(sessionPath: string): Promise<boolean>;
  bash(command: string): Promise<BashResult>;
  abortBash(): Promise<void>;
  close(): Promise<void>;
  respond(id: string, payload: UiResponsePayload): void;
  readonly alive: boolean;
}

export type SessionManagerCommand = Extract<
  GatewayCommand,
  { kind: "new" | "abort" | "status" | "cancel" | "usage" | "model" | "export" | "sessions" | "title" | "resume" }
>;

export class BashTimeoutError extends Error {
  constructor() {
    super("bash timed out");
    this.name = "BashTimeoutError";
  }
}

export class BusyError extends Error {
  constructor() {
    super("all session slots are busy");
    this.name = "BusyError";
  }
}

interface ActivityEntry {
  id: string;
  name: string;
  summary?: string;
  status: "running" | "done" | "error";
}

interface ActiveRun {
  renderer: StreamRenderer;
  text: string;
  images: ImageContent[];
  imageKeys: Set<string>;
  activity: ActivityEntry[];
  messageId?: number;
  voiceReply: boolean;
}

interface ModelPicker {
  token: string;
  key: string;
  target: Target;
  models: ModelInfo[];
  page: number;
  messageId: number;
  expiresAt: number;
}

const MODEL_PAGE_SIZE = 8;

function renderRun(run: ActiveRun): string {
  const lines = run.activity.map((entry) => {
    const mark = entry.status === "running" ? "▸" : entry.status === "error" ? "✗" : "✓";
    return `${mark} ${entry.name}${entry.summary ? ` — ${entry.summary}` : ""}`;
  });
  const text = stripMediaTags(run.text).trim();
  if (lines.length === 0) return text;
  const block = lines.join("\n");
  return text === "" ? block : `${block}\n\n${text}`;
}

interface SessionHandle {
  key: string;
  dir: string;
  target: Target;
  client: SessionClient;
  phase: "starting" | "ready" | "busy" | "closed";
  lastUsed: number;
  run: ActiveRun | null;
  ui: UiController;
}

export interface SessionHooks {
  onEvent: (frame: unknown) => void;
  onUiRequest: (req: Parameters<UiController["handle"]>[0]) => void;
  onExit: () => void;
}

export interface SessionManagerDeps {
  config: Config;
  sender: Sender;
  log: Logger;
  createClient: (dir: string, key: string, hooks: SessionHooks) => SessionClient;
  now?: () => number;
}

export class SessionManager {
  readonly #deps: SessionManagerDeps;
  readonly #handles = new Map<string, SessionHandle>();
  readonly #creating = new Map<string, Promise<SessionHandle>>();
  readonly #modelPickers = new Map<string, ModelPicker>();
  #commandCache: { commands: Array<{ name: string; description?: string }>; expiresAt: number } | null = null;
  #sweeper: ReturnType<typeof setInterval> | null = null;
  #shuttingDown = false;

  constructor(deps: SessionManagerDeps) {
    this.#deps = deps;
    this.#sweeper = setInterval(() => {
      void this.sweepIdle();
    }, 60_000);
    this.#sweeper.unref?.();
  }

  get size(): number {
    return this.#handles.size;
  }

  activeDirs(): Set<string> {
    return new Set([...this.#handles.values()].filter((handle) => handle.phase !== "closed").map((handle) => handle.dir));
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now();
  }

  async handleText(
    target: Target,
    text: string,
    images?: ImageContent[],
    meta: { messageId?: number; voiceReply?: boolean } = {},
  ): Promise<void> {
    let handle: SessionHandle;
    try {
      handle = await this.#getOrCreate(target);
    } catch (error) {
      if (error instanceof BusyError) {
        await this.#deps.sender.sendText(target, "⏳ Все сессии заняты, попробуйте позже");
        return;
      }
      this.#deps.log.error("session_start_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      await this.#deps.sender.sendText(target, "⚠️ OMP недоступен");
      return;
    }
    if (handle.ui.expectsText) {
      await handle.ui.handleText(text);
      return;
    }
    if (handle.run !== null) {
      await this.#deps.sender.sendText(target, "⏳ Агент ещё работает. Остановить: /abort", {
        replyMarkup: this.#deps.sender.stopKeyboard(),
      });
      return;
    }
    void this.#startRun(handle, text, images ?? [], meta).catch((error: unknown) => {
      this.#deps.log.error("session_task_failed", { message: errorText(error) });
    });
  }

  async runBash(target: Target, command: string, timeoutMs: number): Promise<BashResult> {
    const handle = await this.#getOrCreate(target);
    const waiter = Promise.withResolvers<BashResult>();
    const timer = setTimeout(() => {
      void handle.client.abortBash().catch(() => undefined);
      waiter.reject(new BashTimeoutError());
    }, timeoutMs);
    handle.client.bash(command).then(waiter.resolve, waiter.reject).finally(() => clearTimeout(timer));
    return waiter.promise;
  }

  async handleCallback(target: Target, data: string): Promise<string | undefined> {
    const handle = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
    if (!handle || handle.phase === "closed") return "Устарело";
    handle.lastUsed = this.#now();
    if (data.startsWith("mdl:")) return this.#handleModelCallback(target, data);
    if (data === "act:stop") {
      this.#deps.log.info("abort_requested", { key: handle.key });
      await handle.ui.cancelAll("abort").catch(() => undefined);
      await handle.client.abortBash().catch(() => undefined);
      await handle.client.abort().catch(() => undefined);
      return "⛔ Останавливаю";
    }
    return handle.ui.handleCallback(data, target);
  }

  async handleCommand(target: Target, cmd: SessionManagerCommand): Promise<void> {
    if (cmd.kind === "cancel") {
      const handle = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!handle) {
        await this.#deps.sender.sendText(target, "Нечего отменять");
        return;
      }
      await handle.ui.cancelAll("abort");
      await this.#deps.sender.sendText(target, "Отменено");
      return;
    }

    if (cmd.kind === "status") {
      const handle = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!handle || handle.phase === "closed") {
        await this.#deps.sender.sendText(target, "Сессия не запущена");
        return;
      }
      handle.lastUsed = this.#now();
      try {
        const state = await handle.client.getState();
        await this.#deps.sender.sendText(
          target,
          [
            `<b>Модель:</b> ${escapeFor("HTML", state.model?.id ?? state.model?.name ?? "—")}`,
            `<b>Сессия:</b> <code>${escapeFor("HTML", state.sessionId)}</code>${state.sessionName ? ` — ${escapeFor("HTML", state.sessionName)}` : ""}`,
            `<b>Занят:</b> ${handle.phase === "busy" ? "да" : "нет"}`,
            `<b>Сообщений:</b> ${state.messageCount}`,
          ].join("\n"),
        );
      } catch (error) {
        await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
      }
      return;
    }

    if (cmd.kind === "usage") {
      const existing = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!existing || existing.phase === "closed") {
        await this.#deps.sender.sendText(target, "Сессия не запущена");
        return;
      }
      existing.lastUsed = this.#now();
      try {
        const stats = await existing.client.getSessionStats();
        await this.#deps.sender.sendText(
          target,
          [
            `<b>Сессия:</b> <code>${escapeFor("HTML", stats.sessionId)}</code>`,
            `Сообщений: ${stats.totalMessages} (user ${stats.userMessages}, assistant ${stats.assistantMessages})`,
            `Инструментов: ${stats.toolCalls}`,
            `Токены: in ${stats.tokens.input} / out ${stats.tokens.output} / total ${stats.tokens.total}`,
            `Стоимость: $${stats.cost.toFixed(4)}`,
          ].join("\n"),
        );
      } catch (error) {
        await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
      }
      return;
    }

    if (cmd.kind === "model") {
      let handle: SessionHandle;
      try {
        handle = await this.#getOrCreate(target);
      } catch (error) {
        if (error instanceof BusyError) {
          await this.#deps.sender.sendText(target, "⏳ Все сессии заняты, попробуйте позже");
          return;
        }
        await this.#deps.sender.sendText(target, "⚠️ OMP недоступен");
        return;
      }
      await this.#showModelPicker(handle, cmd.query);
      return;
    }

    if (cmd.kind === "export") {
      const existing = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!existing || existing.phase === "closed") {
        await this.#deps.sender.sendText(target, "Сессия не запущена");
        return;
      }
      try {
        const dir = join(this.#deps.config.OMP_WORKDIR, ".omp-tg-exports");
        await mkdir(dir, { recursive: true });
        const requested = join(dir, `session-${Date.now()}.html`);
        const actual = await resolveSandboxPath(this.#deps.config, await existing.client.exportHtml(requested));
        if (actual === null) {
          await this.#deps.sender.sendText(target, "⛔ Экспорт вне рабочего каталога");
          return;
        }
        if (await this.#deps.sender.sendAttachment(target, actual)) {
          await this.#deps.sender.sendText(target, "Экспорт готов");
        }
      } catch (error) {
        await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
      }
      return;
    }

    if (cmd.kind === "title") {
      const name = cmd.name.trim();
      if (name === "") {
        await this.#deps.sender.sendText(target, "Использование: <code>/title &lt;name&gt;</code>");
        return;
      }
      const existing = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!existing || existing.phase === "closed") {
        await this.#deps.sender.sendText(target, "Сессия не запущена");
        return;
      }
      try {
        await existing.client.setSessionName(name);
        await this.#deps.sender.sendText(target, `🏷 ${escapeFor("HTML", name)}`);
      } catch (error) {
        await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
      }
      return;
    }

    if (cmd.kind === "sessions") {
      const sessions = await this.#recentSessions(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (sessions.length === 0) {
        await this.#deps.sender.sendText(target, "Сессий пока нет");
        return;
      }
      const lines = ["<b>Сессии</b>"];
      sessions.forEach((session, index) => {
        const date = new Date(session.mtime).toISOString().slice(0, 16).replace("T", " ");
        lines.push(`${index + 1}. <code>${escapeFor("HTML", basename(session.path))}</code> — ${date} — ${Math.round(session.size / 1024)} KB`);
      });
      lines.push("", "Восстановить: <code>/resume &lt;номер&gt;</code>");
      await this.#deps.sender.sendText(target, lines.join("\n"));
      return;
    }

    if (cmd.kind === "resume") {
      let existing = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!existing || existing.phase === "closed") {
        try {
          existing = await this.#getOrCreate(target);
        } catch (error) {
          if (error instanceof BusyError) {
            await this.#deps.sender.sendText(target, "⏳ Все сессии заняты, попробуйте позже");
            return;
          }
          await this.#deps.sender.sendText(target, "⚠️ OMP недоступен");
          return;
        }
      }
      if (existing.run !== null) {
        await this.#deps.sender.sendText(target, "Сначала останови текущую задачу: /stop");
        return;
      }
      const needle = cmd.target.trim();
      if (needle === "") {
        await this.#deps.sender.sendText(target, "Использование: <code>/resume &lt;номер|id&gt;</code>");
        return;
      }
      const sessions = await this.#recentSessions(sessionKey(target.chatId, target.messageThreadId, target.userId));
      const index = Number(needle);
      const picked = Number.isInteger(index) && index >= 1
        ? sessions[index - 1]
        : sessions.find((session) => basename(session.path).includes(needle)) ?? sessions[0];
      if (!picked) {
        await this.#deps.sender.sendText(target, "Сессия не найдена");
        return;
      }
      try {
        const cancelled = await existing.client.switchSession(picked.path);
        if (cancelled) {
          await this.#deps.sender.sendText(target, "Переключение отменено");
          return;
        }
        await this.#deps.sender.sendText(target, `↩️ Сессия: <code>${escapeFor("HTML", basename(picked.path))}</code>`);
      } catch (error) {
        await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
      }
      return;
    }

    if (cmd.kind === "abort") {
      const existing = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
      if (!existing || existing.phase === "closed") {
        await this.#deps.sender.sendText(target, "Нечего прерывать");
        return;
      }
      this.#deps.log.info("abort_requested", { key: existing.key });
      try {
        await existing.ui.cancelAll("abort");
        await existing.client.abortBash().catch(() => undefined);
        await existing.client.abort();
        await this.#deps.sender.sendText(target, "⛔ Прерываю");
      } catch (error) {
        await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
      }
      return;
    }

    let handle: SessionHandle;
    try {
      handle = await this.#getOrCreate(target);
    } catch (error) {
      if (error instanceof BusyError) {
        await this.#deps.sender.sendText(target, "⏳ Все сессии заняты, попробуйте позже");
        return;
      }
      await this.#deps.sender.sendText(target, "⚠️ OMP недоступен");
      return;
    }

    try {
      await handle.ui.cancelAll("abort");
      await handle.client.newSession();
      await this.#deps.sender.sendText(target, "🆕 Новая сессия");
    } catch (error) {
      await this.#deps.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
    }
  }

  async #getOrCreate(target: Target): Promise<SessionHandle> {
    if (this.#shuttingDown) throw new Error("shutting down");
    const key = sessionKey(target.chatId, target.messageThreadId, target.userId);
    const existing = this.#handles.get(key);
    if (existing && existing.phase !== "closed") {
      existing.lastUsed = this.#now();
      return existing;
    }
    const pending = this.#creating.get(key);
    if (pending) return pending;

    const slot = Promise.withResolvers<SessionHandle>();
    this.#creating.set(key, slot.promise);
    void this.#create(target, key)
      .then(slot.resolve, slot.reject)
      .finally(() => {
        this.#creating.delete(key);
      });
    return slot.promise;
  }

  async #create(target: Target, key: string): Promise<SessionHandle> {
    if (
      this.#handles.size >= this.#deps.config.MAX_ACTIVE_SESSIONS ||
      this.#handles.size + this.#creating.size > this.#deps.config.MAX_ACTIVE_SESSIONS
    ) {
      const victim = [...this.#handles.values()]
        .filter((handle) => handle.phase === "ready" && handle.run === null)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim) throw new BusyError();
      this.#handles.delete(victim.key);
      victim.phase = "closed";
      await victim.client.close();
    }

    const dir = sessionDir(this.#deps.config.OMP_SESSION_ROOT, key);
    await mkdir(dir, { recursive: true });
    if (this.#shuttingDown) throw new Error("shutting down");

    let handle!: SessionHandle;
    const client = this.#deps.createClient(dir, key, {
      onEvent: (frame) => this.#onEvent(handle, frame),
      onUiRequest: (req) => {
        void handle.ui.handle(req).catch((error: unknown) => {
          this.#deps.log.error("ui_request_failed", { message: errorText(error) });
        });
      },
      onExit: () => {
        if (handle.phase === "closed") return;
        handle.phase = "closed";
        this.#handles.delete(handle.key);
        this.#deps.log.warn("session_client_exited", { key: handle.key });
      },
    });
    handle = {
      key,
      dir,
      target,
      client,
      phase: "starting",
      lastUsed: this.#now(),
      run: null,
      ui: new UiController(client, this.#deps.sender, target, this.#deps.log),
    };
    this.#handles.set(key, handle);

    try {
      await client.start();
      handle.phase = "ready";
      this.#deps.log.info("session_started", { key, dir });
      return handle;
    } catch (error) {
      this.#handles.delete(key);
      handle.phase = "closed";
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async #startRun(
    handle: SessionHandle,
    text: string,
    images: ImageContent[],
    meta: { messageId?: number; voiceReply?: boolean } = {},
  ): Promise<void> {
    handle.phase = "busy";
    const renderer = new StreamRenderer(
      this.#deps.sender,
      handle.target,
      this.#deps.config.THROTTLE_MS,
      this.#deps.log,
      this.#deps.sender.stopKeyboard(),
      this.#deps.config.TELEGRAM_SILENT_PROGRESS,
    );
    const run: ActiveRun = {
      renderer,
      text: "",
      images: [],
      imageKeys: new Set(),
      activity: [],
      messageId: meta.messageId,
      voiceReply: meta.voiceReply === true,
    };
    handle.run = run;
    this.#deps.log.info("run_started", { key: handle.key });
    for (const image of images) this.#addImage(run, image);

    const typing = setInterval(() => {
      void this.#deps.sender.typing(handle.target);
    }, 4000);
    typing.unref?.();
    void this.#deps.sender.typing(handle.target);

    let outcome: "ok" | "error" | "aborted" = "ok";
    try {
      const id = await handle.client.prompt(text, images);
      const settleEpoch = handle.client.settleEpoch;
      const result = await handle.client.waitForPrompt(id);
      this.#deps.log.info("run_finished", { key: handle.key, status: result.status });
      if (result.agentInvoked && !result.sessionSettled) {
        await handle.client.waitForSettle(settleEpoch);
      }
      const media = extractMediaTags(run.text);
      this.#deps.log.debug("media_extracted", { paths: media.paths, text: media.text });
      const files: string[] = [];
      for (const candidate of media.paths) {
        const actual = await resolveSandboxPath(this.#deps.config, candidate);
        if (actual === null) {
          this.#deps.log.warn("media_outside_workspace", { path: candidate });
          continue;
        }
        files.push(actual);
      }
      await renderer.finalize(media.text, run.images, files);
      if (
        run.voiceReply &&
        result.status === "completed" &&
        this.#deps.config.TTS_ENABLED &&
        media.text.trim() !== ""
      ) {
        const spoken = plainTextForTts(media.text, this.#deps.config.TTS_MAX_CHARS);
        if (spoken !== "") {
          const audio = await synthesizeSpeech({
            url: this.#deps.config.TTS_URL,
            text: spoken,
            timeoutMs: this.#deps.config.TTS_TIMEOUT_MS,
          });
          if (audio !== null) {
            await this.#deps.sender.sendVoice(handle.target, audio);
          } else {
            this.#deps.log.warn("tts_failed", { key: handle.key });
          }
        }
      }
      if (result.status === "aborted") outcome = "aborted";
      if (result.status === "error") {
        outcome = "error";
        const message = result.error?.message ?? "неизвестная ошибка";
        await this.#deps.sender.sendText(handle.target, `⚠️ ${escapeFor("HTML", message)}`);
      }
    } catch (error) {
      outcome = "error";
      this.#deps.log.error("run_failed", { message: errorText(error) });
      await renderer.discard().catch(() => undefined);
      await this.#deps.sender
        .sendText(handle.target, `⚠️ ${escapeFor("HTML", errorText(error))}`)
        .catch(() => undefined);
    } finally {
      if (this.#deps.config.TELEGRAM_REACTIONS && run.messageId !== undefined && outcome !== "aborted") {
        void this.#deps.sender.react(handle.target, run.messageId, outcome === "ok" ? "👍" : "👎");
      }
      clearInterval(typing);
      handle.run = null;
      handle.phase = handle.client.alive ? "ready" : "closed";
      handle.lastUsed = this.#now();
    }
  }

  #addImage(run: ActiveRun, image: ImageContent): void {
    const key = image.mimeType + image.data.slice(0, 64) + image.data.length;
    if (run.imageKeys.has(key)) return;
    run.imageKeys.add(key);
    run.images.push(image);
  }

  #onEvent(handle: SessionHandle, frame: unknown): void {
    const run = handle.run;
    if (!run) return;

    const tool = extractToolActivity(frame);
    if (tool) {
      if (tool.phase === "start") {
        run.activity.push({
          id: tool.toolCallId,
          name: tool.toolName,
          ...(tool.summary ? { summary: tool.summary } : {}),
          status: "running",
        });
        if (run.activity.length > 12) run.activity.splice(0, run.activity.length - 12);
      } else {
        const entry = run.activity.find((item) => item.id === tool.toolCallId);
        if (entry) entry.status = tool.isError ? "error" : "done";
      }
      run.renderer.update(renderRun(run));
    }

    const delta = extractTextDelta(frame);
    if (delta !== null) {
      run.text += delta;
      run.renderer.update(renderRun(run));
    }
    for (const image of extractImages(frame)) this.#addImage(run, image);
  }

  async listCommands(target: Target): Promise<Array<{ name: string; description?: string }>> {
    const handle = this.#handles.get(sessionKey(target.chatId, target.messageThreadId, target.userId));
    if (!handle || handle.phase === "closed") return [];
    try {
      const parsed = AvailableCommandsSchema.safeParse(await handle.client.getAvailableCommands());
      if (!parsed.success) return [];
      this.#commandCache = { commands: parsed.data.commands, expiresAt: Date.now() + 10 * 60 * 1000 };
      return parsed.data.commands;
    } catch {
      return [];
    }
  }

  cachedCommands(): Array<{ name: string; description?: string }> {
    if (!this.#commandCache || this.#commandCache.expiresAt < Date.now()) return [];
    return this.#commandCache.commands;
  }

  async #showModelPicker(handle: SessionHandle, query: string): Promise<void> {
    try {
      const models = await handle.client.getAvailableModels();
      if (models.length === 0) {
        await this.#deps.sender.sendText(handle.target, "Модели не найдены");
        return;
      }

      const needle = query.trim().toLowerCase();
      if (needle !== "") {
        const exact = models.find(
          (model) => model.id.toLowerCase() === needle || `${model.provider}/${model.id}`.toLowerCase() === needle,
        );
        if (exact) {
          await this.#applyModel(handle, exact);
          return;
        }
        const matches = models.filter(
          (model) =>
            model.id.toLowerCase().includes(needle) ||
            (model.name ?? "").toLowerCase().includes(needle) ||
            model.provider.toLowerCase().includes(needle),
        );
        if (matches.length === 0) {
          await this.#deps.sender.sendText(handle.target, "Модель не найдена");
          return;
        }
        if (matches.length === 1) {
          await this.#applyModel(handle, matches[0]!);
          return;
        }
      }

      const state = await handle.client.getState();
      const token = randomBytes(6).toString("base64url").slice(0, 8);
      const picker: ModelPicker = {
        token,
        key: handle.key,
        target: handle.target,
        models,
        page: 0,
        messageId: 0,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      const view = this.#modelPickerView(picker, state.model?.id);
      const ids = await this.#deps.sender.sendText(handle.target, view.html, { replyMarkup: view.keyboard });
      picker.messageId = ids[0] ?? 0;
      this.#modelPickers.set(token, picker);
      while (this.#modelPickers.size > 64) {
        const oldest = this.#modelPickers.keys().next().value;
        if (oldest === undefined) break;
        this.#modelPickers.delete(oldest);
      }
    } catch (error) {
      await this.#deps.sender.sendText(handle.target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
    }
  }

  async #applyModel(handle: SessionHandle, model: ModelInfo): Promise<void> {
    try {
      await handle.client.setModel(model.provider, model.id);
      await this.#deps.sender.sendText(
        handle.target,
        `✅ Модель: <code>${escapeFor("HTML", `${model.provider}/${model.id}`)}</code>`,
      );
    } catch (error) {
      await this.#deps.sender.sendText(handle.target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
    }
  }

  #modelPickerView(picker: ModelPicker, currentId: string | undefined): { html: string; keyboard: InlineKeyboardMarkup } {
    const pages = Math.max(1, Math.ceil(picker.models.length / MODEL_PAGE_SIZE));
    picker.page = Math.min(Math.max(picker.page, 0), pages - 1);
    const start = picker.page * MODEL_PAGE_SIZE;
    const visible = picker.models.slice(start, start + MODEL_PAGE_SIZE);
    const rows: Array<Array<{ text: string; callback_data: string }>> = visible.map((model, offset) => {
      const check = model.id === currentId ? "✓ " : "";
      const label = `${check}${model.name ?? model.id} (${model.provider})`;
      return [
        {
          text: label.length > 48 ? `${label.slice(0, 47)}…` : label,
          callback_data: `mdl:${picker.token}:s:${start + offset}`,
        },
      ];
    });
    const nav: Array<{ text: string; callback_data: string }> = [];
    if (picker.page > 0) nav.push({ text: "◀", callback_data: `mdl:${picker.token}:p:${picker.page - 1}` });
    if (picker.page < pages - 1) nav.push({ text: "▶", callback_data: `mdl:${picker.token}:p:${picker.page + 1}` });
    if (nav.length > 0) rows.push(nav);
    rows.push([{ text: "Отмена", callback_data: `mdl:${picker.token}:x` }]);
    const current = currentId === undefined ? "—" : currentId;
    return {
      html: `<b>Модель:</b> <code>${escapeFor("HTML", current)}</code>\n<b>Страница:</b> ${picker.page + 1}/${pages}`,
      keyboard: { inline_keyboard: rows },
    };
  }

  async #handleModelCallback(target: Target, data: string): Promise<string | undefined> {
    const parts = data.split(":");
    const token = parts[1];
    if (!token) return "Устарело";
    const picker = this.#modelPickers.get(token);
    if (!picker || picker.expiresAt < Date.now()) {
      this.#modelPickers.delete(token);
      return "Устарело";
    }
    if (picker.target.chatId !== target.chatId || picker.target.messageThreadId !== target.messageThreadId) {
      return "Устарело";
    }
    const handle = this.#handles.get(picker.key);
    if (!handle || handle.phase === "closed") return "Сессия закрыта";
    const action = parts[2];
    if (action === "x") {
      this.#modelPickers.delete(token);
      await this.#deps.sender.delete(picker.target, picker.messageId);
      return "Отменено";
    }
    if (action === "p") {
      picker.page = Number(parts[3] ?? "0") || 0;
      const state = await handle.client.getState().catch(() => null);
      const view = this.#modelPickerView(picker, state?.model?.id);
      await this.#deps.sender.editText(picker.target, picker.messageId, view.html, { replyMarkup: view.keyboard });
      return undefined;
    }
    if (action === "s") {
      const index = Number(parts[3]);
      const model = picker.models[index];
      if (!model) return "Устарело";
      try {
        await handle.client.setModel(model.provider, model.id);
      } catch (error) {
        return `⚠️ ${errorText(error)}`;
      }
      this.#modelPickers.delete(token);
      await this.#deps.sender.editText(
        picker.target,
        picker.messageId,
        `✅ Модель: <code>${escapeFor("HTML", `${model.provider}/${model.id}`)}</code>`,
        { replyMarkup: { inline_keyboard: [] } },
      );
      return "✅";
    }
    return undefined;
  }

  async #recentSessions(key: string): Promise<Array<{ path: string; mtime: number; size: number }>> {
    const dir = sessionDir(this.#deps.config.OMP_SESSION_ROOT, key);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const sessions: Array<{ path: string; mtime: number; size: number }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const path = join(dir, entry.name);
        const info = await stat(path);
        sessions.push({ path, mtime: info.mtimeMs, size: info.size });
      }
      sessions.sort((a, b) => b.mtime - a.mtime);
      return sessions.slice(0, 10);
    } catch {
      return [];
    }
  }

  async sweepIdle(): Promise<void> {
    const now = this.#now();
    for (const handle of [...this.#handles.values()]) {
      if (handle.phase !== "ready" || handle.run !== null) continue;
      if (now - handle.lastUsed < this.#deps.config.IDLE_TIMEOUT_MS) continue;
      this.#handles.delete(handle.key);
      handle.phase = "closed";
      await handle.client.close().catch(() => undefined);
      this.#deps.log.info("session_idle_closed", { key: handle.key });
    }
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
    const handles = [...this.#handles.values()];
    this.#handles.clear();
    for (const handle of handles) {
      handle.phase = "closed";
      await handle.ui.cancelAll("shutdown").catch(() => undefined);
    }
    await Promise.race([
      Promise.allSettled(handles.map((handle) => handle.client.close())),
      Bun.sleep(20_000),
    ]);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
