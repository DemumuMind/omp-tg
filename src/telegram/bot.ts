import { mkdir, stat } from "node:fs/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import type { Context } from "grammy";
import {
  BASH_OUTPUT_LIMIT,
  BASH_TIMEOUT_MS,
  FILE_MAX_BYTES,
  UPLOAD_MAX_BYTES,
} from "../config/constants.ts";
import type { Config } from "../config/env.ts";
import { OmpClient } from "../omp/client.ts";
import { fetchFileAttachment, fetchPhoto, MediaDownloadError, MediaTooLargeError } from "../omp/media.ts";
import type { ImageContent } from "../omp/protocol.ts";
import { BashTimeoutError, BusyError, SessionManager, type SessionManagerCommand } from "../omp/session-manager.ts";
import { createLogger, type Logger } from "../utils/logger.ts";
import { escapeFor } from "../utils/escape.ts";
import { KeyedQueue } from "../utils/keyed-queue.ts";
import { authMiddleware, isAllowedUser } from "./auth.ts";
import {
  extractAtPaths,
  isDangerousBash,
  parseBangCommand,
  parseGatewayCommand,
  type GatewayCommand,
} from "./commands.ts";
import { Sender, type Target } from "./sender.ts";
import { resolveSandboxPath } from "./sandbox.ts";
import { transcribeAudio } from "../stt/client.ts";
import { startHealthServer } from "../health/server.ts";
import { createWatchdog } from "../utils/watchdog.ts";
import { startRetention } from "../utils/retention.ts";

export interface App {
  start(): Promise<void>;
  shutdown(reason: string, code?: number): Promise<void>;
  bot: Bot;
  sessions: SessionManager;
}

export interface ShutdownSteps {
  stopBot: () => Promise<void>;
  stopSessions: () => Promise<void>;
  stopHealth?: () => void;
  stopWatchdog?: () => void;
  stopRetention?: () => void;
  log: Logger;
  exit: (code: number) => void;
}

/** Idempotent shutdown: bot first, then every OMP child, then the process. */
export function makeShutdown(steps: ShutdownSteps): (reason: string, code?: number) => Promise<void> {
  let shutdown: Promise<void> | null = null;
  return (reason, code = 0) => {
    shutdown ??= (async () => {
      await steps.stopBot().catch((error: unknown) => {
        steps.log.warn("shutdown_stop_bot_failed", { message: errorText(error) });
      });
      await steps.stopSessions().catch((error: unknown) => {
        steps.log.warn("shutdown_stop_sessions_failed", { message: errorText(error) });
      });
      steps.stopHealth?.();
      steps.stopRetention?.();
      steps.stopWatchdog?.();
      steps.log.info("shutdown", { reason });
      steps.exit(code);
    })();
    return shutdown;
  };
}

export function installSignalHandlers(app: Pick<App, "shutdown">): void {
  process.on("SIGTERM", () => {
    void app.shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void app.shutdown("SIGINT");
  });
}

const GATEWAY_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "help", description: "Справка" },
  { name: "new", description: "Новая сессия" },
  { name: "stop", description: "Остановить задачу" },
  { name: "status", description: "Состояние сессии" },
  { name: "model", description: "Выбрать модель" },
  { name: "usage", description: "Токены и стоимость" },
  { name: "commands", description: "Команды OMP" },
  { name: "whoami", description: "Мои ID и доступ" },
  { name: "export", description: "Экспорт сессии в HTML" },
  { name: "sessions", description: "Список сессий" },
  { name: "title", description: "Название сессии" },
  { name: "resume", description: "Восстановить сессию" },
  { name: "file", description: "Отправить файл" },
  { name: "cancel", description: "Закрыть диалог" },
];

interface Runtime {
  config: Config;
  bot: Bot;
  sender: Sender;
  sessions: SessionManager;
  log: Logger;
  groupAllowed: Set<number>;
  mentionPatterns: RegExp[];
  queue: KeyedQueue;
}

interface HealthStateInternal {
  startedAt: number;
  sessions: number;
  updates: number;
  lastUpdateAt: number | null;
}

