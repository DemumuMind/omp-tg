import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpClient } from "../omp/client.ts";
import { createLogger } from "../utils/logger.ts";

const ompBin = process.env.OMP_BIN ?? Bun.which("omp") ?? "";
const enabled = process.env.OMP_E2E === "1" && ompBin !== "" && Bun.which(ompBin) !== null;
const log = createLogger("error", () => undefined);

describe("OmpClient against a real OMP process", () => {
  test.skipIf(!enabled)(
    "handshakes, opens a session, reports state, and exits cleanly",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "omp-tg-e2e-"));
      const sessionDir = join(dir, "sessions");
      const client = new OmpClient({
        bin: ompBin,
        cwd: dir,
        sessionDir,
        spawnMode: "direct",
        startTimeoutMs: 60_000,
        requestTimeoutMs: 30_000,
        onEvent: () => undefined,
        onUiRequest: () => undefined,
        onExit: () => undefined,
        log,
      });

      try {
        const started = await client.start();
        expect([1, 2]).toContain(started.protocolVersion);
        expect(started.resumed).toBe(false);
        expect(started.sessionFile).toBeDefined();

        const state = await client.getState();
        expect(state.sessionId.length).toBeGreaterThan(0);
        expect(state.messageCount).toBeGreaterThanOrEqual(0);

        const commands = await client.getAvailableCommands();
        expect(
          commands !== null &&
            typeof commands === "object" &&
            "commands" in commands &&
            Array.isArray(commands.commands),
        ).toBe(true);

        const exported = await client.exportHtml(join(dir, "export.html"));
        expect(existsSync(exported)).toBe(true);

        await client.setSessionName("e2e title");
        expect((await client.getState()).sessionName).toBe("e2e title");

        const switched = await client.switchSession(join(sessionDir, "missing.jsonl"));
        expect(typeof switched).toBe("boolean");
      } finally {
        await client.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
