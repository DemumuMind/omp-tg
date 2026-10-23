import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/env.ts";
import type { SessionManager } from "../omp/session-manager.ts";
import type { Logger } from "./logger.ts";

export interface CleanupOptions {
  extensions?: Set<string>;
  preserve?: Set<string>;
}

/** Deletes regular files older than maxAgeMs. Returns the removed count. */
export async function cleanupDirectory(
  dir: string,
  maxAgeMs: number,
  now: number,
  options: CleanupOptions = {},
): Promise<number> {
  if (maxAgeMs <= 0) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (options.extensions && !options.extensions.has(entry.name.split(".").pop()?.toLowerCase() ?? "")) continue;
    const path = join(dir, entry.name);
    if (options.preserve?.has(path)) continue;
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      // file disappeared between readdir and stat
    }
  }
  return removed;
}

const DAY = 24 * 60 * 60 * 1000;
const HTML = new Set(["html"]);

async function sweep(config: Config, sessions: SessionManager, log: Logger): Promise<void> {
  const now = Date.now();
  const uploads = await cleanupDirectory(config.OMP_UPLOAD_DIR, config.RETENTION_UPLOAD_DAYS * DAY, now);
  const exports = await cleanupDirectory(
    `${config.OMP_WORKDIR}/.omp-tg-exports`,
    config.RETENTION_EXPORT_DAYS * DAY,
    now,
    { extensions: HTML },
  );
  let sessionFiles = 0;
  if (config.SESSION_RETENTION_DAYS > 0) {
    const active = sessions.activeDirs();
    let dirs: string[] = [];
    try {
      dirs = (await readdir(config.OMP_SESSION_ROOT, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(config.OMP_SESSION_ROOT, entry.name));
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      if (active.has(dir)) continue;
      sessionFiles += await cleanupDirectory(dir, config.SESSION_RETENTION_DAYS * DAY, now, {
        extensions: new Set(["jsonl"]),
      });
    }
  }
  if (uploads + exports + sessionFiles > 0) {
    log.info("retention_swept", { uploads, exports, sessionFiles });
  }
}

/** Periodic cleanup of uploads, HTML exports and (optionally) old session files. */
export function startRetention(
  config: Config,
  sessions: SessionManager,
  log: Logger,
  intervalMs = DAY,
): () => void {
  const run = (): void => {
    void sweep(config, sessions, log).catch((error: unknown) => {
      log.warn("retention_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 10_000).unref?.();
  return () => clearInterval(timer);
}
