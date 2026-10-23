import { randomBytes } from "node:crypto";
import { MSG } from "../config/constants.ts";
import type { AskQuestion, UiRequest, UiResponsePayload } from "./protocol.ts";
import { escapeFor } from "../utils/escape.ts";
import type { Logger } from "../utils/logger.ts";
import { splitVisible } from "../utils/split.ts";
import type { Sender, Target } from "../telegram/sender.ts";

export interface UiClient {
  respond(id: string, payload: UiResponsePayload): void;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 256;

interface BaseState {
  token: string;
  requestId: string;
  target: Target;
  messageIds: number[];
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface AskState extends BaseState {
  kind: "ask";
  questions: AskQuestion[];
  index: number;
  answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
  selected: Set<number>;
  awaitingText: boolean;
}

interface SelectState extends BaseState {
  kind: "select";
  options: string[];
}

interface ConfirmState extends BaseState {
  kind: "confirm";
}

interface TextState extends BaseState {
  kind: "input" | "editor";
  awaitingText: boolean;
}

type UiState = AskState | SelectState | ConfirmState | TextState;

const REGISTRY = new Map<string, UiState>();

export function clearUiRegistry(): void {
  for (const state of REGISTRY.values()) clearTimeout(state.timer);
  REGISTRY.clear();
}

function register(state: UiState): void {
  REGISTRY.set(state.token, state);
  while (REGISTRY.size > MAX_ENTRIES) {
    const oldest = REGISTRY.keys().next().value;
    if (oldest === undefined) break;
    const evicted = REGISTRY.get(oldest);
    clearTimeout(evicted?.timer);
    REGISTRY.delete(oldest);
  }
}

function targetMatches(state: UiState, target: Target): boolean {
  return state.target.chatId === target.chatId && state.target.messageThreadId === target.messageThreadId;
}

export class UiController {
  readonly #client: UiClient;
  readonly #sender: Sender;
  readonly #target: Target;
  readonly #log: Logger;
  readonly #active = new Map<string, UiState>();

  constructor(client: UiClient, sender: Sender, target: Target, log: Logger) {
    this.#client = client;
    this.#sender = sender;
    this.#target = target;
    this.#log = log;
  }

  get expectsText(): boolean {
    for (const state of this.#active.values()) {
      if ((state.kind === "ask" || state.kind === "input" || state.kind === "editor") && state.awaitingText) return true;
    }
    return false;
  }

  async handle(req: UiRequest): Promise<void> {
    switch (req.method) {
      case "ask":
        await this.#handleAsk(req);
        return;
      case "select":
        await this.#handleSelect(req);
        return;
      case "confirm":
        await this.#handleConfirm(req);
        return;
      case "input":
      case "editor":
        await this.#handleTextRequest(req);
        return;
      case "notify":
        await this.#sender.sendText(this.#target, escapeFor("HTML", req.message));
        return;
      case "open_url":
        await this.#handleOpenUrl(req);
        return;
      case "cancel":
        await this.#cancelRequest(req.targetId);
        return;
      case "setStatus":
      case "setWidget":
      case "setTitle":
      case "set_editor_text":
        this.#log.debug("ui_method_ignored", { method: req.method });
        return;
      default:
        this.#log.debug("ui_method_unknown", {});
    }
  }

  #newState(): { token: string; expiresAt: number; timer: ReturnType<typeof setTimeout> | undefined } {
    return {
      token: randomBytes(6).toString("base64url").slice(0, 8),
      expiresAt: Date.now() + TTL_MS,
      timer: undefined,
    };
  }

  #track(state: UiState, timeout: number | undefined): void {
    this.#active.set(state.requestId, state);
    register(state);
    state.timer = setTimeout(() => {
      void this.#expire(state);
    }, timeout ?? TTL_MS);
    state.timer.unref?.();
  }

