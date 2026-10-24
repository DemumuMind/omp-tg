import type { Bot, Context } from "grammy";
import type { Config } from "../config/env.ts";
import type { SessionManager } from "../omp/session-manager.ts";
import type { Logger } from "../utils/logger.ts";
import type { KeyedQueue } from "../utils/keyed-queue.ts";
import type { Sender, Target } from "./sender.ts";
import type { DigestController } from "./digest.ts";

export interface Runtime {
  config: Config;
  bot: Bot;
  sender: Sender;
  sessions: SessionManager;
  log: Logger;
  groupAllowed: Set<number>;
  mentionPatterns: RegExp[];
  queue: KeyedQueue;
  digest: DigestController;
}

export const GATEWAY_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "help", description: "Справка" },
  { name: "new", description: "Новая сессия" },
  { name: "stop", description: "Остановить задачу" },
  { name: "status", description: "Состояние сессии" },
  { name: "model", description: "Выбрать модель" },
  { name: "usage", description: "Токены и стоимость" },
  { name: "commands", description: "Команды OMP" },
  { name: "whoami", description: "Мои ID и доступ" },
  { name: "export", description: "Экспорт сессии в HTML" },
  { name: "sessions", description: "Список сессий" },
  { name: "title", description: "Название сессии" },
  { name: "resume", description: "Восстановить сессию" },
  { name: "file", description: "Отправить файл" },
  { name: "cancel", description: "Закрыть диалог" },
  { name: "retry", description: "Переспросить последнее" },
  { name: "voice", description: "Голосовые ответы вкл/выкл" },
  { name: "ping", description: "Замер задержки модели" },
  { name: "version", description: "Версия и обновления" },
  { name: "digest", description: "Расписание дайджестов" },
];

export function parseChatIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const value = Number(trimmed);
    if (Number.isSafeInteger(value)) ids.add(value);
  }
  return ids;
}

export function compilePatterns(raw: string, log: Logger): RegExp[] {
  const patterns: RegExp[] = [];
  for (const part of raw.split(",")) {
    const source = part.trim();
    if (source === "") continue;
    try {
      patterns.push(new RegExp(source, "i"));
    } catch {
      log.warn("bad_mention_pattern", { pattern: source });
    }
  }
  return patterns;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function gateGroup(runtime: Runtime, ctx: Context, raw: string): string | null {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return raw;

  if (runtime.groupAllowed.size > 0 && !runtime.groupAllowed.has(chat.id)) {
    runtime.log.debug("group_not_allowed", { chatId: chat.id });
    return null;
  }
  if (!runtime.config.TELEGRAM_REQUIRE_MENTION) return raw;

  const username = runtime.bot.botInfo.username.toLowerCase();
  const replied = ctx.message?.reply_to_message?.from?.id === runtime.bot.botInfo.id;
  const mentioned = raw.toLowerCase().includes(`@${username}`);
  const patterned = runtime.mentionPatterns.some((pattern) => pattern.test(raw));
  if (!replied && !mentioned && !patterned) {
    runtime.log.debug("group_ignored", { chatId: chat.id });
    return null;
  }
  return raw
    .replace(new RegExp(`@${escapeRegex(username)}`, "gi"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function targetOf(ctx: Context): Target {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error("update has no chat");
  const thread = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  const chatType = ctx.chat?.type ?? ctx.callbackQuery?.message?.chat.type;
  const userId = chatType !== "private" ? ctx.from?.id : undefined;
  return {
    chatId,
    ...(thread === undefined ? {} : { messageThreadId: thread }),
    ...(userId === undefined ? {} : { userId }),
  };
}

export function replyPrefix(ctx: Context): string {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return "";
  const author = reply.from?.is_bot
    ? `bot @${reply.from.username ?? "bot"}`
    : `${reply.from?.first_name ?? "user"}${reply.from?.id === undefined ? "" : `|${reply.from.id}`}`;
  const body = (reply.text ?? reply.caption ?? "[media]").replace(/\s+/g, " ").trim();
  const clipped = body.length > 300 ? `${body.slice(0, 299)}…` : body;
  return `[reply to ${author}: "${clipped}"]\n`;
}

export function senderLabel(ctx: Context): string {
  const name = ctx.from?.first_name ?? ctx.from?.username ?? "user";
  return `[${name}|${ctx.from?.id ?? "?"}] `;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
