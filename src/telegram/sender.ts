import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Api, InputFile, InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup, ReactionType } from "grammy/types";
import { CALLBACK_DATA_MAX, CAPTION, MSG, RICH } from "../config/constants.ts";
import type { ImageContent } from "../omp/protocol.ts";
import { renderStreamingHtml } from "../utils/render.ts";
import { splitVisible, truncateVisible } from "../utils/split.ts";
import { visibleLength } from "../utils/visible.ts";
import type { Logger } from "../utils/logger.ts";

export interface Target {
  chatId: number;
  messageThreadId?: number;
  /** Set for group/forum messages: every member gets a private OMP session. */
  userId?: number;
}

export type TgApi = Pick<
  Api,
  | "sendMessage"
  | "sendRichMessage"
  | "editMessageText"
  | "deleteMessage"
  | "sendPhoto"
  | "sendDocument"
  | "sendChatAction"
  | "editMessageReplyMarkup"
  | "answerCallbackQuery"
  | "getFile"
  | "sendVideo"
  | "sendAudio"
  | "sendVoice"
  | "sendAnimation"
  | "setMessageReaction"
>;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".svg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const VOICE_EXTENSIONS = new Set([".ogg", ".opus"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".flac", ".aac"]);
const ATTACHMENT_LIMIT = 50 * 1024 * 1024;

export type ReactionEmoji = Extract<ReactionType, { type: "emoji" }>["emoji"];

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

export type AskQuestionView = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  recommended?: number;
};

function thread(target: Target): { message_thread_id?: number } {
  return target.messageThreadId === undefined ? {} : { message_thread_id: target.messageThreadId };
}

function callbackData(data: string): string {
  if (Buffer.byteLength(data, "utf8") > CALLBACK_DATA_MAX) {
    throw new InvariantError(`callback_data exceeds ${CALLBACK_DATA_MAX} bytes: ${data}`);
  }
  return data;
}

export class Sender {
  readonly #api: TgApi;
  readonly #log: Logger;

  constructor(api: TgApi, log: Logger) {
    this.#api = api;
    this.#log = log;
  }

