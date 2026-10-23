import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Config } from "../config/env.ts";

export function inside(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  return path === normalizedRoot || path.startsWith(normalizedRoot + sep);
}

/**
 * Resolves a user- or agent-supplied path and confirms it stays inside the agent's
 * workspace (or the upload directory). Symlinks are resolved when the file exists.
 */
export async function resolveSandboxPath(config: Config, candidate: string): Promise<string | null> {
  const resolved = resolve(config.OMP_WORKDIR, candidate);
  let actual = resolved;
  try {
    actual = await realpath(resolved);
  } catch {
    // Missing paths are judged by their lexical location; the caller decides whether that is fatal.
  }
  if (inside(actual, config.OMP_WORKDIR) || inside(actual, config.OMP_UPLOAD_DIR)) return actual;
  return null;
}
