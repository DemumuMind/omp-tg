import { describe, expect, test } from "bun:test";
import { RpcFrameDecoder, RpcProtocolError } from "../omp/frames.ts";

const limits = { maxFrameBytes: 1024 * 1024, maxReassembledBytes: 64 * 1024 * 1024 };

function chunked(value: unknown, parts = 2) {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json, "utf8");
  const size = Math.ceil(bytes.length / parts);
  const frames = [];
  for (let index = 0; index < parts; index += 1) {
    frames.push({
      type: "rpc_chunk",
      chunkId: "abc",
      index,
      count: parts,
      byteLength: bytes.length,
      data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
    });
  }
  return { frames, json };
}

describe("RpcFrameDecoder", () => {
  test("reassembles a chunk series into one logical frame", () => {
    const decoder = new RpcFrameDecoder(limits);
    decoder.enableV2();
    const { frames, json } = chunked({ type: "message_end", message: { content: ["x"] } });
    expect(decoder.push(frames[0])).toBeNull();
    expect(decoder.push(frames[1])).toEqual(JSON.parse(json));
  });

  test("passes ordinary frames through in v1", () => {
    const decoder = new RpcFrameDecoder(limits);
    const frame = { type: "response", id: "1", command: "abort", success: true };
    expect(decoder.push(frame)).toBe(frame);
  });

  test("rejects chunks before negotiation", () => {
    const decoder = new RpcFrameDecoder(limits);
    expect(() => decoder.push(chunked({ a: 1 }).frames[0])).toThrow(RpcProtocolError);
  });

  test.each([
    ["index gap", 2],
    ["duplicate index", 0],
  ])("resets the series on %s", (_label, index) => {
    const errors: string[] = [];
    const decoder = new RpcFrameDecoder(limits, (reason) => errors.push(reason));
    decoder.enableV2();
    const { frames } = chunked({ a: 1 }, 3);
    expect(decoder.push(frames[0])).toBeNull();
    expect(decoder.push({ ...frames[1], index })).toBeNull();
    expect(errors).toHaveLength(1);
    expect(decoder.push(frames[0])).toBeNull();
  });

  test("rejects a changed chunkId and accepts the next series", () => {
    const errors: string[] = [];
    const decoder = new RpcFrameDecoder(limits, (reason) => errors.push(reason));
    decoder.enableV2();
    const { frames } = chunked({ a: 1 });
    const first = { ...frames[0], chunkId: "one" };
    const second = { ...frames[1], chunkId: "two" };
    expect(decoder.push(first)).toBeNull();
    expect(decoder.push(second)).toBeNull();
    expect(errors).toHaveLength(1);
    const next = chunked({ b: 2 });
    expect(decoder.push({ ...next.frames[0], chunkId: "three" })).toBeNull();
    expect(decoder.push({ ...next.frames[1], chunkId: "three" })).toEqual({ b: 2 });
  });

  test("rejects mismatched byteLength and invalid base64", () => {
    const decoder = new RpcFrameDecoder(limits);
    decoder.enableV2();
    const { frames } = chunked({ a: 1 });
    expect(decoder.push({ ...frames[0], byteLength: 9999 })).toBeNull();
    expect(decoder.push(frames[1])).toBeNull();
    expect(decoder.push({ ...frames[0], data: "!!!!" })).toBeNull();
  });

  test("rejects a series over the reassembly limit", () => {
    const decoder = new RpcFrameDecoder({ ...limits, maxReassembledBytes: 4 });
    decoder.enableV2();
    const { frames } = chunked({ a: 1 });
    expect(decoder.push({ ...frames[0], byteLength: 5 })).toBeNull();
  });

  test("resets the series when an ordinary frame interleaves", () => {
    const errors: string[] = [];
    const decoder = new RpcFrameDecoder(limits, (reason) => errors.push(reason));
    decoder.enableV2();
    const { frames } = chunked({ a: 1 });
    expect(decoder.push(frames[0])).toBeNull();
    const response = { type: "response", success: true };
    expect(decoder.push(response)).toBe(response);
    expect(errors).toHaveLength(1);
  });
});
