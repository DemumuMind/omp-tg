import { expect, test } from "bun:test";
import { plainTextForTts } from "../tts/text.ts";

test("strips markdown and code for speech", () => {
  const text = plainTextForTts("## Итог\n\n**Готово**: [ссылка](https://x.test) и `код`.\n\n```ts\nconst x = 1;\n```");
  expect(text).toContain("Итог");
  expect(text).toContain("Готово");
  expect(text).toContain("ссылка");
  expect(text).toContain("код в сообщении");
  expect(text).not.toContain("const x");
  expect(text).not.toContain("https://");
});

test("caps at a sentence boundary", () => {
  const text = plainTextForTts(`${"Первое предложение. ".repeat(200)}`, 80);
  expect(text.length).toBeLessThanOrEqual(81);
  expect(text.endsWith(".") || text.endsWith("…")).toBe(true);
});
