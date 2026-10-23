import { describe, expect, test } from "bun:test";
import { CAPTION, RICH } from "../config/constants.ts";
import { Sender } from "../telegram/sender.ts";
import { createLogger } from "../utils/logger.ts";
import { FakeTgApi } from "./helpers/fake-telegram.ts";

const log = createLogger("error", () => undefined);
const target = { chatId: 42, messageThreadId: 7 };

function caption(extra: unknown): string | undefined {
  if (extra && typeof extra === "object" && "caption" in extra && typeof extra.caption === "string") return extra.caption;
  return undefined;
}

describe("deliverFinal", () => {
  test("falls back to HTML when the Telegram rich send fails", async () => {
    const api = new FakeTgApi();
    api.failNext("sendRichMessage");
    const sender = new Sender(api.asApi(), log);

    await sender.deliverFinal(target, "hello **world**", []);

    expect(api.callsOf("sendRichMessage")).toHaveLength(1);
    const sends = api.callsOf("sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args[1]).toBe("hello <b>world</b>");
    expect(sends[0]!.args[2]).toMatchObject({ message_thread_id: 7 });
    expect(api.callsOf("editMessageText")).toHaveLength(0);
  });

  test("splits oversized text instead of calling the rich API", async () => {
    const api = new FakeTgApi();
    const sender = new Sender(api.asApi(), log);
    const markdown = "a".repeat(RICH + 1);

    await sender.deliverFinal(target, markdown, []);

    expect(api.callsOf("sendRichMessage")).toHaveLength(0);
    const sends = api.callsOf("sendMessage");
    expect(sends).toHaveLength(9);
    for (const call of sends) expect((call.args[1] as string).length).toBeLessThanOrEqual(4096);
    for (const call of sends) expect(call.args[2]).toMatchObject({ message_thread_id: 7 });
  });

  test("captions short text on the first image without repeating it", async () => {
    const api = new FakeTgApi();
    const sender = new Sender(api.asApi(), log);
    const image = { type: "image" as const, data: Buffer.from("x").toString("base64"), mimeType: "image/png" };

    await sender.deliverFinal(target, "shot", [image]);

    expect(api.calls[0]!.method).toBe("sendPhoto");
    expect(api.calls[0]!.args[2]).toMatchObject({ caption: "shot", message_thread_id: 7 });
    expect(api.callsOf("sendRichMessage")).toHaveLength(0);
    expect(api.callsOf("sendMessage")).toHaveLength(0);
  });

  test("sends oversized captions as a separate message after the images", async () => {
    const api = new FakeTgApi();
    const sender = new Sender(api.asApi(), log);
    const image = { type: "image" as const, data: Buffer.from("x").toString("base64"), mimeType: "image/png" };
    const markdown = "b".repeat(CAPTION + 1);

    await sender.deliverFinal(target, markdown, [image]);

    expect(api.calls[0]!.method).toBe("sendPhoto");
    expect(caption(api.calls[0]!.args[2])).toBeUndefined();
    expect(api.callsOf("sendRichMessage")).toHaveLength(1);
    expect(api.callsOf("sendMessage")).toHaveLength(0);
  });
});
