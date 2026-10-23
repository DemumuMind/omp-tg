const MEDIA_LINE = /^[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$/gm;

export interface MediaExtraction {
  text: string;
  paths: string[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extracts `MEDIA:/path` lines from an agent reply. Hermes-compatible: each tag becomes
 * a native attachment and is removed from the visible text.
 */
export function extractMediaTags(markdown: string): MediaExtraction {
  const paths: string[] = [];
  const text = markdown.replace(MEDIA_LINE, (_line, raw: string) => {
    const path = unquote(raw);
    if (path !== "" && !paths.includes(path)) paths.push(path);
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), paths };
}

/** Removes media tags for the transient streaming preview. */
export function stripMediaTags(markdown: string): string {
  return extractMediaTags(markdown).text;
}