export function createApp(config: Config): App {
  const log = createLogger(config.LOG_LEVEL);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry());
  const sender = new Sender(bot.api, log);
  const sessions = new SessionManager({
    config,
    sender,
    log,
    createClient: (dir, key, hooks) =>
      new OmpClient({
        bin: config.OMP_BIN,
        cwd: config.OMP_WORKDIR,
        sessionDir: dir,
        spawnMode: config.OMP_SPAWN_MODE,
        scopeLimits: {
          memoryMax: config.OMP_MEMORY_MAX,
          memorySwapMax: config.OMP_MEMORY_SWAP_MAX,
          tasksMax: config.OMP_TASKS_MAX,
          cpuQuota: config.OMP_CPU_QUOTA,
        },
        startTimeoutMs: config.OMP_START_TIMEOUT_MS,
        requestTimeoutMs: config.OMP_REQUEST_TIMEOUT_MS,
        onEvent: hooks.onEvent,
        onUiRequest: hooks.onUiRequest,
        onExit: hooks.onExit,
        log,
      }),
  });

  const healthState: HealthStateInternal = {
    startedAt: Date.now(),
    sessions: 0,
    updates: 0,
    lastUpdateAt: null,
  };
  const health = startHealthServer(
    config.HEALTH_HOST,
    config.HEALTH_PORT,
    () => ({
      startedAt: healthState.startedAt,
      sessions: sessions.size,
      updates: healthState.updates,
      lastUpdateAt: healthState.lastUpdateAt,
    }),
    log,
  );
  const watchdog = createWatchdog(log);
  const retention = startRetention(config, sessions, log);

  const runtime: Runtime = {
    config,
    bot,
    sender,
    sessions,
    log,
    groupAllowed: parseChatIds(config.TELEGRAM_GROUP_ALLOWED_CHATS),
    mentionPatterns: compilePatterns(config.TELEGRAM_MENTION_PATTERNS, log),
    queue: new KeyedQueue(),
  };

  const shutdown = makeShutdown({
    stopBot: () => bot.stop(),
    stopSessions: () => sessions.shutdown(),
    stopHealth: () => health?.stop(),
    stopRetention: () => retention(),
    stopWatchdog: () => watchdog.stop(),
    log,
    exit: (code) => process.exit(code),
  });

  bot.use(async (_ctx, next) => {
    healthState.updates += 1;
    healthState.lastUpdateAt = Date.now();
    await next();
  });
  bot.use(createDedupeMiddleware(log));
  bot.use(authMiddleware(new Set(config.ALLOWED_USER_IDS), log));

  const enqueue = (ctx: Context, task: () => Promise<void>): void => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    void runtime.queue.push(String(chatId), async () => {
      try {
        await task();
      } catch (error) {
        log.error("update_failed", { message: errorText(error) });
        await ctx.reply(`⚠️ ${escapeFor("HTML", errorText(error))}`).catch(() => undefined);
      }
    });
  };

  bot.on("message:text", (ctx) => {
    enqueue(ctx, () => routeText(runtime, ctx, ctx.message.text, []));
  });

  bot.on("message:photo", (ctx) => {
    enqueue(ctx, async () => {
      const target = targetOf(ctx);
      try {
        const image = await fetchPhoto(bot.api, config.TELEGRAM_BOT_TOKEN, ctx.message.photo, UPLOAD_MAX_BYTES);
        await routeText(runtime, ctx, ctx.message.caption ?? "", [image]);
      } catch (error) {
        await sender.sendText(target, mediaError(error));
      }
    });
  });

  bot.on("message:document", (ctx) => {
    enqueue(ctx, () =>
      handleIncomingFile(runtime, ctx, ctx.message.document, "file.bin", "document"),
    );
  });

  bot.on("message:voice", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.voice, "voice.ogg", "voice message"));
  });

  bot.on("message:audio", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.audio, "audio.mp3", "audio file"));
  });

  bot.on("message:video", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.video, "video.mp4", "video file"));
  });

  bot.on("message:video_note", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.video_note, "video-note.mp4", "video note"));
  });

  bot.on("message:animation", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.animation, "animation.mp4", "animation"));
  });

  bot.on("inline_query", async (ctx) => {
    const allowed = isAllowedUser(ctx.from.id, new Set(config.ALLOWED_USER_IDS));
    if (!allowed) {
      await ctx.answerInlineQuery([], { cache_time: 0 }).catch(() => undefined);
      return;
    }
    const query = ctx.inlineQuery.query.trim();
    const [head, ...rest] = query.split(/\s+/);
    const needle = (head ?? "").toLowerCase();
    const omp = sessions.cachedCommands().map((command) => ({
      name: command.name,
      description: command.description ?? "Команда OMP",
    }));
    const merged = new Map<string, { name: string; description: string }>();
    for (const command of [...GATEWAY_COMMANDS, ...omp]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    const catalog = [...merged.values()];
    const filtered = catalog
      .filter(
        (command) =>
          needle === "" ||
          command.name.toLowerCase().includes(needle) ||
          command.description.toLowerCase().includes(needle),
      )
      .slice(0, 50);
    const argument = rest.join(" ");
    // In groups Telegram delivers a bare /command only to admins or with privacy mode off.
    // The bot suffix guarantees delivery and also satisfies the gateway's mention gate.
    const mention =
      ctx.inlineQuery.chat_type !== undefined && ctx.inlineQuery.chat_type !== "private"
        ? `@${runtime.bot.botInfo.username}`
        : "";
    const results = filtered.map((command, index) => ({
      type: "article" as const,
      id: `cmd:${index}:${command.name}`,
      title: `/${command.name}`,
      description: command.description.length > 120 ? `${command.description.slice(0, 119)}…` : command.description,
      input_message_content: {
        message_text: `/${command.name}${mention}${argument === "" ? "" : ` ${argument}`}`,
      },
    }));
    runtime.log.debug("inline_query", {
      userId: ctx.from.id,
      chatType: ctx.inlineQuery.chat_type,
      query,
      results: results.length,
    });
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(() => undefined);
  });

  bot.on("callback_query:data", async (ctx) => {
    const target = targetOf(ctx);
    const answer = await sessions.handleCallback(target, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery(answer);
  });

  bot.catch((failure) => {
    log.error("bot_error", { message: errorText(failure.error) });
    void failure.ctx.reply("⚠️ Внутренняя ошибка").catch(() => undefined);
  });

  let started = false;
  return {
    bot,
    sessions,
    async start() {
      if (started) return;
      started = true;
      await mkdir(config.OMP_WORKDIR, { recursive: true });
      await bot.init();
      await registerCommandMenu(runtime);
      void bot
        .start({
          allowed_updates: ["message", "callback_query", "inline_query"],
          drop_pending_updates: config.TELEGRAM_DROP_PENDING_UPDATES,
        })
        .catch((error: unknown) => {
          log.error("polling_failed", { message: errorText(error) });
          void shutdown("polling_failed", 1);
        });
      watchdog.ready();
      log.info("started", { username: bot.botInfo.username });
    },
    shutdown,
  };
}

function createDedupeMiddleware(log: Logger) {
  const seen = new Set<number>();
  const order: number[] = [];
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const id = ctx.update.update_id;
    if (seen.has(id)) {
      log.debug("duplicate_update", { updateId: id });
      return;
    }
    seen.add(id);
    order.push(id);
    if (order.length > 4096) {
      const oldest = order.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
    await next();
  };
}

export function parseChatIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const value = Number(trimmed);
    if (Number.isSafeInteger(value)) ids.add(value);
  }
  return ids;
}

