export type GatewayCommand =
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "new" }
  | { kind: "abort" }
  | { kind: "status" }
  | { kind: "id" }
  | { kind: "cancel" }
  | { kind: "usage" }
  | { kind: "model"; query: string }
  | { kind: "commands" }
  | { kind: "whoami" }
  | { kind: "export" }
  | { kind: "sessions" }
  | { kind: "title"; name: string }
  | { kind: "resume"; target: string }
  | { kind: "file"; path: string };

const COMMANDS: Record<string, true> = {
  start: true,
  help: true,
  new: true,
  abort: true,
  status: true,
  id: true,
  cancel: true,
  stop: true,
  usage: true,
  model: true,
  commands: true,
  whoami: true,
  export: true,
  sessions: true,
  title: true,
  resume: true,
  file: true,
};

export function parseGatewayCommand(text: string): GatewayCommand | null {
  if (!text.startsWith("/")) return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  if (COMMANDS[name] !== true) return null;
  const argument = (match[2] ?? "").trim();
  switch (name) {
    case "start":
      return { kind: "start" };
    case "help":
      return { kind: "help" };
    case "new":
      return { kind: "new" };
    case "abort":
    case "stop":
      return { kind: "abort" };
    case "status":
      return { kind: "status" };
    case "id":
      return { kind: "id" };
    case "cancel":
      return { kind: "cancel" };
    case "usage":
      return { kind: "usage" };
    case "model":
      return { kind: "model", query: argument };
    case "commands":
      return { kind: "commands" };
    case "whoami":
      return { kind: "whoami" };
    case "export":
      return { kind: "export" };
    case "sessions":
      return { kind: "sessions" };
    case "title":
      return { kind: "title", name: argument };
    case "resume":
      return { kind: "resume", target: argument };
    case "file":
      return { kind: "file", path: argument };
    default:
      return null;
  }
}

export function parseBangCommand(text: string): string | null {
  if (!text.startsWith("!")) return null;
  const command = text.slice(1).trim();
  return command === "" ? null : command;
}

/** @-tokens that look like filesystem paths; bare mentions are excluded. */
export function extractAtPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/(^|\s)@([^\s]+)/g)) {
    const token = match[2]!;
    if (token.startsWith("./") || token.startsWith("../") || token.startsWith("/") || token.includes("/")) {
      paths.push(token);
    }
  }
  return paths;
}

const DANGEROUS = [
  /(^|\s)rm\s+(-[A-Za-z]*[rf][A-Za-z]*\s+)+(\/|~|\*|\.{1,2})(\s|$)/,
  /(^|\s)mkfs(\.\w+)?\s/,
  /(^|\s)dd\s+[^|]*of=\/dev\//,
  /(^|\s)(shutdown|reboot|poweroff|halt)\b/,
  /(^|\s):\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /(^|\s)chmod\s+-R\s+777\s+\/(\s|$)/,
  /(^|\s)>\s*\/dev\/sd[a-z]/,
];

export function isDangerousBash(command: string): boolean {
  return DANGEROUS.some((pattern) => pattern.test(command));
}
