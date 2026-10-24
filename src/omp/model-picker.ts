import { randomBytes } from "node:crypto";
import type { InlineKeyboardMarkup } from "grammy/types";
import { escapeFor } from "../utils/escape.ts";
import type { Target, Sender } from "../telegram/sender.ts";
import type { ModelInfo, SessionState } from "./protocol.ts";

/** Narrow client surface the picker needs — structurally satisfied by SessionClient. */
export interface PickerClient {
  getAvailableModels(): Promise<ModelInfo[]>;
  getState(): Promise<SessionState>;
  setModel(provider: string, modelId: string): Promise<ModelInfo>;
}

const MODEL_PAGE_SIZE = 8;

export interface PickerHandle {
  target: Target;
  key: string;
  phase: string;
  client: PickerClient;
}

interface Picker {
  token: string;
  key: string;
  target: Target;
  models: ModelInfo[];
  page: number;
  messageId: number;
  expiresAt: number;
}

export interface ModelPickerDeps {
  sender: Sender;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the paginated /model picker flow: query matching, inline keyboard, callbacks. */
export class ModelPickerHub {
  readonly #deps: ModelPickerDeps;
  readonly #pickers = new Map<string, Picker>();

  constructor(deps: ModelPickerDeps) {
    this.#deps = deps;
  }

  async show(handle: PickerHandle, query: string): Promise<void> {
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
      const picker: Picker = {
        token,
        key: handle.key,
        target: handle.target,
        models,
        page: 0,
        messageId: 0,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      const view = this.#view(picker, state.model?.id);
      const ids = await this.#deps.sender.sendText(handle.target, view.html, { replyMarkup: view.keyboard });
      picker.messageId = ids[0] ?? 0;
      this.#pickers.set(token, picker);
      while (this.#pickers.size > 64) {
        const oldest = this.#pickers.keys().next().value;
        if (oldest === undefined) break;
        this.#pickers.delete(oldest);
      }
    } catch (error) {
      await this.#deps.sender.sendText(handle.target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
    }
  }

  async handleCallback(
    target: Target,
    data: string,
    resolveHandle: (key: string) => PickerHandle | undefined,
  ): Promise<string | undefined> {
    const parts = data.split(":");
    const token = parts[1];
    if (!token) return "Устарело";
    const picker = this.#pickers.get(token);
    if (!picker || picker.expiresAt < Date.now()) {
      this.#pickers.delete(token);
      return "Устарело";
    }
    if (picker.target.chatId !== target.chatId || picker.target.messageThreadId !== target.messageThreadId) {
      return "Устарело";
    }
    const handle = resolveHandle(picker.key);
    if (!handle || handle.phase === "closed") return "Сессия закрыта";
    const action = parts[2];
    if (action === "x") {
      this.#pickers.delete(token);
      await this.#deps.sender.delete(picker.target, picker.messageId);
      return "Отменено";
    }
    if (action === "p") {
      picker.page = Number(parts[3] ?? "0") || 0;
      const state = await handle.client.getState().catch(() => null);
      const view = this.#view(picker, state?.model?.id);
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
      this.#pickers.delete(token);
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

  async #applyModel(handle: PickerHandle, model: ModelInfo): Promise<void> {
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

  #view(picker: Picker, currentId: string | undefined): { html: string; keyboard: InlineKeyboardMarkup } {
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
}
