import { createHash } from "node:crypto";
import { AsyncQueue } from "../utils/queue.ts";
import { OmpClosedError } from "./errors.ts";
import type { Logger } from "../utils/logger.ts";

const STDERR_TAIL_BYTES = 8192;

export type SpawnMode = "direct" | "systemd-user-scope";

export interface ScopeLimits {
  memoryMax: string;
  memorySwapMax: string;
  tasksMax: number;
  cpuQuota: string;
}

export interface OmpProcessOptions {
  bin: string;
  cwd: string;
  sessionDir: string;
  env?: Record<string, string>;
  log: Logger;
  onLine: (line: string) => void;
  onReadError: (error: Error) => void;
  onUnexpectedExit: (code: number | null, stderrTail: string) => void;
}

/** Builds the argv for spawning OMP, wrapping in systemd-run when scoped. */
export function buildOmpCommand(
  bin: string,
  sessionDir: string,
  mode: SpawnMode,
  scopeLimits?: ScopeLimits,
): string[] {
  const args = [bin, "--mode", "rpc", "--session-dir", sessionDir];
  if (mode !== "systemd-user-scope") return args;
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--unit",
    `omp-tg-${createHash("sha256").update(sessionDir).digest("hex").slice(0, 12)}`,
    ...(scopeLimits
      ? [
          "--property",
          `MemoryMax=${scopeLimits.memoryMax}`,
          "--property",
          `MemorySwapMax=${scopeLimits.memorySwapMax}`,
          "--property",
          `TasksMax=${scopeLimits.tasksMax}`,
          "--property",
          `CPUQuota=${scopeLimits.cpuQuota}`,
        ]
      : []),
    "--",
    ...args,
  ];
}

/**
 * Owns the OMP subprocess: spawning, stdin writes (serialized), stdout/stderr
 * readers, generation tracking and escalated shutdown. Knows nothing about
 * the RPC protocol beyond "one JSON object per line".
 */
export class OmpProcess {
  readonly #options: OmpProcessOptions;
  readonly #log: Logger;
  readonly #queue = new AsyncQueue();
  #proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  #stdin: Bun.FileSink | null = null;
  #stderr = "";
  #generation = 0;
  #stopping = false;
  #maxFrameBytes = 1024 * 1024;

  constructor(options: OmpProcessOptions) {
    this.#options = options;
    this.#log = options.log;
  }

  get open(): boolean {
    return this.#proc !== null;
  }

  get generation(): number {
    return this.#generation;
  }

  set maxFrameBytes(bytes: number) {
    this.#maxFrameBytes = bytes;
  }

  get stderrTail(): string {
    const tail = this.#stderr.slice(-STDERR_TAIL_BYTES);
    return tail.trim() === "" ? "" : `stderr: ${tail.trim()}`;
  }

  spawn(mode: SpawnMode): void {
    const command = buildOmpCommand(this.#options.bin, this.#options.sessionDir, mode);
    const spawnEnv =
      mode === "systemd-user-scope"
        ? { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}`, ...this.#options.env }
        : { ...process.env, ...this.#options.env };
    const proc = Bun.spawn(command, {
      cwd: this.#options.cwd,
      env: spawnEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#proc = proc;
    this.#stdin = proc.stdin;
    this.#stderr = "";
    this.#stopping = false;
    const generation = ++this.#generation;

    void this.#readStderr(proc, generation);
    void this.#readStdout(proc, generation);
    void proc.exited.then((code) => {
      if (generation !== this.#generation) return;
      if (this.#stopping) return;
      this.#options.onUnexpectedExit(code, this.stderrTail);
    });
  }

  /** Serialized stdin write of one JSON line; rejects when the process is gone. */
  writeLine(line: string): Promise<void> {
    return this.#queue.push(async () => {
      const stdin = this.#stdin;
      if (!stdin) throw new OmpClosedError();
      stdin.write(`${line}\n`);
      await stdin.flush();
    });
  }

  /** SIGKILL the process and detach; a new spawn() may follow. */
  kill(): void {
    this.#generation += 1;
    const proc = this.#proc;
    if (!proc) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
    this.#proc = null;
    this.#stdin = null;
  }

  /** Graceful stop: end stdin, then SIGTERM/SIGKILL escalation. */
  async close(): Promise<void> {
    this.#stopping = true;
    const proc = this.#proc;
    if (!proc) return;

    try {
      this.#stdin?.end();
    } catch {
      // already closed
    }
    this.#stdin = null;

    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already dead
      }
      const terminated = await Promise.race([proc.exited.then(() => true), Bun.sleep(2000).then(() => false)]);
      if (!terminated) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }
    this.#proc = null;
  }

  async #readStderr(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, generation: number): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) {
        if (generation !== this.#generation) return;
        this.#stderr += decoder.decode(chunk, { stream: true });
        if (this.#stderr.length > STDERR_TAIL_BYTES * 2) this.#stderr = this.#stderr.slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // stderr is diagnostic only; a read failure must not take down the client.
    }
  }

  async #readStdout(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, generation: number): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of proc.stdout) {
        if (generation !== this.#generation) return;
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() !== "") this.#options.onLine(line);
          newline = buffer.indexOf("\n");
        }
        if (Buffer.byteLength(buffer, "utf8") > this.#maxFrameBytes * 2) {
          this.#log.error("rpc_line_too_long", { bytes: Buffer.byteLength(buffer, "utf8") });
          buffer = "";
        }
      }
      if (buffer.trim() !== "") this.#options.onLine(buffer);
    } catch (error) {
      if (this.#stopping || generation !== this.#generation) return;
      this.#options.onReadError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
