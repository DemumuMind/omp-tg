import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Target } from "./sender.ts";
import type { SessionManager } from "../omp/session-manager.ts";
import type { Logger } from "../utils/logger.ts";

interface DigestEntry {
  time: string; // "HH:MM" local
  prompt: string;
  lastDay: string; // YYYY-MM-DD of last fire
}

export interface DigestDeps {
  statePath: string;
  sessions: SessionManager;
  log: Logger;
}

const CHECK_INTERVAL_MS = 30_000;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Per-chat daily digests: `/digest 08:30 сделай сводку новостей` schedules a
 * prompt that fires through the normal session pipeline at the given local
 * time. State survives restarts via a JSON file.
 */
export class DigestController {
  readonly #deps: DigestDeps;
  readonly #entries = new Map<string, DigestEntry>();
  readonly #ready: Promise<void>;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: DigestDeps) {
    this.#deps = deps;
    this.#ready = this.#load();
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async set(target: Target, argument: string): Promise<void> {
    await this.#ready;
    const [rawTime, ...rest] = argument.trim().split(/\s+/);
    const prompt = rest.join(" ").trim();
    if (!TIME_RE.test(rawTime ?? "") || prompt === "") {
      await this.#deps.sessions.sendNotice(target, [
        "Использование: <code>/digest HH:MM &lt;промпт&gt;</code>",
        "Пример: <code>/digest 08:30 сводка открытых задач по репо</code>",
        "Отключить: <code>/digest off</code>",
      ].join("\\n"));
      return;
    }
    const key = `${target.chatId}:${target.messageThreadId ?? 0}`;
    this.#entries.set(key, { time: rawTime!, prompt, lastDay: "" });
    await this.#save();
    await this.#deps.sessions.sendNotice(target, `⏰ Ежедневно в <code>${rawTime}</code>: ${escape(prompt)}`);
  }

  async remove(target: Target): Promise<void> {
    await this.#ready;
    const key = `${target.chatId}:${target.messageThreadId ?? 0}`;
    if (!this.#entries.has(key)) {
      await this.#deps.sessions.sendNotice(target, "Дайджест не настроен");
      return;
    }
    this.#entries.delete(key);
    await this.#save();
    await this.#deps.sessions.sendNotice(target, "Дайджест отключён");
  }

  async describe(target: Target): Promise<void> {
    await this.#ready;
    const key = `${target.chatId}:${target.messageThreadId ?? 0}`;
    const entry = this.#entries.get(key);
    if (!entry) {
      await this.#deps.sessions.sendNotice(
        target,
        "Дайджест не настроен. <code>/digest HH:MM &lt;промпт&gt;</code>",
      );
      return;
    }
    await this.#deps.sessions.sendNotice(
      target,
      `⏰ Ежедневно в <code>${entry.time}</code>: ${escape(entry.prompt)}`,
    );
  }

  /** Runs one scheduler pass: fires due digests. Public for tests and manual runs. */
  async check(): Promise<void> {
    await this.#ready;
    if (this.#entries.size === 0) return;
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const [key, entry] of [...this.#entries]) {
      const [h, m] = entry.time.split(":").map(Number);
      if (minutes < h! * 60 + m! || entry.lastDay === day) continue;
      entry.lastDay = day;
      await this.#save();
      const [chatIdRaw, threadRaw] = key.split(":");
      const chatId = Number(chatIdRaw);
      const thread = Number(threadRaw);
      if (!Number.isSafeInteger(chatId)) continue;
      const target: Target = {
        chatId,
        ...(thread ? { messageThreadId: thread } : {}),
      };
      this.#deps.log.info("digest_fired", { key, time: entry.time });
      try {
        await this.#deps.sessions.handleText(target, entry.prompt);
      } catch (error) {
        this.#deps.log.error("digest_failed", {
          key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.#deps.statePath, "utf8")) as Record<string, DigestEntry>;
      for (const [key, entry] of Object.entries(raw)) this.#entries.set(key, entry);
    } catch {
      // First run: no state yet.
    }
  }

  async #save(): Promise<void> {
    const path = this.#deps.statePath;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(Object.fromEntries(this.#entries), null, 2)}\n`);
    } catch (error) {
      this.#deps.log.error("digest_state_write_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
