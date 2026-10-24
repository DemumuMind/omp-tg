import { describe, expect, test } from "bun:test";
import { buildOmpCommand } from "../omp/process.ts";

describe("buildOmpCommand", () => {
  test("direct mode spawns omp rpc with session dir", () => {
    const argv = buildOmpCommand("/usr/local/bin/omp", "/tmp/sess-1", "direct");
    expect(argv).toEqual(["/usr/local/bin/omp", "--mode", "rpc", "--session-dir", "/tmp/sess-1"]);
  });

  test("thinking option appends --thinking flag", () => {
    const argv = buildOmpCommand("/usr/local/bin/omp", "/tmp/sess-1", "direct", undefined, { thinking: "low" });
    expect(argv).toEqual(["/usr/local/bin/omp", "--mode", "rpc", "--session-dir", "/tmp/sess-1", "--thinking", "low"]);
  });

  test("no thinking option leaves argv unchanged", () => {
    const withUndefined = buildOmpCommand("/bin/omp", "/tmp/s", "direct", undefined, { thinking: undefined });
    expect(withUndefined).toEqual(["/bin/omp", "--mode", "rpc", "--session-dir", "/tmp/s"]);
  });

  test("systemd scope wraps command after the omp args", () => {
    const argv = buildOmpCommand("/bin/omp", "/tmp/s", "systemd-user-scope");
    expect(argv[0]).toBe("systemd-run");
    expect(argv.at(-6)).toBe("--");
    expect(argv.at(-5)).toBe("/bin/omp");
    expect(argv.slice(-2)).toEqual(["--session-dir", "/tmp/s"]);
    expect(argv).not.toContain("--thinking");
  });

  test("systemd scope keeps thinking flag on the inner command", () => {
    const argv = buildOmpCommand("/bin/omp", "/tmp/s", "systemd-user-scope", undefined, { thinking: "off" });
    expect(argv.slice(-2)).toEqual(["--thinking", "off"]);
  });
});
