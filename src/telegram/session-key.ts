import { createHash } from "node:crypto";

export function sessionKey(chatId: number, messageThreadId?: number, userId?: number): string {
  const base = `${chatId}:${messageThreadId ?? "main"}`;
  return userId === undefined ? base : `${base}:${userId}`;
}

export function sessionDir(root: string, key: string): string {
  return `${root}/${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}
