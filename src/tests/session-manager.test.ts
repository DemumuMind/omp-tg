import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/env.ts";
import { loadConfig } from "../config/env.ts";
import type { SessionClient, SessionHooks } from "../omp/session-manager.ts";
import { SessionManager } from "../omp/session-manager.ts";
import type { PromptResult, UiResponsePayload } from "../omp/protocol.ts";
import { clearUiRegistry } from "../omp/ui-controller.ts";
import { Sender } from "../telegram/sender.ts";
import { sessionDir, sessionKey } from "../telegram/session-key.ts";
import { createLogger } from "../utils/logger.ts";
import { FakeTgApi } from "./helpers/fake-telegram.ts";

const log = createLogger("error", () => undefined);
const target = { chatId: 77, messageThreadId: 5 };

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    TELEGRAM_BOT_TOKEN: "token",
    ALLOWED_USER_IDS: "1",
    MAX_ACTIVE_SESSIONS: "2",
    IDLE_TIMEOUT_MS: "60000",
    OMP_SESSION_ROOT: "/tmp/omp-tg-tests",
    OMP_WORKDIR: "/tmp/omp-tg-tests-work",
    ...overrides,
  });
}

class FakeClient implements SessionClient {
  readonly hooks: SessionHooks;
  failStart = false;
  closed = 0;
  aborts = 0;
  bashAborts = 0;
  readonly modelsSet: string[] = [];
  readonly titles: string[] = [];
  readonly switches: string[] = [];
  readonly prompts: string[] = [];
  readonly responses: Array<{ id: string; payload: UiResponsePayload }> = [];
  alive = true;
  #run: { id: string; resolve: (result: PromptResult) => void } | null = null;

  constructor(hooks: SessionHooks) {
    this.hooks = hooks;
  }

  async start(): Promise<{ protocolVersion: number; sessionFile?: string; resumed: boolean }> {
    if (this.failStart) throw new Error("spawn failed");
    return { protocolVersion: 2, resumed: false };
  }

  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    return "p1";
  }

  waitForPrompt(id: string): Promise<PromptResult> {
    const { promise, resolve } = Promise.withResolvers<PromptResult>();
    this.#run = { id, resolve };
    return promise;
  }

  settleEpoch = 0;

  async waitForSettle(): Promise<void> {}

  async abort(): Promise<void> {
    this.aborts += 1;
  }

  async newSession(): Promise<void> {}

  async getState(): Promise<{ sessionId: string; isStreaming: boolean; messageCount: number }> {
    return { sessionId: "s1", isStreaming: false, messageCount: 3 };
  }

  async getAvailableCommands(): Promise<{ commands: Array<{ name: string; description?: string }> }> {
    return { commands: [{ name: "compact", description: "Compact context" }] };
  }

  async getAvailableModels(): Promise<Array<{ id: string; provider: string; name?: string }>> {
    return [
      { id: "model-a", provider: "prov" },
      { id: "model-b", provider: "prov" },
    ];
  }

  async setModel(provider: string, modelId: string): Promise<{ id: string; provider: string }> {
    this.modelsSet.push(`${provider}/${modelId}`);
    return { id: modelId, provider };
  }

  async exportHtml(path: string): Promise<string> {
    await writeFile(path, "<html>export</html>");
    return path;
  }

  async setSessionName(name: string): Promise<void> {
    this.titles.push(name);
  }

  async switchSession(sessionPath: string): Promise<boolean> {
    this.switches.push(sessionPath);
    return false;
  }

  async getSessionStats(): Promise<{
    sessionId: string;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    totalMessages: number;
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
  }> {
    return {
      sessionId: "s1",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      totalMessages: 2,
      tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
      cost: 0.01,
    };
  }

  async bash(): Promise<{ output: string; cancelled: boolean; truncated: boolean }> {
    return { output: "", cancelled: false, truncated: false };
  }

  async abortBash(): Promise<void> {
    this.bashAborts += 1;
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.alive = false;
  }

  respond(id: string, payload: UiResponsePayload): void {
    this.responses.push({ id, payload });
  }

  emitDelta(delta: string): void {
    this.hooks.onEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  }

  finish(status: PromptResult["status"] = "completed"): void {
    this.#run?.resolve({ type: "prompt_result", id: this.#run.id, agentInvoked: true, status, sessionSettled: true });
  }
}

function makeManager(options: { cfg?: Config; now?: () => number } = {}) {
  const api = new FakeTgApi();
  const sender = new Sender(api.asApi(), log);
  const clients: FakeClient[] = [];
  const manager = new SessionManager({
    config: options.cfg ?? config(),
    sender,
    log,
    now: options.now,
    createClient: (_dir, _key, hooks) => {
      const client = new FakeClient(hooks);
      clients.push(client);
      return client;
    },
  });
  return { api, sender, clients, manager };
}

