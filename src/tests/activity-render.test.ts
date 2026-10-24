import { describe, expect, test } from "bun:test";
import { renderRun } from "../omp/session-manager.ts";
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
    const run = makeRun(30);
    const html = renderRun(run);
    expect(html).toContain("… ещё 10 тулзов выше");
    expect(html).toContain(`✓ tool_29 — дело №${29}`);
    expect(html).not.toContain("✓ tool_0 ");
    // No reordering: the hidden notice comes first, entries stay chronological.
    const notice = html.indexOf("… ещё 10");
    const last = html.indexOf("tool_29");
    expect(notice).toBeLessThan(last);
  });

  test("clips long summaries per line", () => {
    const run = makeRun(1);
    run.activity[0]!.summary = "x".repeat(100);
    const html = renderRun(run);
    expect(html).toContain("…");
    expect(html.length).toBeLessThan(100);
  });
});
