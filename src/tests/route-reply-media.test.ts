import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { routeText } from "../telegram/handlers.ts";
import type { Runtime } from "../telegram/gate.ts";
import { FakeTgApi } from "./helpers/fake-telegram.ts";
import type { ImageContent } from "../omp/protocol.ts";

function makeRuntime() {
  const api = new FakeTgApi();
  const prompts: Array<{ text: string; images: ImageContent[] }> = [];
  const runtime = {
    config: {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_REQUIRE_MENTION: false,
      TELEGRAM_GROUP_ALLOWED_CHATS: "",
      TELEGRAM_REACTIONS: false,
      OMP_WORKDIR: "/tmp",
      OMP_UPLOAD_DIR: "/tmp/omp-tg-test-uploads",
      OMP_SESSION_ROOT: "/tmp/omp-tg-test-sessions",
      ALLOWED_USER_IDS: "1",
    },
    bot: { api, botInfo: { id: 42, username: "test_bot" } },
    sender: {
      sendText: async () => [1],
      react: async () => true,
    },
    sessions: {
      handleText: async (_target: unknown, text: string, images: ImageContent[]) => {
        prompts.push({ text, images });
      },
      uploadDirFor: async () => "/tmp/omp-tg-test-uploads",
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    queue: { push: async (_key: string, fn: () => Promise<void>) => fn() },
    digest: {},
  } as unknown as Runtime;
  return { runtime, prompts };
}

function ctxWithReply(reply: Record<string, unknown> | undefined, text = "что на картинке?"): Context {
  return {
    chat: { id: 100, type: "private" },
    from: { id: 1, first_name: "Tester" },
    message: {
      message_id: 10,
      text,
      ...(reply === undefined ? {} : { reply_to_message: reply }),
    },
  } as unknown as Context;
}

const realFetch = globalThis.fetch;

describe("routeText reply media", () => {
  test("attaches a quoted photo to the prompt", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-length": "4" } })) as unknown as typeof fetch;
    try {
      const { runtime, prompts } = makeRuntime();
      const reply = {
        message_id: 9,
        from: { id: 1, first_name: "Tester" },
        photo: [{ file_id: "p1", file_unique_id: "u1", width: 10, height: 10, file_size: 4 }],
      };
      await routeText(runtime, ctxWithReply(reply), "что на картинке?", []);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.images).toHaveLength(1);
      expect(prompts[0]!.images[0]!.type).toBe("image");
      expect(prompts[0]!.text).toContain("что на картинке?");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("quoted document lands as a path note", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } })) as unknown as typeof fetch;
    try {
      const { runtime, prompts } = makeRuntime();
      const reply = {
        message_id: 9,
        from: { id: 1, first_name: "Tester" },
        document: { file_id: "d1", file_name: "notes.txt", file_size: 3 },
      };
      await routeText(runtime, ctxWithReply(reply), "глянь файл", []);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.images).toHaveLength(0);
      expect(prompts[0]!.text).toContain("document");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("plain text without a reply passes through untouched", async () => {
    const { runtime, prompts } = makeRuntime();
    await routeText(runtime, ctxWithReply(undefined), "Ку", []);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.images).toHaveLength(0);
    expect(prompts[0]!.text).not.toContain("[media]");
  });
});