function lastText(api: FakeTgApi): string {
  const sends = api.callsOf("sendMessage");
  return String(sends[sends.length - 1]?.args[1] ?? "");
}

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

async function waitForPrompt(client: FakeClient): Promise<void> {
  await flushMicrotasks(50);
  if (client.prompts.length === 0) throw new Error("prompt was never sent");
}

/** Completes the currently running prompt and waits until the manager finalized it. */
async function finishRun(api: FakeTgApi, client: FakeClient, text = "done"): Promise<void> {
  await waitForPrompt(client);
  client.emitDelta(text);
  await flushMicrotasks(5);
  client.finish();
  await api.waitForCall("editMessageText");
  await flushMicrotasks();
}

describe("SessionManager", () => {
  beforeEach(() => clearUiRegistry());

  test("keeps a separate session per group member", async () => {
    const { api, clients, manager } = makeManager();
    const alice = { chatId: -100, messageThreadId: 7, userId: 1 };
    const bob = { chatId: -100, messageThreadId: 7, userId: 2 };

    await manager.handleText(alice, "hello from alice");
    await finishRun(api, clients[0]!);
    await manager.handleText(bob, "hello from bob");

    expect(clients).toHaveLength(2);
    expect(manager.size).toBe(2);

    await finishRun(api, clients[1]!);
    await manager.handleText(alice, "alice again");
    expect(clients).toHaveLength(2);

    await manager.shutdown();
  });

  test("evicts the oldest idle session when the cap is reached", async () => {
    const { api, clients, manager } = makeManager({ cfg: config({ MAX_ACTIVE_SESSIONS: "1" }) });

    await manager.handleText(target, "first");
    expect(clients).toHaveLength(1);
    await finishRun(api, clients[0]!);

    await manager.handleText({ chatId: 78, messageThreadId: 5 }, "second");
    expect(clients).toHaveLength(2);
    expect(clients[0]!.closed).toBe(1);
    expect(manager.size).toBe(1);
    await manager.shutdown();
  });

  test("reports busy when every session has an active run", async () => {
    const { api, clients, manager } = makeManager({ cfg: config({ MAX_ACTIVE_SESSIONS: "1" }) });

    await manager.handleText(target, "first");
    expect(clients).toHaveLength(1);
    await waitForPrompt(clients[0]!);
    await manager.handleText({ chatId: 78, messageThreadId: 5 }, "second");

    expect(lastText(api)).toContain("Все сессии заняты");
    expect(clients).toHaveLength(1);
    await manager.shutdown();
  });

  test("refuses new prompts while a run is active", async () => {
    const { api, clients, manager } = makeManager();

    await manager.handleText(target, "first");
    expect(clients).toHaveLength(1);
    await waitForPrompt(clients[0]!);
    await manager.handleText(target, "second");

    expect(lastText(api)).toContain("Агент ещё работает");
    await manager.shutdown();
  });

  test("aborts the run from the act:stop callback", async () => {
    const { api, clients, manager } = makeManager();

    await manager.handleText(target, "long task");
    await waitForPrompt(clients[0]!);
    clients[0]!.emitDelta("working");
    await api.waitForCall("sendMessage");
    expect(await manager.handleCallback(target, "act:stop")).toBe("⛔ Останавливаю");
    expect(clients[0]!.aborts).toBe(1);
    expect(clients[0]!.bashAborts).toBe(1);

    clients[0]!.finish("aborted");
    await api.waitForCall("editMessageText");
    await manager.shutdown();
  });

  test("delivers MEDIA files and strips their tags from text", async () => {
    const { api, clients, manager } = makeManager();
    await mkdir("/tmp/omp-tg-tests-work", { recursive: true });
    const file = "/tmp/omp-tg-tests-work/report.txt";
    await writeFile(file, "hello");

    await manager.handleText(target, `done\nMEDIA:${file}`);
    await waitForPrompt(clients[0]!);
    clients[0]!.emitDelta(`done\nMEDIA:${file}`);
    await flushMicrotasks(5);
    clients[0]!.finish();

    const attachment = await api.waitForCall("sendDocument");
    expect(String((attachment.args[2] as { caption?: string } | undefined)?.caption ?? "")).not.toContain("MEDIA:");
    expect(api.callsOf("sendRichMessage")).toHaveLength(0);
    const drafts = api.callsOf("sendMessage");
    expect(String(drafts[0]?.args[1] ?? "")).not.toContain("MEDIA:");
    await manager.shutdown();
  });

  test("reacts to the incoming message when the run finishes", async () => {
    const { api, clients, manager } = makeManager();
    await manager.handleText(target, "hello", [], { messageId: 123 });
    await waitForPrompt(clients[0]!);
    clients[0]!.emitDelta("hi");
    clients[0]!.finish();
    const reaction = await api.waitForCall("setMessageReaction");
    expect(reaction.args[2]).toEqual([{ type: "emoji", emoji: "👍" }]);
    await manager.shutdown();
  });

  test("switches models from the inline picker", async () => {
    const { api, clients, manager } = makeManager();
    await manager.handleCommand(target, { kind: "model", query: "" });
    const keyboard = api.lastKeyboard()!;
    expect(keyboard.inline_keyboard.length).toBe(3);
    const first = keyboard.inline_keyboard[0]![0];
    if (!first || !("callback_data" in first) || !first.callback_data) throw new Error("missing callback");
    expect(await manager.handleCallback(target, first.callback_data)).toBe("✅");
    expect(clients[0]!.modelsSet).toEqual(["prov/model-a"]);
    await manager.shutdown();
  });

  test("reports usage for the active session", async () => {
    const { api, clients, manager } = makeManager();
    await manager.handleText(target, "hello");
    await waitForPrompt(clients[0]!);
    await manager.handleCommand(target, { kind: "usage" });
    expect(lastText(api)).toContain("Токены");
    await manager.shutdown();
  });

  test("exports, titles, lists and resumes sessions", async () => {
    const { api, clients, manager } = makeManager();
    await manager.handleText(target, "hello");
    await waitForPrompt(clients[0]!);
    await finishRun(api, clients[0]!);

    const dir = sessionDir("/tmp/omp-tg-tests", sessionKey(target.chatId, target.messageThreadId));
    await mkdir(dir, { recursive: true });
    const first = join(dir, "2026-01-01_a.jsonl");
    const second = join(dir, "2026-01-02_b.jsonl");
    await writeFile(first, "{}\n");
    await writeFile(second, "{}\n");
    await utimes(first, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await utimes(second, new Date(), new Date());

    await manager.handleCommand(target, { kind: "export" });
    expect(api.callsOf("sendDocument").length).toBeGreaterThan(0);
    expect(lastText(api)).toContain("Экспорт готов");

    await manager.handleCommand(target, { kind: "title", name: "My session" });
    expect(clients[0]!.titles).toEqual(["My session"]);

    await manager.handleCommand(target, { kind: "sessions" });
    const sessionsMessage = api.callsOf("sendMessage").at(-1);
    expect(String(sessionsMessage?.args[1])).toContain("Сессии");
    const markup = sessionsMessage?.args[2] as { reply_markup?: { inline_keyboard: unknown[][] } };
    expect(JSON.stringify(markup.reply_markup?.inline_keyboard)).toContain("2026-01-02_b.jsonl".slice(0, 14));

    await manager.handleCommand(target, { kind: "resume", target: "1" });
    expect(clients[0]!.switches[0]?.endsWith("2026-01-02_b.jsonl")).toBe(true);

    await manager.shutdown();
  });

  test("sends a voice reply for transcribed voice prompts", async () => {
    const tts = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/speak") return new Response("no", { status: 404 });
        await request.text();
        return new Response(new Uint8Array([79, 103, 103, 83]), { headers: { "content-type": "audio/ogg" } });
      },
    });
    const { api, clients, manager } = makeManager({
      cfg: config({ TTS_ENABLED: "true", TTS_URL: `http://127.0.0.1:${tts.port}` }),
    });

    await manager.handleText(target, "voice prompt", [], { voiceReply: true });
    await finishRun(api, clients[0]!);
    await api.waitForCall("sendVoice");

    expect(api.callsOf("sendVoice")).toHaveLength(1);
    tts.stop(true);
    await manager.shutdown();
  });

  test("sweeps idle sessions but leaves busy ones alone", async () => {
    let now = 1_000;
    const { api, clients, manager } = makeManager({ cfg: config({ IDLE_TIMEOUT_MS: "1000" }), now: () => now });

    await manager.handleText(target, "hello");
    expect(clients).toHaveLength(1);
    await waitForPrompt(clients[0]!);
    now += 5_000;
    await manager.sweepIdle();
    expect(clients[0]!.closed).toBe(0);
    expect(manager.size).toBe(1);

    await finishRun(api, clients[0]!);
    now += 5_000;
    await manager.sweepIdle();
    expect(clients[0]!.closed).toBe(1);
    expect(manager.size).toBe(0);
    await manager.shutdown();
  });

  test("recreates the client after a failed start", async () => {
    const api = new FakeTgApi();
    const sender = new Sender(api.asApi(), log);
    let fail = true;
    const client = new FakeClient({ onEvent: () => undefined, onUiRequest: () => undefined, onExit: () => undefined });
    client.failStart = fail;
    const manager = new SessionManager({
      config: config(),
      sender,
      log,
      createClient: () => {
        const next = client;
        next.failStart = fail;
        return next;
      },
    });

    await manager.handleText(target, "hello");
    expect(lastText(api)).toContain("OMP недоступен");
    expect(manager.size).toBe(0);

    fail = false;
    client.failStart = false;
    await manager.handleText(target, "hello again");
    expect(manager.size).toBe(1);
    await manager.shutdown();
  });
});
