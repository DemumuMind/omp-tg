export type ParseMode = "HTML" | "MarkdownV2";

const MD_SPECIAL = /[_*[\]()~`>#+\-=|{}.!]/;

export function escapeFor(mode: ParseMode, text: string): string {
  if (mode === "HTML") {
    return text
      .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      let run = 0;
      while (text[index + run] === "\\") run += 1;
      const next = text[index + run];
      if (next === undefined) {
        out += "\\".repeat(run + (run % 2));
        index += run;
      } else if (MD_SPECIAL.test(next)) {
        // Even run: n literal backslashes plus an escape. Odd run: already escaped.
        out += "\\".repeat(run) + (run % 2 === 0 ? "\\" : "") + next;
        index += run + 1;
      } else {
        // The sole remainder of an odd run is a literal backslash, so double it.
        out += "\\".repeat(run + (run % 2)) + next;
        index += run + 1;
      }
      continue;
    }
    out += MD_SPECIAL.test(char) ? "\\" + char : char;
    index += 1;
  }
  return out;
}
