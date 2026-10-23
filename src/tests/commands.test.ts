import { describe, expect, test } from "bun:test";
import { extractAtPaths, isDangerousBash, parseBangCommand, parseGatewayCommand } from "../telegram/commands.ts";

describe("parseGatewayCommand", () => {
  test("recognizes gateway commands, with or without a bot suffix", () => {
    expect(parseGatewayCommand("/start")).toEqual({ kind: "start" });
    expect(parseGatewayCommand("/help@my_bot")).toEqual({ kind: "help" });
    expect(parseGatewayCommand("/new now")).toEqual({ kind: "new" });
    expect(parseGatewayCommand("/file ./a b.txt")).toEqual({ kind: "file", path: "./a b.txt" });
    expect(parseGatewayCommand("/file")).toEqual({ kind: "file", path: "" });
  });

  test("leaves native OMP commands and plain text alone", () => {
    expect(parseGatewayCommand("/compact now")).toBeNull();
    expect(parseGatewayCommand("/model gpt")).toEqual({ kind: "model", query: "gpt" });
    expect(parseGatewayCommand("hello")).toBeNull();
  });
});

describe("parseBangCommand", () => {
  test("extracts the shell command", () => {
    expect(parseBangCommand("!echo ok")).toBe("echo ok");
    expect(parseBangCommand("!")).toBeNull();
    expect(parseBangCommand("echo ok")).toBeNull();
  });
});

describe("extractAtPaths", () => {
  test("selects path-like tokens and ignores mentions", () => {
    expect(extractAtPaths("@alice look at @./src/a.ts and @/etc/passwd")).toEqual(["./src/a.ts", "/etc/passwd"]);
    expect(extractAtPaths("mail a@b.com")).toEqual([]);
  });
});

describe("isDangerousBash", () => {
  test("blocks destructive commands", () => {
    expect(isDangerousBash("rm -rf /")).toBe(true);
    expect(isDangerousBash("sudo mkfs.ext4 /dev/sda1")).toBe(true);
    expect(isDangerousBash(":(){ :|:& };:")).toBe(true);
    expect(isDangerousBash("dd if=/dev/zero of=/dev/sda")).toBe(true);
  });

  test("allows ordinary commands", () => {
    expect(isDangerousBash("rm build/output.txt")).toBe(false);
    expect(isDangerousBash("ls -la")).toBe(false);
    expect(isDangerousBash("echo rebooted")).toBe(false);
  });
});
