import { describe, expect, test } from "bun:test";
import { renderRun, renderToolReport } from "../omp/session-manager.ts";
import type { ActiveRun } from "../omp/session-manager.ts";
import type { StreamRenderer } from "../telegram/stream.ts";
import type { ImageContent } from "../omp/protocol.ts";

function makeRun(count: number): ActiveRun {
  const activity = Array.from({ length: count }, (_, i) => ({
    id: `call-${i}`,
    name: `tool_${i}`,
    summary: `дело №${i}`,
    status: "done" as const,
  }));
  return {
    renderer: {} as unknown as StreamRenderer,
    text: "",
    images: [],
    imageKeys: new Set<string>(),
    activity,
    thinking: "",
    voiceReply: false,
  };
}

describe("renderRun activity list", () => {
  test("shows all entries when under the limit", () => {
    const html = renderRun(makeRun(3));
    expect(html).toContain("✓ tool_0 — дело №0");
    expect(html).toContain("✓ tool_2 — дело №2");
    expect(html).not.toContain("ещё");
  });

  test("keeps the newest entries and announces the hidden count", () => {
    // Long summaries push the entries past the char budget.
    const run = makeRun(60);
    run.activity.forEach((entry) => {
      entry.summary = `${entry.summary} ${"детали ".repeat(10)}`.trim();
    });
    const html = renderRun(run);
    expect(html).toContain("… ещё");
    expect(html).toContain(`✓ tool_59 —`);
    const notice = html.indexOf("… ещё");
    const last = html.indexOf("tool_59");
    expect(notice).toBeLessThan(last);
  });

  test("produces a full tool report only when entries were hidden", () => {
    const small = makeRun(5);
    expect(renderToolReport(small)).toBeNull();

    const big = makeRun(60);
    big.activity.forEach((entry) => {
      entry.summary = `${entry.summary} ${"детали ".repeat(10)}`.trim();
    });
    const report = renderToolReport(big);
    expect(report).not.toBeNull();
    expect(report!).toContain("🔧 Тулзы (60)");
    expect(report!).toContain("tool_0×1");
    expect(report!).toContain("tool_59");
  });

  test("renders the live reasoning tail above the answer", () => {
    const run = makeRun(1);
    run.thinking = "думает".repeat(200) + " финальная мысль";
    const html = renderRun(run);
    expect(html).toContain("💭");
    expect(html).toContain("финальная мысль");
    expect(html).toContain("…");
    const thinkingLine = html.split("\n").find((line: string) => line.startsWith("💭")) ?? "";
    expect(thinkingLine.length).toBeLessThanOrEqual(410);

    const empty = makeRun(0);
    empty.thinking = "";
    empty.text = "готово";
    expect(renderRun(empty)).toBe("готово");
  });

  test("clips long summaries per line", () => {
    const run = makeRun(1);
    run.activity[0]!.summary = "x".repeat(100);
    const html = renderRun(run);
    expect(html).toContain("…");
    expect(html.length).toBeLessThan(100);
  });
});