function compilePatterns(raw: string, log: Logger): RegExp[] {
  const patterns: RegExp[] = [];
  for (const part of raw.split(",")) {
    const source = part.trim();
    if (source === "") continue;
    try {
      patterns.push(new RegExp(source, "i"));
    } catch {
      log.warn("bad_mention_pattern", { pattern: source });
    }
  }
  return patterns;
}

async function registerCommandMenu(runtime: Runtime): Promise<void> {
  if (!runtime.config.TELEGRAM_COMMAND_MENU) return;
  const commands = GATEWAY_COMMANDS.map((command) => ({
    command: command.name,
    description: command.description,
  }));
  try {
    await runtime.bot.api.setMyCommands(commands, { scope: { type: "default" } });
  } catch (error) {
    runtime.log.warn("command_menu_failed", { message: errorText(error) });
  }
}

function targetOf(ctx: Context): Target {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error("update has no chat");
  const thread = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  const chatType = ctx.chat?.type ?? ctx.callbackQuery?.message?.chat.type;
  const userId = chatType !== "private" ? ctx.from?.id : undefined;
  return {
    chatId,
    ...(thread === undefined ? {} : { messageThreadId: thread }),
    ...(userId === undefined ? {} : { userId }),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gateGroup(runtime: Runtime, ctx: Context, raw: string): string | null {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return raw;

  if (runtime.groupAllowed.size > 0 && !runtime.groupAllowed.has(chat.id)) {
    runtime.log.debug("group_not_allowed", { chatId: chat.id });
    return null;
  }
  if (!runtime.config.TELEGRAM_REQUIRE_MENTION) return raw;

  const username = runtime.bot.botInfo.username.toLowerCase();
  const replied = ctx.message?.reply_to_message?.from?.id === runtime.bot.botInfo.id;
  const mentioned = raw.toLowerCase().includes(`@${username}`);
  const patterned = runtime.mentionPatterns.some((pattern) => pattern.test(raw));
  if (!replied && !mentioned && !patterned) {
    runtime.log.debug("group_ignored", { chatId: chat.id });
    return null;
  }
  return raw
    .replace(new RegExp(`@${escapeRegex(username)}`, "gi"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function replyPrefix(ctx: Context): string {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return "";
  const author = reply.from?.is_bot
    ? `bot @${reply.from.username ?? "bot"}`
    : `${reply.from?.first_name ?? "user"}${reply.from?.id === undefined ? "" : `|${reply.from.id}`}`;
  const body = (reply.text ?? reply.caption ?? "[media]").replace(/\s+/g, " ").trim();
  const clipped = body.length > 300 ? `${body.slice(0, 299)}…` : body;
  return `[reply to ${author}: "${clipped}"]\n`;
}

function senderLabel(ctx: Context): string {
  const name = ctx.from?.first_name ?? ctx.from?.username ?? "user";
  return `[${name}|${ctx.from?.id ?? "?"}] `;
}

async function routeText(
  runtime: Runtime,
  ctx: Context,
  raw: string,
  images: ImageContent[],
): Promise<void> {
  const target = targetOf(ctx);
  const gated = gateGroup(runtime, ctx, raw);
  if (gated === null) return;
  const text = gated.trim();

  const command = parseGatewayCommand(text);
  if (command) {
    await runCommand(runtime, ctx, target, command);
    return;
  }

  const bang = parseBangCommand(text);
  if (bang !== null) {
    await handleBash(runtime, ctx, target, bang);
    return;
  }

  const isGroup = ctx.chat?.type !== "private";
  for (const path of extractAtPaths(text)) {
    const resolved = await resolveSandboxPath(runtime.config, path);
    if (resolved === null) {
      await runtime.sender.sendText(target, "⛔ @path вне рабочего каталога");
      return;
    }
  }

  if (text === "" && images.length === 0) return;

  const prompt = `${replyPrefix(ctx)}${isGroup ? senderLabel(ctx) : ""}${text}`;
  if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
    void runtime.sender.react(target, ctx.message.message_id, "👀");
  }
  await runtime.sessions.handleText(target, prompt, images, {
    messageId: ctx.message?.message_id,
  });
}

async function handleIncomingFile(
  runtime: Runtime,
  ctx: Context,
  file: { file_id: string; file_name?: string; file_size?: number },
  fallbackName: string,
  label: string,
): Promise<void> {
  const target = targetOf(ctx);
  const caption = ctx.message?.caption ?? "";
  const gated = gateGroup(runtime, ctx, caption);
  if (gated === null) return;
  try {
    const path = await fetchFileAttachment(
      runtime.bot.api,
      runtime.config.TELEGRAM_BOT_TOKEN,
      file,
      runtime.config.OMP_UPLOAD_DIR,
      UPLOAD_MAX_BYTES,
      fallbackName,
    );
    const isGroup = ctx.chat?.type !== "private";
    const body = gated.trim();
    if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
      void runtime.sender.react(target, ctx.message.message_id, "👀");
    }
    const attachment = await describeAttachment(runtime, path, label);
    const prompt = [
      replyPrefix(ctx).trimEnd(),
      `${isGroup ? senderLabel(ctx) : ""}${body}`,
      attachment.note,
    ]
      .filter((line) => line !== "")
      .join("\n");
    await runtime.sessions.handleText(target, prompt, [], {
      messageId: ctx.message?.message_id,
      voiceReply: attachment.transcribed,
    });
  } catch (error) {
    await runtime.sender.sendText(target, mediaError(error));
  }
}

async function describeAttachment(
  runtime: Runtime,
  path: string,
  label: string,
): Promise<{ note: string; transcribed: boolean }> {
  const canTranscribe = runtime.config.STT_ENABLED && (label === "voice message" || label === "audio file");
  if (canTranscribe) {
    try {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const text = await transcribeAudio({
        url: runtime.config.STT_URL,
        bytes,
        fileName: path.split("/").pop() ?? "audio.ogg",
        language: runtime.config.STT_LANGUAGE || undefined,
        timeoutMs: runtime.config.STT_TIMEOUT_MS,
      });
      if (text !== null) return { note: `[${label} transcript]: ${text}`, transcribed: true };
    } catch {
      // fall back to the raw path below
    }
  }
  return { note: `[${label}: ${path}]`, transcribed: false };
}

async function runCommand(runtime: Runtime, ctx: Context, target: Target, command: GatewayCommand): Promise<void> {
  switch (command.kind) {
    case "start":
    case "help":
      await runtime.sender.sendText(target, helpText(target, ctx.from?.id));
      return;
    case "id":
      await runtime.sender.sendText(
        target,
        [
          `chat_id: <code>${target.chatId}</code>`,
          `thread_id: <code>${target.messageThreadId ?? "—"}</code>`,
          `user_id: <code>${ctx.from?.id ?? "—"}</code>`,
        ].join("\n"),
      );
      return;
    case "whoami":
      await runtime.sender.sendText(
        target,
        [
          `<b>user:</b> <code>${ctx.from?.id ?? "—"}</code> (${escapeFor("HTML", ctx.from?.username ?? ctx.from?.first_name ?? "—")})`,
          `<b>chat:</b> <code>${target.chatId}</code> (${ctx.chat?.type ?? "—"})`,
          `<b>thread:</b> <code>${target.messageThreadId ?? "—"}</code>`,
          `<b>bot:</b> @${escapeFor("HTML", runtime.bot.botInfo.username)}`,
          `<b>доступ:</b> allowlist`,
        ].join("\n"),
      );
      return;
    case "commands":
      await sendCommandList(runtime, target);
      return;
    case "file":
      await handleFile(runtime, target, command.path);
      return;
    case "usage":
    case "model":
    case "export":
    case "sessions":
    case "title":
    case "resume":
    case "new":
    case "abort":
    case "status":
    case "cancel":
      await runtime.sessions.handleCommand(target, command as SessionManagerCommand);
      return;
  }
}

async function sendCommandList(runtime: Runtime, target: Target): Promise<void> {
  const lines = ["<b>Шлюз</b>"];
  for (const command of GATEWAY_COMMANDS) {
    lines.push(`/<code>${command.name}</code> — ${command.description}`);
  }

  const omp = await runtime.sessions.listCommands(target);
  lines.push("", "<b>OMP</b>");
  if (omp.length === 0) {
    lines.push("<i>Сессия не запущена — команды OMP появятся после первого сообщения.</i>");
  } else {
    for (const entry of omp.slice(0, 60)) {
      lines.push(`/<code>${escapeFor("HTML", entry.name)}</code>${entry.description ? ` — ${escapeFor("HTML", entry.description)}` : ""}`);
    }
  }
  await runtime.sender.sendText(target, lines.join("\n"));
}

async function handleBash(runtime: Runtime, ctx: Context, target: Target, command: string): Promise<void> {
  if (isDangerousBash(command)) {
    await runtime.sender.sendText(target, "⛔ Команда заблокирована");
    return;
  }
  if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
    void runtime.sender.react(target, ctx.message.message_id, "👀");
  }
  let ok = false;
  try {
    const result = await runtime.sessions.runBash(target, command, BASH_TIMEOUT_MS);
    ok = true;
    if (result.images && result.images.length > 0) {
      await runtime.sender.deliverFinal(target, "", result.images);
    }
    const status = result.timedOut ? "таймаут" : result.cancelled ? "отменено" : `exit ${result.exitCode ?? "?"}`;
    const output = truncateUtf8(result.output, BASH_OUTPUT_LIMIT);
    await runtime.sender.sendText(
      target,
      `<pre>${escapeFor("HTML", output === "" ? "(нет вывода)" : output)}</pre>\n<code>${status}</code>`,
    );
  } catch (error) {
    if (error instanceof BashTimeoutError) {
      await runtime.sender.sendText(target, "⌛ Таймаут 30 с");
    } else if (error instanceof BusyError) {
      await runtime.sender.sendText(target, "⏳ Все сессии заняты, попробуйте позже");
    } else {
      await runtime.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
    }
  } finally {
    if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
      void runtime.sender.react(target, ctx.message.message_id, ok ? "👍" : "👎");
    }
  }
}

async function handleFile(runtime: Runtime, target: Target, argument: string): Promise<void> {
  if (argument === "") {
    await runtime.sender.sendText(target, "Использование: <code>/file &lt;path&gt;</code>");
    return;
  }
  const actual = await resolveSandboxPath(runtime.config, argument);
  if (actual === null) {
    await runtime.sender.sendText(target, "⛔ Файл вне рабочего каталога");
    return;
  }
  try {
    const info = await stat(actual);
    if (!info.isFile()) {
      await runtime.sender.sendText(target, "⛔ Это не файл");
      return;
    }
    if (info.size > FILE_MAX_BYTES) {
      await runtime.sender.sendText(target, "⛔ Файл больше 50 MB");
      return;
    }
    await runtime.sender.sendAttachment(target, actual);
  } catch (error) {
    await runtime.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
  }
}

function truncateUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.subarray(0, limit)) + "\n…[обрезано]";
}