  async sendText(
    target: Target,
    html: string,
    opts: { replyMarkup?: InlineKeyboardMarkup; silent?: boolean } = {},
  ): Promise<number[]> {
    let chunks = splitVisible(html, MSG, "HTML");
    if (chunks.length > 1) {
      const parts = chunks.length;
      const prefix = `(${parts}/${parts}) `;
      chunks = splitVisible(html, MSG - prefix.length, "HTML");
      if (String(chunks.length).length !== String(parts).length) {
        const adjusted = `(${chunks.length}/${chunks.length}) `;
        chunks = splitVisible(html, MSG - adjusted.length, "HTML");
      }
    }
    const ids: number[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const label = chunks.length > 1 ? `(${index + 1}/${chunks.length}) ` : "";
      const message = await this.#api.sendMessage(target.chatId, label + chunk, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...thread(target),
        ...(opts.silent ? { disable_notification: true } : {}),
        ...(opts.replyMarkup && index === chunks.length - 1 ? { reply_markup: opts.replyMarkup } : {}),
      });
      ids.push(message.message_id);
    }
    return ids;
  }

  async sendRich(target: Target, markdown: string): Promise<{ ok: boolean; messageId?: number }> {
    if (visibleLength(markdown, "MarkdownV2") > RICH) return { ok: false };
    try {
      const message = await this.#api.sendRichMessage(target.chatId, { markdown }, thread(target));
      return { ok: true, messageId: message.message_id };
    } catch (error) {
      this.#log.warn("send_rich_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }

  async sendMedia(
    target: Target,
    bytes: Uint8Array,
    meta: { fileName: string; mimeType: string; asPhoto: boolean },
    captionHtml?: string,
  ): Promise<boolean> {
    let caption = captionHtml ?? "";
    if (caption !== "" && visibleLength(caption, "HTML") > CAPTION) {
      caption = truncateVisible(caption, CAPTION, "HTML");
    }
    const file = new InputFile(bytes, meta.fileName);
    const extra = {
      ...thread(target),
      ...(caption === "" ? {} : { caption, parse_mode: "HTML" as const }),
    };
    if (meta.asPhoto) {
      try {
        await this.#api.sendPhoto(target.chatId, file, extra);
        return true;
      } catch (error) {
        this.#log.warn("send_photo_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this.#api.sendDocument(target.chatId, new InputFile(bytes, meta.fileName), extra);
      return true;
    } catch (error) {
      this.#log.warn("send_document_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      await this.sendText(target, "⚠️ Не удалось отправить вложение");
      return false;
    }
  }

  async sendAttachment(target: Target, path: string, captionHtml?: string): Promise<boolean> {
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      this.#log.warn("attachment_stat_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (size > ATTACHMENT_LIMIT) {
      await this.sendText(target, "⚠️ Файл больше 50 MB");
      return false;
    }

    const extension = extname(path).toLowerCase();
    let caption = captionHtml ?? "";
    if (caption !== "" && visibleLength(caption, "HTML") > CAPTION) caption = truncateVisible(caption, CAPTION, "HTML");
    const extra = {
      ...thread(target),
      ...(caption === "" ? {} : { caption, parse_mode: "HTML" as const }),
    };

    const attempt = async (): Promise<boolean> => {
      if (IMAGE_EXTENSIONS.has(extension)) {
        if (extension === ".gif") await this.#api.sendAnimation(target.chatId, new InputFile(path), extra);
        else await this.#api.sendPhoto(target.chatId, new InputFile(path), extra);
        return true;
      }
      if (VIDEO_EXTENSIONS.has(extension)) {
        await this.#api.sendVideo(target.chatId, new InputFile(path), extra);
        return true;
      }
      if (VOICE_EXTENSIONS.has(extension)) {
        await this.#api.sendVoice(target.chatId, new InputFile(path), extra);
        return true;
      }
      if (AUDIO_EXTENSIONS.has(extension)) {
        await this.#api.sendAudio(target.chatId, new InputFile(path), extra);
        return true;
      }
      await this.#api.sendDocument(target.chatId, new InputFile(path), extra);
      return true;
    };

    try {
      return await attempt();
    } catch (error) {
      this.#log.warn("send_attachment_failed", {
        file: basename(path),
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.#api.sendDocument(target.chatId, new InputFile(path), extra);
        return true;
      } catch {
        return false;
      }
    }
  }

  async sendVoice(target: Target, bytes: Uint8Array): Promise<boolean> {
    try {
      await this.#api.sendVoice(target.chatId, new InputFile(bytes, "reply.ogg"), thread(target));
      return true;
    } catch (error) {
      this.#log.warn("send_voice_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async react(target: Target, messageId: number, emoji: ReactionEmoji): Promise<void> {
    try {
      await this.#api.setMessageReaction(target.chatId, messageId, [{ type: "emoji", emoji }]);
    } catch (error) {
      this.#log.debug("reaction_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async deliverFinal(target: Target, markdown: string, images: ImageContent[], files: string[] = []): Promise<void> {
    const html = markdown === "" ? "" : renderStreamingHtml(markdown);
    const shortCaption = html !== "" && visibleLength(html, "HTML") <= CAPTION;
    const total = files.length + images.length;
    const caption = total === 1 && shortCaption ? html : undefined;
    let captioned = false;

    for (let index = 0; index < files.length; index += 1) {
      const delivered = await this.sendAttachment(target, files[index]!, caption);
      if (index === 0 && caption !== undefined && delivered) captioned = true;
    }

    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]!;
      const bytes = Buffer.from(image.data, "base64");
      const extension = image.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
      const delivered = await this.sendMedia(
        target,
        bytes,
        {
          fileName: `image-${index + 1}.${extension}`,
          mimeType: image.mimeType,
          asPhoto: image.mimeType.startsWith("image/") && bytes.length <= 10 * 1024 * 1024,
        },
        files.length === 0 && index === 0 ? caption : undefined,
      );
      if (files.length === 0 && index === 0 && caption !== undefined && delivered) captioned = true;
    }

    if (html === "" || captioned) return;
    const rich = await this.sendRich(target, markdown);
    if (!rich.ok) await this.sendText(target, html);
  }

  async editText(
    target: Target,
    messageId: number,
    html: string,
    opts: { replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<boolean> {
    try {
      await this.#api.editMessageText(target.chatId, messageId, html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      });
      return true;
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      if (description.includes("message is not modified")) return false;
      throw error;
    }
  }

  async editReplyMarkup(target: Target, messageId: number, kb: InlineKeyboardMarkup): Promise<void> {
    try {
      await this.#api.editMessageReplyMarkup(target.chatId, messageId, { reply_markup: kb });
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      if (!description.includes("message is not modified")) {
        this.#log.warn("edit_markup_failed", { message: description });
      }
    }
  }

  async delete(target: Target, messageId: number): Promise<void> {
    try {
      await this.#api.deleteMessage(target.chatId, messageId);
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      if (!description.includes("message to delete not found")) {
        this.#log.warn("delete_message_failed", { message: description });
      }
    }
  }

  async typing(target: Target): Promise<void> {
    try {
      await this.#api.sendChatAction(target.chatId, "typing", thread(target));
    } catch (error) {
      this.#log.debug("typing_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  askKeyboard(token: string, questionIndex: number, question: AskQuestionView, selected: Set<number>): InlineKeyboardMarkup {
    const kb = new InlineKeyboard();
    question.options.forEach((option, optionIndex) => {
      const mark = selected.has(optionIndex) ? "✓ " : "";
      const recommended = question.recommended === optionIndex ? " (Recommended)" : "";
      kb.text(`${mark}${option.label}${recommended}`, callbackData(`ui:${token}:${questionIndex}:${optionIndex}`)).row();
    });
    kb.text("✍️ Свой ответ", callbackData(`ui:${token}:${questionIndex}:text`));
    if (question.multi) kb.text("✅ Готово", callbackData(`ui:${token}:${questionIndex}:done`));
    return { inline_keyboard: kb.inline_keyboard };
  }

  selectKeyboard(token: string, options: string[]): InlineKeyboardMarkup {
    const kb = new InlineKeyboard();
    options.forEach((option, index) => {
      kb.text(option, callbackData(`ui:${token}:s:${index}`)).row();
    });
    return { inline_keyboard: kb.inline_keyboard };
  }

  stopKeyboard(): InlineKeyboardMarkup {
    return { inline_keyboard: [[{ text: "⏹ Остановить", callback_data: callbackData("act:stop") }]] };
  }

  confirmKeyboard(token: string): InlineKeyboardMarkup {
    const kb = new InlineKeyboard()
      .text("Да", callbackData(`ui:${token}:y`))
      .text("Нет", callbackData(`ui:${token}:n`));
    return { inline_keyboard: kb.inline_keyboard };
  }
}
