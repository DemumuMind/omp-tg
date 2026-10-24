import { RpcFrameDecoder, RpcProtocolError } from "./frames.ts";
import { OmpProcess } from "./process.ts";
import { OmpClosedError, OmpResponseError } from "./errors.ts";
import {
  AvailableModelsSchema,
  BashResultSchema,
  ExportResultSchema,
  ModelSchema,
  OpenSessionResultSchema,
  PromptResultSchema,
  ReadySchema,
  ResponseSchema,
  SessionStateSchema,
  SessionStatsSchema,
  SwitchSessionResultSchema,
  UiRequestSchema,
  type BashResult,
  type ImageContent,
  type ModelInfo,
  type OpenSessionResult,
  type PromptResult,
  type RpcCommand,
  type RpcCommandPayload,
  type RpcExtensionUIResponse,
  type SessionState,
  type SessionStats,
  type UiRequest,
  type UiResponsePayload,
} from "./protocol.ts";
import type { Logger } from "../utils/logger.ts";

const DEFAULT_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REASSEMBLED_BYTES = 64 * 1024 * 1024;

const KNOWN_EVENTS: Record<string, true> = {
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  agent_end: true,
  notice: true,
  auto_retry_start: true,
  auto_retry_end: true,
  session_settled: true,
  session_info_update: true,
  config_update: true,
  command_output: true,
  rpc_frame_error: true,
  extension_error: true,
  queue_update: true,
  goal_update: true,
  subagent_lifecycle: true,
  subagent_progress: true,
  subagent_event: true,
  available_commands_update: true,
};

export { OmpClosedError, OmpResponseError } from "./errors.ts";

export interface OmpClientOptions {
  bin: string;
  cwd: string;
  sessionDir: string;
  spawnMode: "direct" | "systemd-user-scope";
  scopeLimits?: { memoryMax: string; memorySwapMax: string; tasksMax: number; cpuQuota: string };
  startTimeoutMs: number;
  requestTimeoutMs: number;
  env?: Record<string, string>;
  onEvent: (frame: unknown) => void;
  onUiRequest: (req: UiRequest) => void;
  onExit: (info: { code: number | null; stderr: string }) => void;
  log: Logger;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface RunSlot {
  promise: Promise<PromptResult>;
  resolve: (result: PromptResult) => void;
  reject: (error: Error) => void;
}

interface ReadyFrame {
  protocolVersion: number;
  supportedProtocolVersions: number[];
  maxFrameBytes: number;
  maxReassembledFrameBytes: number;
}

export class OmpClient {
  readonly #options: OmpClientOptions;
  readonly #log: Logger;
  readonly #process: OmpProcess;
  #decoder: RpcFrameDecoder;
  readonly #pending = new Map<string, Pending>();
  readonly #runs = new Map<string, RunSlot>();
  readonly #settled = new Map<string, PromptResult>();
  #settleWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #settleEpoch = 0;
  #runOrder: string[] = [];
  #counter = 0;
  #stopping = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #readyResolve: ((frame: ReadyFrame) => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #protocolVersion: 1 | 2 = 1;
  #maxFrameBytes = DEFAULT_FRAME_BYTES;
  #exitCode: number | null = null;
  #exitNotified = false;

