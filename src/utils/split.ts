import type { ParseMode } from "./escape.ts";
import { htmlTokens } from "./visible.ts";

interface OpenTag {
  name: string;
  raw: string;
}

export function splitVisible(text: string, limit: number, mode: ParseMode): string[] {
  if (text.length === 0 || limit <= 0) return [];
  return mode === "MarkdownV2" ? splitMarkdown(text, limit) : splitHtml(text, limit);
}

export function truncateVisible(text: string, limit: number, mode: ParseMode): string {
  return splitVisible(text, limit, mode)[0] ?? "";
}

function splitHtml(text: string, limit: number): string[] {
  const chunks: string[] = [];
  const stack: OpenTag[] = [];
  let current = "";
  let used = 0;
  let hasVisible = false;

  const closers = (): string => stack
    .slice()
    .reverse()
    .map((tag) => `</${tag.name}>`)
    .join("");

  const flush = (): void => {
    if (!hasVisible) return;
    chunks.push(current + closers());
    current = stack.map((tag) => tag.raw).join("");
    used = 0;
    hasVisible = false;
  };

  for (const token of htmlTokens(text)) {
    if (token.visible > 0 && used + token.visible > limit) flush();
    current += token.raw;
    used += token.visible;
    if (token.visible > 0) hasVisible = true;

    if (token.kind === "open") {
      stack.push({ name: token.name!, raw: token.raw });
    } else if (token.kind === "close") {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.name === token.name) {
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  if (hasVisible) chunks.push(current + closers());
  return chunks;
}

function splitMarkdown(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let used = 0;
  let spoiler = false;

  const flush = (): void => {
    if (used === 0) return;
    chunks.push(current + (spoiler ? "||" : ""));
    current = spoiler ? "||" : "";
    used = 0;
  };

  for (let i = 0; i < text.length; ) {
    if (text.startsWith("||", i)) {
      spoiler = !spoiler;
      current += "||";
      i += 2;
      continue;
    }
    let raw: string;
    let visible: number;
    if (text[i] === "\\" && i + 1 < text.length) {
      raw = text.slice(i, i + 2);
      visible = 1;
      i += 2;
    } else {
      const cp = text.codePointAt(i)!;
      raw = String.fromCodePoint(cp);
      visible = raw.length;
      i += raw.length;
    }

    if (visible > 0 && used + visible > limit) flush();
    current += raw;
    used += visible;
  }

  if (used > 0) chunks.push(current + (spoiler ? "||" : ""));
  return chunks;
}
