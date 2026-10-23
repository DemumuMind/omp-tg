#!/usr/bin/env bun
/** Minimal OMP RPC peer used by protocol tests; not a test file itself. */
const decoder = new TextDecoder();
let buffer = "";
let counter = 0;

function send(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id: string | undefined, command: string, data?: unknown): void {
  send({ type: "response", id, command, success: true, ...(data === undefined ? {} : { data }) });
}

function handle(command: Record<string, unknown>): void {
  const id = typeof command.id === "string" ? command.id : undefined;
  switch (command.type) {
    case "negotiate_protocol":
      respond(id, "negotiate_protocol", { protocolVersion: 2 });
      return;
    case "set_event_filter":
      respond(id, "set_event_filter");
      return;
    case "set_ask_dialog":
      respond(id, "set_ask_dialog", { enabled: true });
      return;
    case "open_session":
      respond(id, "open_session", { cancelled: false, resumed: false, sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
      return;
    case "get_state":
      respond(id, "get_state", { sessionId: "s1", isStreaming: false, messageCount: 4, sessionFile: "/tmp/s1.jsonl" });
      return;
    case "get_available_commands":
      respond(id, "get_available_commands", { commands: [] });
      return;
    case "bash": {
      const text = String(command.command ?? "");
      if (text === "slow") return;
      if (text === "fail") {
        send({ type: "response", id, command: "bash", success: false, error: "boom", code: "E_FAIL" });
        return;
      }
      respond(id, "bash", { output: "ok", exitCode: 0, cancelled: false, truncated: false });
      return;
    }
    case "abort_bash":
      respond(id, "abort_bash");
      return;
    case "prompt": {
      respond(id, "prompt", { agentInvoked: true });
      const promptId = id ?? `auto${++counter}`;
      setTimeout(() => {
        send({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
        send({ type: "prompt_result", id: promptId, agentInvoked: true, status: "completed", sessionSettled: true });
      }, 10);
      return;
    }
    case "follow_up":
      respond(id, "follow_up");
      return;
    case "abort":
      respond(id, "abort");
      return;
    case "new_session":
      respond(id, "new_session", { cancelled: false });
      return;
    default:
      respond(id, String(command.type), {});
  }
}

send({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1024 * 1024,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
});

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
}

export {};
