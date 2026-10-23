import { expect, test } from "bun:test";
import { parseChatIds } from "../telegram/bot.ts";

test("empty group allowlist stays empty", () => {
  expect(parseChatIds("")).toEqual(new Set());
  expect(parseChatIds(" , ")).toEqual(new Set());
});

test("parses explicit group ids", () => {
  expect(parseChatIds("-1004351463244, 123")).toEqual(new Set([-1004351463244, 123]));
  expect(parseChatIds("nope, 456")).toEqual(new Set([456]));
});
