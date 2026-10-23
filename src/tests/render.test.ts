import { describe, expect, test } from "bun:test";
import { renderStreamingHtml } from "../utils/render.ts";

describe("renderStreamingHtml", () => {
  test("renders fenced code and escapes its body", () => {
    expect(renderStreamingHtml("```ts\nconst a = 1 < 2;\n```")).toBe(
      `<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>`,
    );
  });

  test("renders inline code", () => {
    expect(renderStreamingHtml("run `bun test` now")).toBe("run <code>bun test</code> now");
  });

  test("renders emphasis, strike and links", () => {
    expect(renderStreamingHtml("**b** _i_ ~~s~~ [l](https://e.com/a)")).toBe(
      `<b>b</b> <i>i</i> <s>s</s> <a href="https://e.com/a">l</a>`,
    );
  });

  test("renders headings and bullets", () => {
    expect(renderStreamingHtml("## Title\n- one\n- two")).toBe("<b>Title</b>\n\u2022 one\n\u2022 two");
  });

  test("escapes raw HTML", () => {
    expect(renderStreamingHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("leaves an unclosed fence as text", () => {
    expect(renderStreamingHtml("```ts\nconst a = 1")).toBe("```ts\nconst a = 1");
  });
});
