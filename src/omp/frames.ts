import { Buffer } from "node:buffer";
import { ChunkSchema } from "./protocol.ts";

export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

export interface FrameLimits {
  maxFrameBytes: number;
  maxReassembledBytes: number;
}

interface Series {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  parts: Buffer[];
  bytes: number;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes the NDJSON frame stream. Protocol v2 wraps oversized logical frames in a
 * contiguous series of `rpc_chunk` lines that must be reassembled before dispatch.
 */
export class RpcFrameDecoder {
  #v2 = false;
  #series: Series | null = null;
  readonly #limits: FrameLimits;
  readonly #onError: (reason: string) => void;

  constructor(limits: FrameLimits, onError: (reason: string) => void = () => undefined) {
    this.#limits = limits;
    this.#onError = onError;
  }

  enableV2(): void {
    this.#v2 = true;
  }

  reset(): void {
    this.#series = null;
  }

  #fail(reason: string): null {
    this.#series = null;
    this.#onError(reason);
    return null;
  }

  push(frame: unknown): unknown | null {
    const type = frame !== null && typeof frame === "object" && "type" in frame ? frame.type : undefined;

    if (type === "rpc_chunk") {
      if (!this.#v2) throw new RpcProtocolError("received rpc_chunk before protocol v2 negotiation");
      const parsed = ChunkSchema.safeParse(frame);
      if (!parsed.success) return this.#fail("malformed rpc_chunk");
      const chunk = parsed.data;

      if (chunk.byteLength > this.#limits.maxReassembledBytes) return this.#fail("chunk series exceeds reassembly limit");
      if (this.#series === null) {
        if (chunk.index !== 0) return this.#fail("chunk series does not start at index 0");
        if (chunk.chunkId.length === 0) return this.#fail("empty chunkId");
        if (chunk.count > 1_000_000) return this.#fail("unreasonable chunk count");
        this.#series = {
          chunkId: chunk.chunkId,
          count: chunk.count,
          byteLength: chunk.byteLength,
          nextIndex: 0,
          parts: [],
          bytes: 0,
        };
      }

      const series = this.#series;
      if (series === null) return null;
      if (chunk.chunkId !== series.chunkId) return this.#fail("chunkId changed mid-series");
      if (chunk.count !== series.count) return this.#fail("chunk count changed mid-series");
      if (chunk.byteLength !== series.byteLength) return this.#fail("chunk byteLength changed mid-series");
      if (chunk.index !== series.nextIndex) return this.#fail("chunk index gap or duplicate");

      if (chunk.data.length % 4 !== 0 || !BASE64_RE.test(chunk.data)) return this.#fail("invalid base64 chunk payload");
      const bytes = Buffer.from(chunk.data, "base64");
      if (bytes.length > series.byteLength - series.bytes) return this.#fail("chunk payload overruns byteLength");
      series.parts.push(bytes);
      series.bytes += bytes.length;
      series.nextIndex += 1;

      if (series.nextIndex < series.count) return null;
      if (series.bytes !== series.byteLength) return this.#fail("reassembled byte length mismatch");

      const assembled = Buffer.concat(series.parts);
      this.#series = null;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(assembled);
      } catch {
        return this.#fail("reassembled payload is not UTF-8");
      }
      try {
        const decoded: unknown = JSON.parse(text);
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
          return this.#fail("reassembled payload is not a JSON object");
        }
        return decoded;
      } catch {
        return this.#fail("reassembled payload is not valid JSON");
      }
    }

    if (this.#series !== null) {
      this.#onError("ordinary frame interleaved into a chunk series; series reset");
      this.#series = null;
    }
    return frame;
  }
}
