import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigestController } from "../telegram/digest.ts";
import type { Target } from "../telegram/sender.ts";
import type { SessionManager } from "../omp/session-manager.ts";

const target: Target = { chatId: -100123 };

function makeSessions() {
  const notices: string[] = [];
  const prompts: string[] = [];
  return {
    notices,
    prompts,
    fake: {
      sendNotice: async (_t: unknown, html: string) => {
        notices.push(html);
      },
      handleText: async (_t: unknown, text: string) => {
        prompts.push(text);
      },
    } as unknown as SessionManager,
  };
}

let stateDir: string;

afterEach(async () => {
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  stateDir = "";
});

function makeController(sessions: SessionManager) {
  stateDir = mkdtempSyncSafe();
  const controller = new DigestController({ statePath: join(stateDir, "digests.json"), sessions, log: fakeLog });
  return controller;
}

function mkdtempSyncSafe(): string {
  // mkdtemp is async; run it synchronously via Bun's sync fs API.
  return `${tmpdir()}/digest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const fakeLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as const;

describe("DigestController", () => {
  test("rejects malformed time and empty prompt", async () => {
    const sessions = makeSessions();
    const digest = makeController(sessions.fake);
    await digest.set(target, "25:99 нет времени");
    expect(sessions.notices[0]).toContain("Использование");
    await digest.set(target, "08:30");
    expect(sessions.notices[1]).toContain("Использование");
    await digest.stop();
  });

  test("stores, describes and removes a digest, persisting state", async () => {
    const sessions = makeSessions();
    const digest = makeController(sessions.fake);
    const stateDirLocal = stateDir;
    await digest.set(target, "08:30 сделай сводку задач");
    expect(sessions.notices[0]).toContain("08:30");
    const raw = await readFile(join(stateDirLocal, "digests.json"), "utf8");
    expect(raw).toContain("сделай сводку задач");

    await digest.describe(target);
    expect(sessions.notices[1]).toContain("сводку задач");

    await digest.remove(target);
    expect(sessions.notices[2]).toContain("отключён");

    // State reloads: fresh controller sees the removed entry as absent.
    const reloaded = new DigestController({
      statePath: join(stateDirLocal, "digests.json"),
      sessions: sessions.fake,
      log: fakeLog,
    });
    await reloaded.describe(target);
    expect(sessions.notices[3]).toContain("не настроен");
    await reloaded.stop();
    await digest.stop();
  });

  test("fires the prompt through handleText once per day", async () => {
    const sessions = makeSessions();
    const digest = makeController(sessions.fake);
    // Schedule for a time that has already passed today: 00:00 is always <= now.
    await digest.set(target, "00:00 дайджест");

    await digest.check();
    expect(sessions.prompts).toEqual(["дайджест"]);

    // Second pass the same day: no duplicate.
    await digest.check();
    expect(sessions.prompts).toHaveLength(1);

    const state = JSON.parse(await readFile(join(stateDir, "digests.json"), "utf8")) as Record<
      string,
      { time: string; prompt: string; lastDay: string }
    >;
    const today = state["-100123:0"]!.lastDay;
    expect(today).not.toBe("");

    // A new day fires again.
    state["-100123:0"]!.lastDay = "2000-01-01";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(stateDir, "digests.json"), JSON.stringify(state));
    const reloaded = new DigestController({
      statePath: join(stateDir, "digests.json"),
      sessions: sessions.fake,
      log: fakeLog,
    });
    await reloaded.check();
    expect(sessions.prompts).toHaveLength(2);
    await reloaded.stop();
    await digest.stop();
  });
});
