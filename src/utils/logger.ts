export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEY = /token|secret|authorization|apiKey/i;

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY.test(key) ? "[redacted]" : redact(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = (line) => process.stdout.write(line + "\n")): Logger {
  const threshold = ORDER[level];
  const emit = (entryLevel: LogLevel, event: string, fields?: LogFields): void => {
    if (ORDER[entryLevel] < threshold) return;
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: entryLevel,
      event,
    };
    if (fields) Object.assign(payload, redact(fields) as Record<string, unknown>);
    sink(JSON.stringify(payload));
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
