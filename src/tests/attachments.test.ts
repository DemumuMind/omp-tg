import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sender } from "../telegram/sender.ts";
import { createLogger } from "../utils/logger.ts";
import { FakeTgApi } from "./helpers/fake-telegram.ts";

const log = createLogger("error", () => undefined);
const target = { chatId: 9, messageThreadId: 2 };

describe("sendAttachment", () => {
  test("dispatches by extension and falls back to a document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-tg-attach-"));
    try {
      const api = new FakeTgApi();
      const sender = new Sender(api.asApi(), log);
      const files: Array<[string, string]> = [
        ["a.png", "sendPhoto"],
        ["a.ogg", "sendVoice"],
        ["a.mp4", "sendVideo"],
        ["a.zip", "sendDocument"],
      ];
      for (const [name, _method] of files) await writeFile(join(dir, name), "data");

      for (const [name, method] of files) {
        const ok = await sender.sendAttachment(target, join(dir, name), "caption");
        expect(ok).toBe(true);
        expect(api.callsOf(method)).toHaveLength(1);
        expect(api.callsOf(method)[0]!.args[2]).toMatchObject({ message_thread_id: 2, caption: "caption" });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reactions", () => {
  test("sets an emoji reaction", async () => {
    const api = new FakeTgApi();
    const sender = new Sender(api.asApi(), log);
    await sender.react(target, 77, "👍");
    expect(api.callsOf("setMessageReaction")[0]!.args).toEqual([9, 77, [{ type: "emoji", emoji: "👍" }]]);
  });
});
