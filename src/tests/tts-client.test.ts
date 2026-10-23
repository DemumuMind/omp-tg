import { afterAll, expect, test } from "bun:test";
import { synthesizeSpeech } from "../tts/client.ts";

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/speak") return new Response("no", { status: 404 });
    const text = await request.text();
    if (text === "empty") return new Response(new Uint8Array());
    if (text === "fail") return new Response("{}", { status: 500 });
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/ogg" } });
  },
});

const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

test("returns audio bytes", async () => {
  expect(await synthesizeSpeech({ url: base, text: "привет", timeoutMs: 5000 })).toEqual(new Uint8Array([1, 2, 3]));
});

test("empty and failed responses yield null", async () => {
  expect(await synthesizeSpeech({ url: base, text: "empty", timeoutMs: 5000 })).toBeNull();
  expect(await synthesizeSpeech({ url: base, text: "fail", timeoutMs: 5000 })).toBeNull();
  expect(await synthesizeSpeech({ url: "http://127.0.0.1:1", text: "x", timeoutMs: 100 })).toBeNull();
});