  #forget(state: UiState): void {
    clearTimeout(state.timer);
    this.#active.delete(state.requestId);
    REGISTRY.delete(state.token);
  }

  #respond(state: UiState, payload: UiResponsePayload): void {
    this.#client.respond(state.requestId, payload);
    this.#forget(state);
  }

  #expire(state: UiState): void {
    if (!this.#active.has(state.requestId)) return;
    this.#client.respond(state.requestId, { cancelled: true, timedOut: true });
    this.#forget(state);
    const messageId = state.messageIds[state.messageIds.length - 1];
    if (messageId !== undefined) {
      void this.#sender.sendText(this.#target, "⌛ Время вышло");
    }
  }

  async #handleAsk(req: Extract<UiRequest, { method: "ask" }>): Promise<void> {
    const base = this.#newState();
    const state: AskState = {
      kind: "ask",
      requestId: req.id,
      target: this.#target,
      messageIds: [],
      ...base,
      questions: req.questions,
      index: 0,
      answers: [],
      selected: new Set(),
      awaitingText: false,
    };
    this.#track(state, req.timeout);
    if (req.questions.length === 0) {
      this.#respond(state, { answers: [] });
      return;
    }
    await this.#sendQuestion(state);
  }

  async #sendQuestion(state: AskState): Promise<void> {
    const question = state.questions[state.index];
    if (!question) return;
    const header = question.header ? `<b>${escapeFor("HTML", question.header)}</b>\n` : "";
    const body = `${header}${escapeFor("HTML", question.question)}`;
    const ids = await this.#sender.sendText(this.#target, body, {
      replyMarkup: this.#sender.askKeyboard(state.token, state.index, question, state.selected),
    });
    state.messageIds.push(...ids);
    state.awaitingText = false;
  }

  #answerCurrent(state: AskState, customInput?: string): void {
    const question = state.questions[state.index];
    if (!question) return;
    const selectedOptions = [...state.selected]
      .sort((a, b) => a - b)
      .map((index) => question.options[index]?.label)
      .filter((label): label is string => label !== undefined);
    const answer: { id: string; selectedOptions: string[]; customInput?: string } = {
      id: question.id,
      selectedOptions,
    };
    if (customInput !== undefined && customInput !== "") answer.customInput = customInput;
    state.answers.push(answer);
    state.selected = new Set();
    state.awaitingText = false;
    state.index += 1;
  }

  #finishAsk(state: AskState): void {
    this.#respond(state, { answers: state.answers });
  }

  async #advanceAsk(state: AskState): Promise<void> {
    if (state.index >= state.questions.length) {
      this.#finishAsk(state);
      return;
    }
    const previous = state.messageIds[state.messageIds.length - 1];
    await this.#sendQuestion(state);
    if (previous !== undefined) {
      await this.#sender.editReplyMarkup(this.#target, previous, { inline_keyboard: [] });
    }
  }

  async #handleAskCallback(state: AskState, parts: string[], target: Target): Promise<string | undefined> {
    if (!targetMatches(state, target)) return "Устарело";
    const questionIndex = Number(parts[0]);
    const action = parts[1];
    if (questionIndex !== state.index) return "Сначала ответьте на текущий вопрос";
    const question = state.questions[state.index];
    if (!question) return "Устарело";

    if (action === "text") {
      state.awaitingText = true;
      return "Напишите ответ сообщением";
    }

    if (action === "done") {
      if (!question.multi) return undefined;
      this.#answerCurrent(state);
      await this.#advanceAsk(state);
      return "✅";
    }

    const optionIndex = Number(action);
    const option = question.options[optionIndex];
    if (!option) return "Устарело";

    if (question.multi) {
      if (state.selected.has(optionIndex)) state.selected.delete(optionIndex);
      else state.selected.add(optionIndex);
      const messageId = state.messageIds[state.messageIds.length - 1];
      if (messageId !== undefined) {
        await this.#sender.editReplyMarkup(this.#target, messageId, this.#sender.askKeyboard(state.token, state.index, question, state.selected));
      }
      return undefined;
    }

    state.selected = new Set([optionIndex]);
    this.#answerCurrent(state);
    await this.#advanceAsk(state);
    return "✅";
  }

  async #handleSelect(req: Extract<UiRequest, { method: "select" }>): Promise<void> {
    const state: SelectState = {
      kind: "select",
      requestId: req.id,
      target: this.#target,
      messageIds: [],
      ...this.#newState(),
      options: req.options,
    };
    this.#track(state, req.timeout);
    const ids = await this.#sender.sendText(this.#target, escapeFor("HTML", req.title), {
      replyMarkup: this.#sender.selectKeyboard(state.token, req.options),
    });
    state.messageIds.push(...ids);
  }

  async #handleConfirm(req: Extract<UiRequest, { method: "confirm" }>): Promise<void> {
    const state: ConfirmState = {
      kind: "confirm",
      requestId: req.id,
      target: this.#target,
      messageIds: [],
      ...this.#newState(),
    };
    this.#track(state, req.timeout);
    const html = `<b>${escapeFor("HTML", req.title)}</b>\n${escapeFor("HTML", req.message)}`;
    const ids = await this.#sender.sendText(this.#target, html, {
      replyMarkup: this.#sender.confirmKeyboard(state.token),
    });
    state.messageIds.push(...ids);
  }

  async #handleTextRequest(req: Extract<UiRequest, { method: "input" | "editor" }>): Promise<void> {
    const state: TextState = {
      kind: req.method,
      requestId: req.id,
      target: this.#target,
      messageIds: [],
      ...this.#newState(),
      awaitingText: true,
    };
    this.#track(state, req.method === "input" ? req.timeout : undefined);
    let html = `<b>${escapeFor("HTML", req.title)}</b>`;
    if (req.method === "input" && req.placeholder) html += `\n<i>${escapeFor("HTML", req.placeholder)}</i>`;
    if (req.method === "editor" && req.prefill) {
      html += `\n<pre>${escapeFor("HTML", splitVisible(req.prefill, MSG - 64, "HTML")[0] ?? "")}</pre>`;
    }
    const ids = await this.#sender.sendText(this.#target, html);
    state.messageIds.push(...ids);
  }

  async #handleOpenUrl(req: Extract<UiRequest, { method: "open_url" }>): Promise<void> {
    const candidate = req.launchUrl ?? req.url;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      await this.#sender.sendText(this.#target, "⚠️ Некорректная ссылка");
      return;
    }
    if (!["http:", "https:", "tg:"].includes(parsed.protocol)) {
      await this.#sender.sendText(this.#target, "⚠️ Некорректная ссылка");
      return;
    }
    const instructions = req.instructions ? `${escapeFor("HTML", req.instructions)}\n` : "";
    const href = parsed.href.replace(/"/g, "%22");
    await this.#sender.sendText(
      this.#target,
      `${instructions}<a href="${escapeFor("HTML", href)}">${escapeFor("HTML", href)}</a>`,
    );
  }

  async #cancelRequest(requestId: string): Promise<void> {
    const state = this.#active.get(requestId);
    if (!state) return;
    this.#client.respond(requestId, { cancelled: true });
    this.#forget(state);
  }

  async handleCallback(data: string, target: Target = this.#target): Promise<string | undefined> {
    if (!data.startsWith("ui:")) return undefined;
    const parts = data.split(":");
    const token = parts[1];
    if (!token) return "Устарело";
    const state = REGISTRY.get(token);
    if (!state) return "Устарело";
    if (Date.now() > state.expiresAt) {
      await this.#expire(state);
      return "Устарело";
    }
    if (!targetMatches(state, target)) return "Устарело";
    if (state.kind === "ask") return this.#handleAskCallback(state, parts.slice(2), target);
    if (state.kind === "select") {
      const index = Number(parts[3]);
      const option = state.options[index];
      if (option === undefined) return "Устарело";
      this.#respond(state, { value: option });
      return "✅";
    }
    if (state.kind === "confirm") {
      const action = parts[2];
      if (action !== "y" && action !== "n") return "Устарело";
      this.#respond(state, { confirmed: action === "y" });
      return "✅";
    }
    return "Устарело";
  }

  async handleText(text: string): Promise<boolean> {
    for (const state of [...this.#active.values()]) {
      if (state.kind === "input" || state.kind === "editor") {
        if (!state.awaitingText) continue;
        this.#respond(state, { value: text });
        return true;
      }
      if (state.kind === "ask" && state.awaitingText) {
        this.#answerCurrent(state, text);
        await this.#advanceAsk(state);
        return true;
      }
    }
    return false;
  }

  async cancelAll(_reason: "shutdown" | "abort"): Promise<void> {
    for (const state of [...this.#active.values()]) {
      this.#client.respond(state.requestId, { cancelled: true });
      this.#forget(state);
      const messageId = state.messageIds[state.messageIds.length - 1];
      if (messageId !== undefined) {
        void this.#sender.editReplyMarkup(this.#target, messageId, { inline_keyboard: [] });
      }
    }
  }
}
