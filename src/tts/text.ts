/** Turns agent markdown into a short plain-text string suitable for speech. */
export function plainTextForTts(markdown: string, maxChars = 1500): string {
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, " (код в сообщении) ");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  text = text.replace(/[*_~]{1,3}/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n").trim();
  text = text.replace(/\s+/g, " ").trim();
  if (text === "") return "";
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const boundary = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("! "), clipped.lastIndexOf("? "));
  return boundary > maxChars * 0.5 ? clipped.slice(0, boundary + 1) : `${clipped.trimEnd()}…`;
}
