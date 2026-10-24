import { z } from "zod";
import { MIN_EDIT_INTERVAL_MS } from "./constants.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const boolString = (fallback: boolean) =>
  z
    .string()
    .default(fallback ? "true" : "false")
    .transform((value) => value === "1" || value.toLowerCase() === "true");

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  OMP_ENDPOINT: z
    .string()
    .default("spawn")
    .refine((value): value is "spawn" => value === "spawn", { message: "only spawn transport is supported" }),
  ALLOWED_USER_IDS: z
    .string()
    .min(1)
    .transform((raw, ctx) => {
      const ids: number[] = [];
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (trimmed === "") continue;
        const value = Number(trimmed);
        if (!Number.isSafeInteger(value)) {
          ctx.addIssue({ code: "custom", message: `not an integer user id: ${trimmed}` });
          return z.NEVER;
        }
        ids.push(value);
      }
      if (ids.length === 0) {
        ctx.addIssue({ code: "custom", message: "at least one user id is required" });
        return z.NEVER;
      }
      return ids;
    }),
  IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  THROTTLE_MS: z.coerce.number().int().min(MIN_EDIT_INTERVAL_MS).default(MIN_EDIT_INTERVAL_MS),
  OMP_BIN: z.string().min(1).default("/home/omp/.local/bin/omp"),
  OMP_WORKDIR: z.string().min(1).default("/home/omp/workspace"),
  OMP_SESSION_ROOT: z.string().min(1).default("/home/omp/.omp/tg-sessions"),
  OMP_UPLOAD_DIR: z.string().min(1).optional(),
  OMP_SPAWN_MODE: z.enum(["direct", "systemd-user-scope"]).default("direct"),
  OMP_THINKING: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).optional(),
  OMP_MEMORY_MAX: z.string().regex(/^\d+(?:\.\d+)?[KMGT]?$/, "expected a systemd size like 1G").default("1G"),
  OMP_MEMORY_SWAP_MAX: z.string().regex(/^\d+(?:\.\d+)?[KMGT]?$/, "expected a systemd size like 512M").default("256M"),
  OMP_TASKS_MAX: z.coerce.number().int().positive().default(512),
  OMP_CPU_QUOTA: z.string().regex(/^\d+%$/, "expected a CPU quota like 200%").default("200%"),
  MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(32).default(4),
  OMP_START_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  OMP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HEALTH_HOST: z.string().default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8766),
  RETENTION_UPLOAD_DAYS: z.coerce.number().int().min(0).default(14),
  RETENTION_EXPORT_DAYS: z.coerce.number().int().min(0).default(14),
  SESSION_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  TELEGRAM_REQUIRE_MENTION: boolString(false),
  TELEGRAM_MENTION_PATTERNS: z.string().default(""),
  TELEGRAM_GROUP_ALLOWED_CHATS: z.string().default(""),
  TELEGRAM_REACTIONS: boolString(true),
  TELEGRAM_DROP_PENDING_UPDATES: boolString(true),
  TELEGRAM_SILENT_PROGRESS: boolString(true),
  TELEGRAM_KEEP_PROGRESS: boolString(true),
  TELEGRAM_COMMAND_MENU: boolString(true),
  STT_ENABLED: boolString(false),
  STT_URL: z.string().default("http://127.0.0.1:8765"),
  STT_LANGUAGE: z.string().default(""),
  STT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TTS_ENABLED: boolString(false),
  TTS_URL: z.string().default("http://127.0.0.1:8767"),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TTS_MAX_CHARS: z.coerce.number().int().min(100).max(4000).default(1500),
});

export interface Config {
  TELEGRAM_BOT_TOKEN: string;
  OMP_ENDPOINT: "spawn";
  ALLOWED_USER_IDS: number[];
  IDLE_TIMEOUT_MS: number;
  THROTTLE_MS: number;
  OMP_BIN: string;
  OMP_WORKDIR: string;
  OMP_SESSION_ROOT: string;
  OMP_UPLOAD_DIR: string;
  OMP_SPAWN_MODE: "direct" | "systemd-user-scope";
  OMP_THINKING?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
  OMP_MEMORY_MAX: string;
  OMP_MEMORY_SWAP_MAX: string;
  OMP_TASKS_MAX: number;
  OMP_CPU_QUOTA: string;
  MAX_ACTIVE_SESSIONS: number;
  OMP_START_TIMEOUT_MS: number;
  OMP_REQUEST_TIMEOUT_MS: number;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  HEALTH_HOST: string;
  HEALTH_PORT: number;
  RETENTION_UPLOAD_DAYS: number;
  RETENTION_EXPORT_DAYS: number;
  SESSION_RETENTION_DAYS: number;
  TELEGRAM_REQUIRE_MENTION: boolean;
  TELEGRAM_MENTION_PATTERNS: string;
  TELEGRAM_GROUP_ALLOWED_CHATS: string;
  TELEGRAM_REACTIONS: boolean;
  TELEGRAM_DROP_PENDING_UPDATES: boolean;
  TELEGRAM_SILENT_PROGRESS: boolean;
  TELEGRAM_KEEP_PROGRESS: boolean;
  TELEGRAM_COMMAND_MENU: boolean;
  STT_ENABLED: boolean;
  STT_URL: string;
  STT_LANGUAGE: string;
  STT_TIMEOUT_MS: number;
  TTS_ENABLED: boolean;
  TTS_URL: string;
  TTS_TIMEOUT_MS: number;
  TTS_MAX_CHARS: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(message);
  }
  const data = result.data;
  return {
    ...data,
    OMP_UPLOAD_DIR: data.OMP_UPLOAD_DIR ?? `${data.OMP_WORKDIR}/.omp-tg-uploads`,
  };
}
