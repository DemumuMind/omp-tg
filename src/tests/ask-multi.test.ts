import { beforeEach, describe, expect, test } from "bun:test";
import type { InlineKeyboardButton } from "grammy/types";
import type { UiResponsePayload } from "../omp/protocol.ts";
import { clearUiRegistry, UiController } from "../omp/ui-controller.ts";
import { Sender } from "../telegram/sender.ts";
import { createLogger } from "../utils/logger.ts";
import { FakeTgApi } from "./helpers/fake-telegram.ts";

const log = createLogger("error", () => undefined);
const target = { chatId: 11, messageThreadId: 3 };

class FakeClient {
  readonly responses: Array<{ id: string; payload: UiResponsePayload }> = [];
  respond(id: string, payload: UiResponsePayload): void {
    this.responses.push({ id, payload });
  }
}

function setup() {
  clearUiRegistry();
  const api = new FakeTgApi();
  const client = new FakeClient();
  const sender = new Sender(api.asApi(), log);
  const ui = new UiController(client, sender, target, log);
  return { api, client, sender, ui };
}

function callbackOf(button: InlineKeyboardButton | undefined): string {
  return button && "callback_data" in button ? (button.callback_data ?? "") : "";
}

function buttonData(api: FakeTgApi): string[] {
  return (api.lastKeyboard()?.inline_keyboard ?? []).map((row) => callbackOf(row[0]));
}

function tokenOf(api: FakeTgApi): string {
  return buttonData(api)[0]!.split(":")[1]!;
}

describe("ask dialog", () => {
  beforeEach(() => clearUiRegistry());

  test("collects a multi-select answer in question order", async () => {
    const { api, client, ui } = setup();
    await ui.handle({
      type: "extension_ui_request",
      id: "req1",
      method: "ask",
      questions: [
        {
          id: "q1",
          question: "Which?",
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
          multi: true,
          recommended: 1,
        },
      ],
    });

    const data = buttonData(api);
    expect(data).toHaveLength(4);
    const keyboard = api.lastKeyboard()!;
    expect(keyboard.inline_keyboard[1]![0]!.text).toBe("B (Recommended)");
    expect(keyboard.inline_keyboard[3]![0]!.text).toBe("✍️ Свой ответ");
    const done = callbackOf(keyboard.inline_keyboard[3]![1]);

    const token = tokenOf(api);
    for (const index of [0, 1, 2]) {
      expect(await ui.handleCallback(`ui:${token}:0:${index}`)).toBeUndefined();
    }
    expect(await ui.handleCallback(done)).toBe("✅");

    expect(client.responses).toHaveLength(1);
    expect(client.responses[0]!.payload).toEqual({
      answers: [{ id: "q1", selectedOptions: ["A", "B", "C"] }],
    });
    for (const entry of data) expect(Buffer.byteLength(entry, "utf8")).toBeLessThanOrEqual(64);
  });

  test("accepts a custom text answer", async () => {
    const { api, client, ui } = setup();
    await ui.handle({
      type: "extension_ui_request",
      id: "req2",
      method: "ask",
      questions: [{ id: "q1", question: "Name?", options: [{ label: "A" }] }],
    });

    const token = tokenOf(api);
    await ui.handleCallback(`ui:${token}:0:text`);
    expect(ui.expectsText).toBe(true);
    expect(await ui.handleText("custom value")).toBe(true);

    expect(client.responses).toHaveLength(1);
    expect(client.responses[0]!.payload).toEqual({
      answers: [{ id: "q1", selectedOptions: [], customInput: "custom value" }],
    });
  });

  test("advances through multiple questions and reports answers in order", async () => {
    const { api, client, ui } = setup();
    await ui.handle({
      type: "extension_ui_request",
      id: "req3",
      method: "ask",
      questions: [
        { id: "q1", question: "First?", options: [{ label: "A" }, { label: "B" }] },
        { id: "q2", question: "Second?", options: [{ label: "C" }] },
      ],
    });

    const token = tokenOf(api);
    expect(await ui.handleCallback(`ui:${token}:1:0`)).toBe("Сначала ответьте на текущий вопрос");
    expect(await ui.handleCallback("ui:unknown:0:0")).toBe("Устарело");

    expect(await ui.handleCallback(`ui:${token}:0:1`)).toBe("✅");
    expect(api.callsOf("sendMessage")).toHaveLength(2);
    expect(await ui.handleCallback(`ui:${token}:1:0`)).toBe("✅");

    expect(client.responses).toHaveLength(1);
    expect(client.responses[0]!.payload).toEqual({
      answers: [
        { id: "q1", selectedOptions: ["B"] },
        { id: "q2", selectedOptions: ["C"] },
      ],
    });
    expect(await ui.handleCallback(`ui:${token}:0:0`)).toBe("Устарело");
  });
});
