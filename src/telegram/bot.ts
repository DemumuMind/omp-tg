import { mkdir } from "node:fs/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import { Bot } from "grammy";
import type { Context } from "grammy";
import { UPLOAD_MAX_BYTES } from "../config/constants.ts";
import type { Config } from "../config/env.ts";
import { OmpClient } from "../omp/client.ts";
import { fetchPhoto } from "../omp/media.ts";
import { SessionManager } from "../omp/session-manager.ts";
import { createLogger, type Logger } from "../utils/logger.ts";
import { escapeFor } from "../utils/escape.ts";
import { KeyedQueue } from "../utils/keyed-queue.ts";
import { authMiddleware, isAllowedUser } from "./auth.ts";
import {
  GATEWAY_COMMANDS,
  type Runtime,
  compilePatterns,
  errorText,
  parseChatIds,
  targetOf,
} from "./gate.ts";
import { handleIncomingFile, mediaError, routeText } from "./handlers.ts";
import { Sender } from "./sender.ts";
import { startHealthServer } from "../health/server.ts";
import { createWatchdog } from "../utils/watchdog.ts";
import { startRetention } from "../utils/retention.ts";

export interface App {
  start(): Promise<void>;
  shutdown(reason: string, code?: number): Promise<void>;
  bot: Bot;
  sessions: SessionManager;
}

export interface ShutdownSteps {
  stopBot: () => Promise<void>;
  stopSessions: () => Promise<void>;
  stopHealth?: () => void;
  stopWatchdog?: () => void;
  stopRetention?: () => void;
  log: Logger;
  exit: (code: number) => void;
}

/** Idempotent shutdown: bot first, then every OMP child, then the process. */
export function makeShutdown(steps: ShutdownSteps): (reason: string, code?: number) => Promise<void> {
  let shutdown: Promise<void> | null = null;
  return (reason, code = 0) => {
    shutdown ??= (async () => {
      await steps.stopBot().catch((error: unknown) => {
        steps.log.warn("shutdown_stop_bot_failed", { message: errorText(error) });
      });
      await steps.stopSessions().catch((error: unknown) => {
        steps.log.warn("shutdown_stop_sessions_failed", { message: errorText(error) });
      });
      steps.stopHealth?.();
      steps.stopRetention?.();
      steps.stopWatchdog?.();
      steps.log.info("shutdown", { reason });
      steps.exit(code);
    })();
    return shutdown;
  };
}

export function installSignalHandlers(app: Pick<App, "shutdown">): void {
  process.on("SIGTERM", () => {
    void app.shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void app.shutdown("SIGINT");
  });
}

interface HealthStateInternal {
  startedAt: number;
  sessions: number;
  updates: number;
  lastUpdateAt: number | null;
}

