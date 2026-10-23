import type { ParseMode } from "./escape.ts";

const HTML_TAG = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/;
const HTML_ENTITY = /^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;

export function visibleLength(text: string, mode: ParseMode): number {
  if (mode === "MarkdownV2") {
    let count = 0;
    for (let i = 0; i < text.length; ) {
      if (text[i] === "\\" && i + 1 < text.length) {
        count += 1;
        i += 2;
      } else {
        count += 1;
        i += 1;
      }
    }
    return count;
  }

  let count = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "<") {
      const tag = HTML_TAG.exec(text.slice(i));
      if (tag) {
        i += tag[0].length;
        continue;
      }
    }
    if (text[i] === "&") {
      const entity = HTML_ENTITY.exec(text.slice(i));
      if (entity) {
        count += 1;
        i += entity[0].length;
        continue;
      }
    }
    count += 1;
    i += 1;
  }
  return count;
}

export interface HtmlToken {
  raw: string;
  visible: number;
  kind: "open" | "close" | "self" | "text";
  name?: string;
}

export function htmlTokens(text: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === "<") {
      const match = HTML_TAG.exec(text.slice(i));
      if (match) {
        const raw = match[0];
        const name = match[1]!.toLowerCase();
        const kind: HtmlToken["kind"] = raw.startsWith("</") ? "close" : /\/>$/.test(raw) ? "self" : "open";
        tokens.push({ raw, visible: 0, kind, name });
        i += raw.length;
        continue;
      }
    }
    if (text[i] === "&") {
      const match = HTML_ENTITY.exec(text.slice(i));
      if (match) {
        tokens.push({ raw: match[0], visible: 1, kind: "text" });
        i += match[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const raw = String.fromCodePoint(cp);
    tokens.push({ raw, visible: raw.length, kind: "text" });
    i += raw.length;
  }
  return tokens;
}