  constructor(options: OmpClientOptions) {
    this.#options = options;
    this.#log = options.log;
    this.#decoder = new RpcFrameDecoder(
      { maxFrameBytes: DEFAULT_FRAME_BYTES, maxReassembledBytes: DEFAULT_REASSEMBLED_BYTES },
      (reason) => this.#log.error("rpc_chunk_invalid", { reason }),
    );
    this.#process = new OmpProcess({
      bin: options.bin,
      cwd: options.cwd,
      sessionDir: options.sessionDir,
      env: options.env,
      log: this.#log,
      onLine: (line) => this.#handleLine(line),
      onReadError: (error) => this.#fatal(error),
      onUnexpectedExit: (code) => this.#handleExit(code),
    });
  }

  get alive(): boolean {
    return this.#process.open && !this.#closed && this.#exitCode === null;
  }

  get protocolVersion(): 1 | 2 {
    return this.#protocolVersion;
  }

  async start(): Promise<{ protocolVersion: 1 | 2; sessionFile?: string; resumed: boolean }> {
    let ready: ReadyFrame;
    try {
      ready = await this.#spawnAndAwaitReady(this.#options.spawnMode);
    } catch (error) {
      if (this.#options.spawnMode !== "systemd-user-scope") throw error;
      this.#log.warn("systemd_scope_unavailable", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.#process.kill();
      ready = await this.#spawnAndAwaitReady("direct");
    }

    this.#maxFrameBytes = ready.maxFrameBytes;
    this.#process.maxFrameBytes = ready.maxFrameBytes;
    this.#decoder = new RpcFrameDecoder(
      {
        maxFrameBytes: ready.maxFrameBytes,
        maxReassembledBytes: ready.maxReassembledFrameBytes,
      },
      (reason) => this.#log.error("rpc_chunk_invalid", { reason }),
    );

    try {
      if (ready.supportedProtocolVersions.includes(2)) {
        const data = await this.#request({ type: "negotiate_protocol", protocolVersion: 2 });
        const negotiated = data !== null && typeof data === "object" && "protocolVersion" in data ? data.protocolVersion : null;
        if (negotiated !== 2) throw new RpcProtocolError("RPC protocol v2 negotiation failed");
        this.#protocolVersion = 2;
        this.#decoder.enableV2();
      }

      await this.#request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
      await this.#request({ type: "set_ask_dialog", enabled: true });
      const opened = OpenSessionResultSchema.parse(await this.#request({ type: "open_session", sessionDir: this.#options.sessionDir }));
      if (opened.cancelled) throw new RpcProtocolError("open_session was cancelled");

      this.#log.info("omp_ready", {
        protocolVersion: this.#protocolVersion,
        sessionId: opened.sessionId,
        resumed: opened.resumed,
      });
      return {
        protocolVersion: this.#protocolVersion,
        sessionFile: opened.sessionFile,
        resumed: opened.resumed,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async #spawnAndAwaitReady(mode: "direct" | "systemd-user-scope"): Promise<ReadyFrame> {
    this.#process.spawn(mode);

    const ready = Promise.withResolvers<ReadyFrame>();
    this.#readyResolve = ready.resolve;
    this.#readyReject = ready.reject;

    const timeout = setTimeout(() => {
      this.#readyReject?.(new Error(`Timeout waiting for OMP ready. ${this.#process.stderrTail}`));
      this.#readyReject = null;
      this.#readyResolve = null;
    }, this.#options.startTimeoutMs);
    timeout.unref?.();

    try {
      return await ready.promise;
    } finally {
      clearTimeout(timeout);
    }
  }

  #handleLine(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#log.error("rpc_bad_json", { bytes: line.length });
      return;
    }

    let logical: unknown;
    try {
      logical = this.#decoder.push(frame);
    } catch (error) {
      this.#fatal(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (logical === null) return;
    this.#dispatch(logical);
  }

  #dispatch(frame: unknown): void {
    if (frame === null || typeof frame !== "object" || !("type" in frame)) {
      this.#log.debug("rpc_frame_ignored", { reason: "no type" });
      return;
    }
    const type = frame.type;

    if (type === "ready") {
      const parsed = ReadySchema.safeParse(frame);
      if (!parsed.success) {
        this.#fatal(new RpcProtocolError("malformed ready frame"));
        return;
      }
      const resolve = this.#readyResolve;
      this.#readyResolve = null;
      this.#readyReject = null;
      resolve?.({
        protocolVersion: parsed.data.protocolVersion,
        supportedProtocolVersions: parsed.data.supportedProtocolVersions ?? [parsed.data.protocolVersion],
        maxFrameBytes: parsed.data.maxFrameBytes ?? DEFAULT_FRAME_BYTES,
        maxReassembledFrameBytes: parsed.data.maxReassembledFrameBytes ?? DEFAULT_REASSEMBLED_BYTES,
      });
      return;
    }

    if (type === "response") {
      const parsed = ResponseSchema.safeParse(frame);
      if (!parsed.success) {
        this.#log.error("rpc_bad_response", {});
        return;
      }
      const response = parsed.data;
      if (response.id === undefined) return;
      const pending = this.#pending.get(response.id);
      if (!pending) {
        this.#log.debug("rpc_orphan_response", { command: response.command });
        return;
      }
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.success) pending.resolve(response.data ?? null);
      else pending.reject(new OmpResponseError(response.error ?? `command failed: ${response.command}`, response.code));
      return;
    }

    if (type === "prompt_result") {
      const parsed = PromptResultSchema.safeParse(frame);
      if (!parsed.success) {
        this.#log.error("rpc_bad_prompt_result", {});
        return;
      }
      this.#settleRun(parsed.data);
      return;
    }

    if (type === "session_settled") {
      this.#settleEpoch += 1;
      for (const waiter of this.#settleWaiters.splice(0)) waiter.resolve();
    }

    if (type === "extension_ui_request") {
      const parsed = UiRequestSchema.safeParse(frame);
      if (!parsed.success) {
        this.#log.error("rpc_bad_ui_request", {});
        return;
      }
      this.#options.onUiRequest(parsed.data);
      return;
    }

    if (type === "agent_end" && (!("isTerminal" in frame) || frame.isTerminal !== false)) {
      // Fallback for a lost prompt_result: only when exactly one run is outstanding.
      const waiting = this.#runOrder.find((id) => this.#runs.has(id));
      if (this.#runs.size === 1 && waiting) {
        this.#settleRun({
          type: "prompt_result",
          id: waiting,
          agentInvoked: true,
          status: "completed",
          sessionSettled: true,
        });
      }
    }

    if (typeof type === "string" && KNOWN_EVENTS[type] !== true) {
      this.#log.debug("rpc_frame_unknown", { type });
    }
    this.#options.onEvent(frame);
  }

  #settleRun(result: PromptResult): void {
    const id = result.id;
    if (id === undefined) return;
    const slot = this.#runs.get(id);
    if (!slot) return;
    this.#runs.delete(id);
    this.#runOrder = this.#runOrder.filter((entry) => entry !== id);
    this.#settled.set(id, result);
    while (this.#settled.size > 32) {
      const oldest = this.#settled.keys().next().value;
      if (oldest === undefined) break;
      this.#settled.delete(oldest);
    }
    slot.resolve(result);
  }

  #nextId(): string {
    this.#counter += 1;
    return `r${this.#counter}`;
  }

  async #request(command: RpcCommandPayload, id = this.#nextId(), timeoutMs = this.#options.requestTimeoutMs): Promise<unknown> {
    if (this.#closed) throw new OmpClosedError();
    // Spreading a discriminated union widens the literal types; the shape is exactly RpcCommand plus the id.
    const payload = { ...command, id } as RpcCommand;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`OMP request timed out: ${command.type}`));
        }, timeoutMs)
      : undefined;
    timer?.unref?.();
    this.#pending.set(id, { resolve, reject, timer });
    this.#process
      .writeLine(JSON.stringify(payload))
      .catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    return promise;
  }

  async prompt(message: string, images?: ImageContent[]): Promise<string> {
    const id = this.#nextId();
    const { promise, resolve, reject } = Promise.withResolvers<PromptResult>();
    this.#runs.set(id, { promise, resolve, reject });
    this.#runOrder.push(id);
    try {
      await this.#request({ type: "prompt", message, ...(images && images.length > 0 ? { images } : {}) }, id);
    } catch (error) {
      this.#runs.delete(id);
      this.#runOrder = this.#runOrder.filter((entry) => entry !== id);
      throw error;
    }
    return id;
  }

  get settleEpoch(): number {
    return this.#settleEpoch;
  }

  waitForSettle(since = 0): Promise<void> {
    if (this.#settleEpoch > since) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#settleWaiters.push({ resolve, reject });
    return promise;
  }

  waitForPrompt(id: string): Promise<PromptResult> {
    const slot = this.#runs.get(id);
    if (slot) return slot.promise;
    const settled = this.#settled.get(id);
    if (settled) {
      this.#settled.delete(id);
      return Promise.resolve(settled);
    }
    return Promise.reject(new OmpClosedError(`unknown prompt id ${id}`));
  }

  async abort(): Promise<void> {
    await this.#request({ type: "abort" });
  }

  async newSession(): Promise<void> {
    await this.#request({ type: "new_session" });
  }

  async bash(command: string): Promise<BashResult> {
    return BashResultSchema.parse(await this.#request({ type: "bash", command }));
  }

  async abortBash(): Promise<void> {
    await this.#request({ type: "abort_bash" });
  }

  async getState(): Promise<SessionState> {
    const state: SessionState = SessionStateSchema.parse(await this.#request({ type: "get_state" }));
    return state;
  }

  async getAvailableCommands(): Promise<unknown> {
    return this.#request({ type: "get_available_commands" });
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return AvailableModelsSchema.parse(await this.#request({ type: "get_available_models" })).models;
  }

  async setModel(provider: string, modelId: string): Promise<ModelInfo> {
    return ModelSchema.parse(await this.#request({ type: "set_model", provider, modelId }));
  }

  async getSessionStats(): Promise<SessionStats> {
    const stats: SessionStats = SessionStatsSchema.parse(await this.#request({ type: "get_session_stats" }));
    return stats;
  }

  async exportHtml(outputPath: string): Promise<string> {
    return ExportResultSchema.parse(await this.#request({ type: "export_html", outputPath })).path;
  }

  async setSessionName(name: string): Promise<void> {
    await this.#request({ type: "set_session_name", name });
  }

  async switchSession(sessionPath: string): Promise<boolean> {
    const result = SwitchSessionResultSchema.parse(
      await this.#request({ type: "switch_session", sessionPath }),
    );
    return result.cancelled;
  }

  respond(id: string, payload: UiResponsePayload): void {
    if (this.#closed) return;
    const frame: RpcExtensionUIResponse = { type: "extension_ui_response", id, ...payload };
    this.#process
      .writeLine(JSON.stringify(frame))
      .catch((error: unknown) => {
        this.#log.warn("rpc_ui_response_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    this.#stopping = true;
    this.#decoder.reset();

    const closedError = new OmpClosedError("OMP process closed");
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(closedError);
      this.#pending.delete(id);
    }
    for (const [id, slot] of this.#runs) {
      slot.reject(closedError);
      this.#runs.delete(id);
    }
    this.#runOrder = [];
    this.#settled.clear();
    for (const waiter of this.#settleWaiters.splice(0)) waiter.reject(closedError);
    this.#readyReject?.(closedError);
    this.#readyReject = null;
    this.#readyResolve = null;

    await this.#process.close();
    this.#closed = true;
  }


  #handleExit(code: number | null): void {
    this.#exitCode = code;
    const error = new OmpClosedError(`OMP process exited with code ${code}. ${this.#process.stderrTail}`);
    if (this.#readyReject) {
      const reject = this.#readyReject;
      this.#readyReject = null;
      this.#readyResolve = null;
      reject(error);
    }
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
    for (const [id, slot] of this.#runs) {
      slot.reject(error);
      this.#runs.delete(id);
    }
    this.#runOrder = [];
    for (const waiter of this.#settleWaiters.splice(0)) waiter.reject(error);
    if (!this.#stopping) {
      this.#log.error("omp_exited", { code });
      this.#notifyExit();
    }
  }

  #notifyExit(): void {
    if (this.#exitNotified) return;
    this.#exitNotified = true;
    this.#options.onExit({ code: this.#exitCode, stderr: this.#process.stderrTail });
  }

  #fatal(error: Error): void {
    this.#log.error("omp_protocol_failure", { message: error.message });
    this.#readyReject?.(error);
    this.#readyReject = null;
    this.#readyResolve = null;
    this.#notifyExit();
    void this.close();
  }
}
