import { describe, expect, test } from "bun:test";
import { escapeFor } from "../utils/escape.ts";

describe("escapeFor HTML", () => {
  test("escapes markup and bare ampersands", () => {
    expect(escapeFor("HTML", "<b>&")).toBe("&lt;b&gt;&amp;");
  });

  test("keeps existing entities and is idempotent", () => {
    expect(escapeFor("HTML", "a &amp; b &lt; c")).toBe("a &amp; b &lt; c");
    const once = escapeFor("HTML", "<x> & \"q\" &copy;");
    expect(escapeFor("HTML", once)).toBe(once);
  });
});

describe("escapeFor MarkdownV2", () => {
  test("escapes every reserved character", () => {
    expect(escapeFor("MarkdownV2", "a_b*c[d]e(f)g~`h>i#j+k-l=m|n{o}p!q.r\\s")).toBe(
      "a\\_b\\*c\\[d\\]e\\(f\\)g\\~\\`h\\>i\\#j\\+k\\-l\\=m\\|n\\{o\\}p\\!q\\.r\\\\s",
    );
  });

  test("does not double an existing escape", () => {
    expect(escapeFor("MarkdownV2", "\\_")).toBe("\\_");
    expect(escapeFor("MarkdownV2", "\\\\_")).toBe("\\\\\\_");
  });

  test("is idempotent", () => {
    const once = escapeFor("MarkdownV2", "price: 5.00 (net) [x] #1");
    expect(escapeFor("MarkdownV2", once)).toBe(once);
  });
});