export function createApp(config: Config): App {
  const log = createLogger(config.LOG_LEVEL);
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(autoRetry());
  const sender = new Sender(bot.api, log);
  const sessions = new SessionManager({
    config,
    sender,
    log,
    createClient: (dir, key, hooks) =>
      new OmpClient({
        bin: config.OMP_BIN,
        cwd: config.OMP_WORKDIR,
        sessionDir: dir,
        spawnMode: config.OMP_SPAWN_MODE,
        scopeLimits: {
          memoryMax: config.OMP_MEMORY_MAX,
          memorySwapMax: config.OMP_MEMORY_SWAP_MAX,
          tasksMax: config.OMP_TASKS_MAX,
          cpuQuota: config.OMP_CPU_QUOTA,
        },
        startTimeoutMs: config.OMP_START_TIMEOUT_MS,
        requestTimeoutMs: config.OMP_REQUEST_TIMEOUT_MS,
        onEvent: hooks.onEvent,
        onUiRequest: hooks.onUiRequest,
        onExit: hooks.onExit,
        log,
      }),
  });

  const healthState: HealthStateInternal = {
    startedAt: Date.now(),
    sessions: 0,
    updates: 0,
    lastUpdateAt: null,
  };
  const health = startHealthServer(
    config.HEALTH_HOST,
    config.HEALTH_PORT,
    () => ({
      startedAt: healthState.startedAt,
      sessions: sessions.size,
      updates: healthState.updates,
      lastUpdateAt: healthState.lastUpdateAt,
    }),
    log,
  );
  const watchdog = createWatchdog(log);
  const retention = startRetention(config, sessions, log);

  const runtime: Runtime = {
    config,
    bot,
    sender,
    sessions,
    log,
    groupAllowed: parseChatIds(config.TELEGRAM_GROUP_ALLOWED_CHATS),
    mentionPatterns: compilePatterns(config.TELEGRAM_MENTION_PATTERNS, log),
    queue: new KeyedQueue(),
  };

  const shutdown = makeShutdown({
    stopBot: () => bot.stop(),
    stopSessions: () => sessions.shutdown(),
    stopHealth: () => health?.stop(),
    stopRetention: () => retention(),
    stopWatchdog: () => watchdog.stop(),
    log,
    exit: (code) => process.exit(code),
  });

  bot.use(async (_ctx, next) => {
    healthState.updates += 1;
    healthState.lastUpdateAt = Date.now();
    await next();
  });
  bot.use(createDedupeMiddleware(log));
  bot.use(authMiddleware(new Set(config.ALLOWED_USER_IDS), log));

  const enqueue = (ctx: Context, task: () => Promise<void>): void => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    void runtime.queue.push(String(chatId), async () => {
      try {
        await task();
      } catch (error) {
        log.error("update_failed", { message: errorText(error) });
        await ctx.reply(`⚠️ ${escapeFor("HTML", errorText(error))}`).catch(() => undefined);
      }
    });
  };

  bot.on("message:text", (ctx) => {
    enqueue(ctx, () => routeText(runtime, ctx, ctx.message.text, []));
  });

  bot.on("message:photo", (ctx) => {
    enqueue(ctx, async () => {
      const target = targetOf(ctx);
      try {
        const image = await fetchPhoto(bot.api, config.TELEGRAM_BOT_TOKEN, ctx.message.photo, UPLOAD_MAX_BYTES);
        await routeText(runtime, ctx, ctx.message.caption ?? "", [image]);
      } catch (error) {
        await sender.sendText(target, mediaError(error));
      }
    });
  });

  bot.on("message:document", (ctx) => {
    enqueue(ctx, () =>
      handleIncomingFile(runtime, ctx, ctx.message.document, "file.bin", "document"),
    );
  });

  bot.on("message:voice", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.voice, "voice.ogg", "voice message"));
  });

  bot.on("message:audio", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.audio, "audio.mp3", "audio file"));
  });

  bot.on("message:video", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.video, "video.mp4", "video file"));
  });

  bot.on("message:video_note", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.video_note, "video-note.mp4", "video note"));
  });

  bot.on("message:animation", (ctx) => {
    enqueue(ctx, () => handleIncomingFile(runtime, ctx, ctx.message.animation, "animation.mp4", "animation"));
  });

  bot.on("inline_query", async (ctx) => {
    const allowed = isAllowedUser(ctx.from.id, new Set(config.ALLOWED_USER_IDS));
    if (!allowed) {
      await ctx.answerInlineQuery([], { cache_time: 0 }).catch(() => undefined);
      return;
    }
    const query = ctx.inlineQuery.query.trim();
    const [head, ...rest] = query.split(/\s+/);
    const needle = (head ?? "").toLowerCase();
    const omp = sessions.cachedCommands().map((command) => ({
      name: command.name,
      description: command.description ?? "Команда OMP",
    }));
    const merged = new Map<string, { name: string; description: string }>();
    for (const command of [...GATEWAY_COMMANDS, ...omp]) {
      if (!merged.has(command.name)) merged.set(command.name, command);
    }
    const catalog = [...merged.values()];
    const filtered = catalog
      .filter(
        (command) =>
          needle === "" ||
          command.name.toLowerCase().includes(needle) ||
          command.description.toLowerCase().includes(needle),
      )
      .slice(0, 50);
    const argument = rest.join(" ");
    // In groups Telegram delivers a bare /command only to admins or with privacy mode off.
    // The bot suffix guarantees delivery and also satisfies the gateway's mention gate.
    const mention =
      ctx.inlineQuery.chat_type !== undefined && ctx.inlineQuery.chat_type !== "private"
        ? `@${runtime.bot.botInfo.username}`
        : "";
    const results = filtered.map((command, index) => ({
      type: "article" as const,
      id: `cmd:${index}:${command.name}`,
      title: `/${command.name}`,
      description: command.description.length > 120 ? `${command.description.slice(0, 119)}…` : command.description,
      input_message_content: {
        message_text: `/${command.name}${mention}${argument === "" ? "" : ` ${argument}`}`,
      },
    }));
    runtime.log.debug("inline_query", {
      userId: ctx.from.id,
      chatType: ctx.inlineQuery.chat_type,
      query,
      results: results.length,
    });
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true }).catch(() => undefined);
  });

  bot.on("callback_query:data", async (ctx) => {
    const target = targetOf(ctx);
    const answer = await sessions.handleCallback(target, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery(answer);
  });

  bot.catch((failure) => {
    log.error("bot_error", { message: errorText(failure.error) });
    void failure.ctx.reply("⚠️ Внутренняя ошибка").catch(() => undefined);
  });

  let started = false;
  return {
    bot,
    sessions,
    async start() {
      if (started) return;
      started = true;
      await mkdir(config.OMP_WORKDIR, { recursive: true });
      await bot.init();
      await registerCommandMenu(runtime);
      void bot
        .start({
          allowed_updates: ["message", "callback_query", "inline_query"],
          drop_pending_updates: config.TELEGRAM_DROP_PENDING_UPDATES,
        })
        .catch((error: unknown) => {
          log.error("polling_failed", { message: errorText(error) });
          void shutdown("polling_failed", 1);
        });
      watchdog.ready();
      log.info("started", { username: bot.botInfo.username });
    },
    shutdown,
  };
}

function createDedupeMiddleware(log: Logger) {
  const seen = new Set<number>();
  const order: number[] = [];
  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const id = ctx.update.update_id;
    if (seen.has(id)) {
      log.debug("duplicate_update", { updateId: id });
      return;
    }
    seen.add(id);
    order.push(id);
    if (order.length > 4096) {
      const oldest = order.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
    await next();
  };
}

async function registerCommandMenu(runtime: Runtime): Promise<void> {
  if (!runtime.config.TELEGRAM_COMMAND_MENU) return;
  const commands = GATEWAY_COMMANDS.map((command) => ({
    command: command.name,
    description: command.description,
  }));
  try {
    await runtime.bot.api.setMyCommands(commands, { scope: { type: "default" } });
  } catch (error) {
    runtime.log.warn("command_menu_failed", { message: errorText(error) });
  }
}
