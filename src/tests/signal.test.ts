import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("SIGTERM shutdown", () => {
  test("runs the shutdown sequence once and exits cleanly", async () => {
    const fixture = join(import.meta.dir, "fixtures", "signal-app.ts");
    const proc = Bun.spawn(["bun", fixture], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const decoder = new TextDecoder();
    let output = "";
    let signalled = false;
    for await (const chunk of proc.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (!signalled && output.includes("ready\n")) {
        signalled = true;
        proc.kill("SIGTERM");
        proc.kill("SIGTERM");
      }
    }

    const code = await proc.exited;
    expect(code).toBe(0);
    expect(output.match(/"event":"shutdown"/g)).toHaveLength(1);
    const eventsLine = output.split("\n").find((line) => line.startsWith("events:"));
    expect(eventsLine).toBe("events:bot.stop,sessions.shutdown,exit 0");
  }, 10_000);
});