function mediaError(error: unknown): string {
  if (error instanceof MediaTooLargeError) return "⛔ Файл больше 20 MB";
  if (error instanceof MediaDownloadError) return `⚠️ ${escapeFor("HTML", error.message)}`;
  return `⚠️ ${escapeFor("HTML", errorText(error))}`;
}

function helpText(target: Target, userId: number | undefined): string {
  return [
    "<b>omp-tg</b> — Telegram-шлюз OMP.",
    "Обычное сообщение — запрос агенту; голос, аудио, видео и документы уходят как файл.",
    "<code>!cmd</code> — выполнить bash через OMP.",
    "<code>@path</code> — передать файл из рабочего каталога.",
    "<code>MEDIA:/path</code> в ответе агента — отправить вложение автоматически.",
    "<code>/new</code> — новая сессия, <code>/stop</code> — остановить, <code>/status</code> — состояние.",
    "<code>/model</code> — выбрать модель, <code>/usage</code> — токены и стоимость.",
    "<code>/commands</code> — команды OMP, <code>/whoami</code> — ID и доступ.",
    "<code>/file &lt;path&gt;</code> — отправить файл, <code>/cancel</code> — закрыть диалог.",
    `<code>/id</code> — chat_id, thread_id, user_id (${target.chatId}, ${target.messageThreadId ?? "main"}, ${userId ?? "—"}).`,
  ].join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
