import type { InlineKeyboardMarkup } from "grammy/types";
import { MSG } from "../config/constants.ts";
import type { ImageContent } from "../omp/protocol.ts";
import { renderStreamingHtml } from "../utils/render.ts";
import { truncateVisible } from "../utils/split.ts";
import type { Logger } from "../utils/logger.ts";
import type { Sender, Target } from "./sender.ts";

export class StreamRenderer {
  readonly #sender: Sender;
  readonly #target: Target;
  readonly #throttleMs: number;
  readonly #log: Logger;
  readonly #draftMarkup: InlineKeyboardMarkup | undefined;
  readonly #silent: boolean;
  #text = "";
  #messageId: number | null = null;
  #keepProgress: boolean;
  #lastEdit = 0;
  #dirty = false;
  #pumping = false;
  #finished = false;
  #pump: Promise<void> | null = null;

  constructor(
    sender: Sender,
    target: Target,
    throttleMs: number,
    log: Logger,
    draftMarkup?: InlineKeyboardMarkup,
    silent = true,
    keepProgress = true,
  ) {
    this.#sender = sender;
    this.#target = target;
    this.#throttleMs = throttleMs;
    this.#log = log;
    this.#draftMarkup = draftMarkup;
    this.#silent = silent;
    this.#keepProgress = keepProgress;
  }

  update(text: string): void {
    if (this.#finished) return;
    this.#text = text;
    this.#dirty = true;
    this.#pump ??= this.#runPump();
  }

  async #runPump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#dirty && !this.#finished) {
        this.#dirty = false;
        const wait = this.#lastEdit + this.#throttleMs - Date.now();
        if (this.#messageId !== null && wait > 0) await Bun.sleep(wait);
        if (this.#finished) break;
        const text = this.#text;
        if (text === "") continue;
        const html = truncateVisible(renderStreamingHtml(text), MSG, "HTML");
        try {
          if (this.#messageId === null) {
            const ids = await this.#sender.sendText(this.#target, html, {
              replyMarkup: this.#draftMarkup,
              silent: this.#silent,
            });
            this.#messageId = ids[0] ?? null;
          } else {
            await this.#sender.editText(this.#target, this.#messageId, html);
          }
          this.#lastEdit = Date.now();
        } catch (error) {
          const description = error instanceof Error ? error.message : String(error);
          if (description.includes("message to be edited not found")) {
            this.#messageId = null;
          } else {
            this.#log.warn("stream_update_failed", { message: description });
          }
        }
      }
    } finally {
      this.#pumping = false;
      this.#pump = null;
      if (this.#dirty && !this.#finished) this.#pump = this.#runPump();
    }
  }

  async #idle(): Promise<void> {
    while (this.#pumping) await Bun.sleep(10);
  }

  async finalize(markdown: string, images: ImageContent[], files: string[] = []): Promise<void> {
    this.#finished = true;
    await this.#idle();
    if (markdown === "" && images.length === 0 && files.length === 0) {
      // Nothing new to add: the progress message already holds the log.
      if (!this.#keepProgress) await this.discard();
      else this.#messageId = null;
      return;
    }
    // Everything in one message: progress log + final answer, joined and edited in place.
    const combined = this.#text.trim() === "" ? markdown : `${this.#text}\n\n---\n\n${markdown}`;
    let edited = false;
    if (this.#messageId !== null && combined.trim() !== "") {
      const html = truncateVisible(renderStreamingHtml(combined), MSG, "HTML");
      try {
        await this.#sender.editText(this.#target, this.#messageId, html);
        edited = true;
      } catch {
        // Message gone (deleted by user): fall back to a fresh send.
      }
    }
    this.#messageId = null;
    if (!edited && combined.trim() !== "") {
      await this.#sender.deliverFinal(this.#target, combined, images, files);
      return;
    }
    if (images.length > 0 || files.length > 0) {
      await this.#sender.deliverFinal(this.#target, "", images, files);
    }
  }

  async discard(): Promise<void> {
    this.#finished = true;
    await this.#idle();
    if (this.#messageId !== null) {
      await this.#sender.delete(this.#target, this.#messageId);
      this.#messageId = null;
    }
  }
}
