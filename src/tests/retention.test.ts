import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupDirectory } from "../utils/retention.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-retention-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("removes only files older than the cutoff", async () => {
  const dir = await tempDir();
  const old = join(dir, "old.bin");
  const fresh = join(dir, "fresh.bin");
  await writeFile(old, "old");
  await writeFile(fresh, "new");
  const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(old, oldTime, oldTime);

  const removed = await cleanupDirectory(dir, 5 * 24 * 60 * 60 * 1000, Date.now());
  expect(removed).toBe(1);
  expect(await readdir(dir)).toEqual(["fresh.bin"]);
});

test("honours extension and preserve filters", async () => {
  const dir = await tempDir();
  const html = join(dir, "a.html");
  const jsonl = join(dir, "a.jsonl");
  const kept = join(dir, "b.html");
  await Promise.all([writeFile(html, "x"), writeFile(jsonl, "x"), writeFile(kept, "x")]);
  const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await Promise.all([utimes(html, oldTime, oldTime), utimes(jsonl, oldTime, oldTime), utimes(kept, oldTime, oldTime)]);

  const removed = await cleanupDirectory(dir, 24 * 60 * 60 * 1000, Date.now(), {
    extensions: new Set(["html"]),
    preserve: new Set([kept]),
  });
  expect(removed).toBe(1);
  expect((await readdir(dir)).sort()).toEqual(["a.jsonl", "b.html"]);
});

test("disabled retention is a no-op", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "x"), "x");
  expect(await cleanupDirectory(dir, 0, Date.now())).toBe(0);
});
