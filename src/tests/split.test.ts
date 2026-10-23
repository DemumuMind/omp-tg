import { describe, expect, test } from "bun:test";
import { splitVisible, truncateVisible } from "../utils/split.ts";
import { visibleLength } from "../utils/visible.ts";

describe("splitVisible plain", () => {
  test("splits at the limit", () => {
    expect(splitVisible("a".repeat(4097), 4096, "HTML").map((chunk) => chunk.length)).toEqual([4096, 1]);
    expect(splitVisible("a".repeat(4096), 4096, "HTML")).toHaveLength(1);
    expect(splitVisible("a".repeat(32769), 4096, "HTML")).toHaveLength(9);
    expect(splitVisible("", 4096, "HTML")).toEqual([]);
  });

  test("caption-sized split", () => {
    expect(splitVisible("a".repeat(1025), 1024, "HTML").map((chunk) => chunk.length)).toEqual([1024, 1]);
  });
});

describe("splitVisible HTML", () => {
  test("closes and reopens tags across chunks", () => {
    const text = `<b>${"a".repeat(5000)}</b>`;
    const chunks = splitVisible(text, 4096, "HTML");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.startsWith("<b>")).toBe(true);
    expect(chunks[0]!.endsWith("</b>")).toBe(true);
    expect(chunks[1]!.startsWith("<b>")).toBe(true);
    expect(chunks[1]!.endsWith("</b>")).toBe(true);
    expect(chunks.map((chunk) => visibleLength(chunk, "HTML")).every((n) => n <= 4096)).toBe(true);
    expect(chunks.map((chunk) => chunk.replace(/<\/?b>/g, "")).join("")).toBe("a".repeat(5000));
  });

  test("reopens pre and code with attributes", () => {
    const text = `<pre><code class="language-ts">${"x".repeat(4200)}</code></pre>`;
    const chunks = splitVisible(text, 4096, "HTML");
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.startsWith(`<pre><code class="language-ts">`)).toBe(true);
    expect(chunks[0]!.endsWith("</code></pre>")).toBe(true);
    expect(chunks[1]!.endsWith("</code></pre>")).toBe(true);
  });

  test("never splits an entity", () => {
    const text = `<b>${"a".repeat(4095)}&amp;b</b>`;
    const chunks = splitVisible(text, 4096, "HTML");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.endsWith("</b>")).toBe(true);
    for (const chunk of chunks) expect(visibleLength(chunk, "HTML")).toBeLessThanOrEqual(4096);
    expect(chunks.join("").includes("&amp;")).toBe(true);
  });
});

describe("splitVisible MarkdownV2", () => {
  test("keeps escape pairs intact", () => {
    const chunks = splitVisible("\\_".repeat(5000), 4096, "MarkdownV2");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length % 2).toBe(0);
    expect(chunks.join("")).toBe("\\_".repeat(5000));
  });

  test("closes and reopens spoilers", () => {
    const chunks = splitVisible(`||${"s".repeat(5000)}||`, 4096, "MarkdownV2");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.endsWith("||")).toBe(true);
    expect(chunks[1]!.startsWith("||")).toBe(true);
  });
});

describe("truncateVisible", () => {
  test("returns a valid prefix", () => {
    expect(truncateVisible("<b>hello</b> world", 5, "HTML")).toBe("<b>hello</b>");
  });
});
