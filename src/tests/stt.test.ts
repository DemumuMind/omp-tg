import { afterAll, expect, test } from "bun:test";
import { transcribeAudio } from "../stt/client.ts";

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/transcribe") return new Response("not found", { status: 404 });
    if (request.headers.get("x-filename") === "fail.ogg") return new Response("{}", { status: 500 });
    if (request.headers.get("x-language") === "empty") return Response.json({ text: "   " });
    return Response.json({ text: " hello ", language: request.headers.get("x-language") ?? "auto" });
  },
});

const base = `http://127.0.0.1:${server.port}`;

function call(fileName = "voice.ogg", language = "ru"): Promise<string | null> {
  return transcribeAudio({
    url: base,
    bytes: new Uint8Array([1, 2, 3]),
    fileName,
    language,
    timeoutMs: 5000,
  });
}

afterAll(() => server.stop(true));

test("returns trimmed transcript", async () => {
  expect(await call()).toBe("hello");
});

test("silence yields null", async () => {
  expect(await call("voice.ogg", "empty")).toBeNull();
});

test("http errors and dead sidecars yield null", async () => {
  expect(await call("fail.ogg")).toBeNull();
  expect(
    await transcribeAudio({
      url: "http://127.0.0.1:1",
      bytes: new Uint8Array([1]),
      fileName: "x.ogg",
      timeoutMs: 100,
    }),
  ).toBeNull();
});
