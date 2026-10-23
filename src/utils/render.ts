import { escapeFor } from "./escape.ts";

const FENCE = /```([A-Za-z0-9_+-]*)[ \t]*\n([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)"'<>]+|tg:\/\/[^\s)"'<>]+)\)/g;
const BOLD_STAR = /\*\*([^*\n]+)\*\*/g;
const BOLD_UNDER = /__([^_\n]+)__/g;
const STRIKE = /~~([^~\n]+)~~/g;
const ITALIC_STAR = /(^|[^*])\*([^*\n]+)\*/g;
const ITALIC_UNDER = /(^|[^_\w])_([^_\n]+)_(?!\w)/g;
const HEADING = /^(#{1,6})[ \t]+(.+)$/gm;
const BULLET = /^[ \t]*[-*+][ \t]+/gm;

function validLinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "tg:";
  } catch {
    return false;
  }
}

/**
 * Renders accumulated markdown into Telegram-safe HTML for the transient streaming
 * message. The final answer goes through sendRichMessage instead.
 */
export function renderStreamingHtml(markdown: string): string {
  const fences: string[] = [];
  const inline: string[] = [];
  const source = markdown.replace(/\r\n/g, "\n").replace(/[\u0000\u0001]/g, "");

  const withoutFences = source.replace(FENCE, (_match, lang: string, code: string) => {
    const cls = lang.length > 0 ? ` class="language-${lang}"` : "";
    fences.push(`<pre><code${cls}>${escapeFor("HTML", code)}</code></pre>`);
    return `\u0000${fences.length - 1}\u0000`;
  });

  let out = escapeFor("HTML", withoutFences);
  out = out.replace(INLINE_CODE, (_match, code: string) => {
    inline.push(`<code>${code}</code>`);
    return `\u0001${inline.length - 1}\u0001`;
  });
  out = out.replace(LINK, (match, label: string, url: string) => {
    if (!validLinkUrl(url)) return match;
    return `<a href="${url.replace(/"/g, "%22")}">${label}</a>`;
  });
  out = out.replace(BOLD_STAR, "<b>$1</b>").replace(BOLD_UNDER, "<b>$1</b>");
  out = out.replace(STRIKE, "<s>$1</s>");
  out = out.replace(ITALIC_STAR, "$1<i>$2</i>").replace(ITALIC_UNDER, "$1<i>$2</i>");
  out = out.replace(HEADING, "<b>$2</b>").replace(BULLET, "\u2022 ");
  out = out.replace(/\n{3,}/g, "\n\n");

  out = out.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => inline[Number(index)] ?? "");
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => fences[Number(index)] ?? "");
  return out;
}
