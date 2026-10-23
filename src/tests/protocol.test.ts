import { afterEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { OmpClient, OmpResponseError } from "../omp/client.ts";
import { extractImages, extractToolActivity } from "../omp/protocol.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("error", () => undefined);
const bin = join(import.meta.dir, "helpers", "fake-omp.ts");
const clients: OmpClient[] = [];

async function makeClient(events: unknown[] = [], timeoutMs = 2000): Promise<OmpClient> {
  await chmod(bin, 0o755);
  const client = new OmpClient({
    bin,
    cwd: import.meta.dir,
    sessionDir: "/tmp/omp-tg-protocol-test",
    spawnMode: "direct",
    startTimeoutMs: 5000,
    requestTimeoutMs: timeoutMs,
    onEvent: (frame) => events.push(frame),
    onUiRequest: () => undefined,
    onExit: () => undefined,
    log,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("OmpClient", () => {
  test("negotiates v2 and opens the session", async () => {
    const client = await makeClient();
    const started = await client.start();
    expect(started.protocolVersion).toBe(2);
    expect(started.resumed).toBe(false);
    expect(started.sessionFile).toBe("/tmp/s1.jsonl");
    expect(client.alive).toBe(true);
  });

  test("correlates responses by id", async () => {
    const client = await makeClient();
    await client.start();
    const state = await client.getState();
    expect(state.sessionId).toBe("s1");
    expect(state.messageCount).toBe(4);
  });

  test("rejects failed commands", async () => {
    const client = await makeClient();
    await client.start();
    await expect(client.bash("fail")).rejects.toBeInstanceOf(OmpResponseError);
  });

  test("times out an unanswered command", async () => {
    const client = await makeClient([], 50);
    await client.start();
    await expect(client.bash("slow")).rejects.toThrow(/timed out/);
  });

  test("streams deltas and resolves the prompt result", async () => {
    const events: unknown[] = [];
    const client = await makeClient(events);
    await client.start();
    const id = await client.prompt("hello");
    const result = await client.waitForPrompt(id);
    expect(result.status).toBe("completed");
    expect(events.some((event) => JSON.stringify(event).includes("text_delta"))).toBe(true);
  });

  test("close is idempotent", async () => {
    const client = await makeClient();
    await client.start();
    await client.close();
    await client.close();
    expect(client.alive).toBe(false);
  });
});

describe("extractImages", () => {
  const image = { type: "image", data: Buffer.from("x").toString("base64"), mimeType: "image/png" };

  test("collects images from assistant messages", () => {
    const frame = { type: "message_end", message: { role: "assistant", content: [image] } };
    expect(extractImages(frame)).toHaveLength(1);
  });

  test("ignores user messages so inbound media is not echoed", () => {
    const frame = { type: "message_end", message: { role: "user", content: [image] } };
    expect(extractImages(frame)).toHaveLength(0);
  });

  test("ignores frames without a role", () => {
    const frame = { type: "message_update", message: { content: [image] } };
    expect(extractImages(frame)).toHaveLength(0);
  });
});

describe("extractToolActivity", () => {
  test("summarizes a start event from tool args", () => {
    const activity = extractToolActivity({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "bun test" },
    });
    expect(activity).toEqual({ phase: "start", toolCallId: "t1", toolName: "bash", summary: "bun test" });
  });

  test("prefers the intent and reports failures on completion", () => {
    const start = extractToolActivity({
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "read",
      args: {},
      intent: "Read config",
    });
    expect(start?.summary).toBe("Read config");
    expect(
      extractToolActivity({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", isError: true }),
    ).toEqual({ phase: "end", toolCallId: "t2", toolName: "read", isError: true });
  });

  test("ignores unrelated frames", () => {
    expect(extractToolActivity({ type: "message_update" })).toBeNull();
  });
});
