import type { InlineKeyboardMarkup } from "grammy/types";
import type { TgApi } from "../../telegram/sender.ts";

export interface TgCall {
  method: string;
  args: unknown[];
}

export class FakeTgApi {
  readonly calls: TgCall[] = [];
  readonly failures = new Map<string, Error>();
  #nextId = 100;
  #waiters: Array<{ method: string; predicate: (call: TgCall) => boolean; resolve: (call: TgCall) => void }> = [];

  failNext(method: string, error = new Error(`${method} failed`)): void {
    this.failures.set(method, error);
  }

  waitForCall(method: string, predicate: (call: TgCall) => boolean = () => true): Promise<TgCall> {
    const existing = this.calls.find((call) => call.method === method && predicate(call));
    if (existing) return Promise.resolve(existing);
    const { promise, resolve } = Promise.withResolvers<TgCall>();
    this.#waiters.push({ method, predicate, resolve });
    return promise;
  }

  #record(method: string, args: unknown[]): void {
    const call: TgCall = { method, args };
    this.calls.push(call);
    this.#waiters = this.#waiters.filter((waiter) => {
      if (waiter.method !== method || !waiter.predicate(call)) return true;
      waiter.resolve(call);
      return false;
    });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  #message(): { message_id: number } {
    this.#nextId += 1;
    return { message_id: this.#nextId };
  }

  async sendMessage(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendMessage", args);
    return this.#message();
  }

  async sendRichMessage(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendRichMessage", args);
    return this.#message();
  }

  async editMessageText(...args: unknown[]): Promise<true> {
    this.#record("editMessageText", args);
    return true;
  }

  async deleteMessage(...args: unknown[]): Promise<true> {
    this.#record("deleteMessage", args);
    return true;
  }

  async sendPhoto(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendPhoto", args);
    return this.#message();
  }

  async sendDocument(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendDocument", args);
    return this.#message();
  }

  async sendVideo(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendVideo", args);
    return this.#message();
  }

  async sendAudio(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendAudio", args);
    return this.#message();
  }

  async sendVoice(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendVoice", args);
    return this.#message();
  }

  async sendAnimation(...args: unknown[]): Promise<{ message_id: number }> {
    this.#record("sendAnimation", args);
    return this.#message();
  }

  async setMessageReaction(...args: unknown[]): Promise<true> {
    this.#record("setMessageReaction", args);
    return true;
  }

  async sendChatAction(...args: unknown[]): Promise<true> {
    this.#record("sendChatAction", args);
    return true;
  }

  async editMessageReplyMarkup(...args: unknown[]): Promise<true> {
    this.#record("editMessageReplyMarkup", args);
    return true;
  }

  async answerCallbackQuery(...args: unknown[]): Promise<true> {
    this.#record("answerCallbackQuery", args);
    return true;
  }

  async getFile(...args: unknown[]): Promise<{ file_id: string; file_unique_id: string; file_path?: string }> {
    this.#record("getFile", args);
    return { file_id: "f", file_unique_id: "u", file_path: "photos/file.jpg" };
  }

  asApi(): TgApi {
    return this as unknown as TgApi;
  }

  callsOf(method: string): TgCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  lastKeyboard(): InlineKeyboardMarkup | undefined {
    const sends = this.callsOf("sendMessage");
    const last = sends[sends.length - 1];
    if (!last) return undefined;
    const other = last.args[2];
    if (!other || typeof other !== "object" || !("reply_markup" in other)) return undefined;
    return other.reply_markup as InlineKeyboardMarkup | undefined;
  }
}
