import { stat } from "node:fs/promises";
import type { Context } from "grammy";
import {
  BASH_OUTPUT_LIMIT,
  BASH_TIMEOUT_MS,
  FILE_MAX_BYTES,
  UPLOAD_MAX_BYTES,
} from "../config/constants.ts";
import { fetchFileAttachment, fetchPhoto, MediaDownloadError, MediaTooLargeError } from "../omp/media.ts";
import { escapeFor } from "../utils/escape.ts";
import { transcribeAudio } from "../stt/client.ts";
import { BashTimeoutError, BusyError, type SessionManagerCommand } from "../omp/session-manager.ts";
import type { ImageContent } from "../omp/protocol.ts";
import {
  extractAtPaths,
  isDangerousBash,
  parseBangCommand,
  parseGatewayCommand,
  type GatewayCommand,
} from "./commands.ts";
import { resolveSandboxPath } from "./sandbox.ts";
import { checkForUpdate, formatVersionReport } from "./version.ts";
import type { Target } from "./sender.ts";
import {
  GATEWAY_COMMANDS,
  type Runtime,
  errorText,
  gateGroup,
  replyPrefix,
  senderLabel,
  targetOf,
} from "./gate.ts";

export async function routeText(
  runtime: Runtime,
  ctx: Context,
  raw: string,
  initialImages: ImageContent[] = [],
): Promise<void> {
  let images = initialImages;
  const target = targetOf(ctx);
  const gated = gateGroup(runtime, ctx, raw);
  if (gated === null) return;
  const text = gated.trim();

  const command = parseGatewayCommand(text);
  if (command) {
    await runCommand(runtime, ctx, target, command);
    return;
  }

  const bang = parseBangCommand(text);
  if (bang !== null) {
    await handleBash(runtime, ctx, target, bang);
    return;
  }

  const isGroup = ctx.chat?.type !== "private";
  for (const path of extractAtPaths(text)) {
    const resolved = await resolveSandboxPath(runtime.config, path);
    if (resolved === null) {
      await runtime.sender.sendText(target, "⛔ @path вне рабочего каталога");
      return;
    }
  }

  if (text === "" && images.length === 0) return;

  // Media quoted by the user must reach the agent, not a "[media]" placeholder.
  const replyMedia = await collectReplyMedia(runtime, ctx);
  images = [...images, ...replyMedia.images];

  const prompt = [
    replyPrefix(ctx).trimEnd(),
    `${isGroup ? senderLabel(ctx) : ""}${text}`,
    replyMedia.note,
  ]
    .filter((part) => part !== "")
    .join("\n");
  if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
    void runtime.sender.react(target, ctx.message.message_id, "👀");
  }
  await runtime.sessions.handleText(target, prompt, images, {
    messageId: ctx.message?.message_id,
  });
}

async function collectReplyMedia(
  runtime: Runtime,
  ctx: Context,
): Promise<{ images: ImageContent[]; note: string }> {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return { images: [], note: "" };
  try {
    if (reply.photo) {
      const image = await fetchPhoto(runtime.bot.api, runtime.config.TELEGRAM_BOT_TOKEN, reply.photo, UPLOAD_MAX_BYTES);
      return { images: [image], note: "" };
    }
    const file =
      reply.document ? { msg: reply.document, fallback: "file.bin", label: "document" } :
      reply.voice ? { msg: reply.voice, fallback: "voice.ogg", label: "voice message" } :
      reply.audio ? { msg: reply.audio, fallback: "audio.mp3", label: "audio file" } :
      reply.video ? { msg: reply.video, fallback: "video.mp4", label: "video file" } :
      reply.video_note ? { msg: reply.video_note, fallback: "video-note.mp4", label: "video note" } :
      reply.animation ? { msg: reply.animation, fallback: "animation.mp4", label: "animation" } :
      reply.sticker ? { msg: reply.sticker, fallback: "sticker.webp", label: "sticker" } :
      null;
    if (!file) {
      // Reply to something textless we do not model (poll, contact, dice…): say so.
      const textless = !reply.text && !reply.caption;
      if (textless) runtime.log.info("reply_media_unrecognized", { keys: Object.keys(reply).slice(0, 20) });
      return { images: [], note: "" };
    }
    const target = targetOf(ctx);
    const uploadDir = await runtime.sessions.uploadDirFor(target);
    const path = await fetchFileAttachment(
      runtime.bot.api,
      runtime.config.TELEGRAM_BOT_TOKEN,
      file.msg,
      uploadDir,
      UPLOAD_MAX_BYTES,
      file.fallback,
    );
    const attachment = await describeAttachment(runtime, path, file.label);
    return { images: [], note: attachment.note };
  } catch (error) {
    runtime.log.warn("reply_media_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return { images: [], note: "" };
  }
}

export async function handleIncomingFile(
  runtime: Runtime,
  ctx: Context,
  file: { file_id: string; file_name?: string; file_size?: number },
  fallbackName: string,
  label: string,
): Promise<void> {
  const target = targetOf(ctx);
  const caption = ctx.message?.caption ?? "";
  const gated = gateGroup(runtime, ctx, caption);
  if (gated === null) return;
  try {
    const uploadDir = await runtime.sessions.uploadDirFor(target);
    const path = await fetchFileAttachment(
      runtime.bot.api,
      runtime.config.TELEGRAM_BOT_TOKEN,
      file,
      uploadDir,
      UPLOAD_MAX_BYTES,
      fallbackName,
    );
    const isGroup = ctx.chat?.type !== "private";
    const body = gated.trim();
    if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
      void runtime.sender.react(target, ctx.message.message_id, "👀");
    }
    const attachment = await describeAttachment(runtime, path, label);
    const prompt = [
      replyPrefix(ctx).trimEnd(),
      `${isGroup ? senderLabel(ctx) : ""}${body}`,
      attachment.note,
    ]
      .filter((line) => line !== "")
      .join("\n");
    await runtime.sessions.handleText(target, prompt, [], {
      messageId: ctx.message?.message_id,
      voiceReply: attachment.transcribed,
    });
  } catch (error) {
    await runtime.sender.sendText(target, mediaError(error));
  }
}

async function describeAttachment(
  runtime: Runtime,
  path: string,
  label: string,
): Promise<{ note: string; transcribed: boolean }> {
  const canTranscribe = runtime.config.STT_ENABLED && (label === "voice message" || label === "audio file");
  if (canTranscribe) {
    try {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      const text = await transcribeAudio({
        url: runtime.config.STT_URL,
        bytes,
        fileName: path.split("/").pop() ?? "audio.ogg",
        language: runtime.config.STT_LANGUAGE || undefined,
        timeoutMs: runtime.config.STT_TIMEOUT_MS,
      });
      if (text !== null) return { note: `[${label} transcript]: ${text}`, transcribed: true };
    } catch {
      // fall back to the raw path below
    }
  }
  return { note: `[${label}: ${path}]`, transcribed: false };
}

async function runCommand(runtime: Runtime, ctx: Context, target: Target, command: GatewayCommand): Promise<void> {
  switch (command.kind) {
    case "start":
    case "help":
      await runtime.sender.sendText(target, helpText(target, ctx.from?.id));
      return;
    case "id":
      await runtime.sender.sendText(
        target,
        [
          `chat_id: <code>${target.chatId}</code>`,
          `thread_id: <code>${target.messageThreadId ?? "—"}</code>`,
          `user_id: <code>${ctx.from?.id ?? "—"}</code>`,
        ].join("\n"),
      );
      return;
    case "whoami":
      await runtime.sender.sendText(
        target,
        [
          `<b>user:</b> <code>${ctx.from?.id ?? "—"}</code> (${escapeFor("HTML", ctx.from?.username ?? ctx.from?.first_name ?? "—")})`,
          `<b>chat:</b> <code>${target.chatId}</code> (${ctx.chat?.type ?? "—"})`,
          `<b>thread:</b> <code>${target.messageThreadId ?? "—"}</code>`,
          `<b>bot:</b> @${escapeFor("HTML", runtime.bot.botInfo.username)}`,
          `<b>доступ:</b> allowlist`,
        ].join("\n"),
      );
      return;
    case "commands":
      await sendCommandList(runtime, target);
      return;
    case "file":
      await handleFile(runtime, target, command.path);
      return;
    case "retry":
      await runtime.sessions.retry(target);
      return;
    case "voice":
      await runtime.sessions.toggleVoice(target);
      return;
    case "ping":
      await runtime.sessions.ping(target);
      return;
    case "version":
      await runtime.sender.sendText(target, formatVersionReport(await checkForUpdate()));
      return;
    case "digest":
      await handleDigest(runtime, target, command.argument);
      return;
    case "usage":
    case "model":
    case "export":
    case "sessions":
    case "title":
    case "resume":
    case "new":
    case "abort":
    case "status":
    case "cancel":
      await runtime.sessions.handleCommand(target, command as SessionManagerCommand);
      return;
  }
}

async function sendCommandList(runtime: Runtime, target: Target): Promise<void> {
  const lines = ["<b>Шлюз</b>"];
  for (const command of GATEWAY_COMMANDS) {
    lines.push(`/<code>${command.name}</code> — ${command.description}`);
  }

  const omp = await runtime.sessions.listCommands(target);
  lines.push("", "<b>OMP</b>");
  if (omp.length === 0) {
    lines.push("<i>Сессия не запущена — команды OMP появятся после первого сообщения.</i>");
  } else {
    for (const entry of omp.slice(0, 60)) {
      lines.push(`/<code>${escapeFor("HTML", entry.name)}</code>${entry.description ? ` — ${escapeFor("HTML", entry.description)}` : ""}`);
    }
  }
  await runtime.sender.sendText(target, lines.join("\n"));
}

async function handleBash(runtime: Runtime, ctx: Context, target: Target, command: string): Promise<void> {
  if (isDangerousBash(command)) {
    await runtime.sender.sendText(target, "⛔ Команда заблокирована");
    return;
  }
  if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
    void runtime.sender.react(target, ctx.message.message_id, "👀");
  }
  let ok = false;
  try {
    const result = await runtime.sessions.runBash(target, command, BASH_TIMEOUT_MS);
    ok = true;
    if (result.images && result.images.length > 0) {
      await runtime.sender.deliverFinal(target, "", result.images);
    }
    const status = result.timedOut ? "таймаут" : result.cancelled ? "отменено" : `exit ${result.exitCode ?? "?"}`;
    const output = truncateUtf8(result.output, BASH_OUTPUT_LIMIT);
    await runtime.sender.sendText(
      target,
      `<pre>${escapeFor("HTML", output === "" ? "(нет вывода)" : output)}</pre>\n<code>${status}</code>`,
    );
  } catch (error) {
    if (error instanceof BashTimeoutError) {
      await runtime.sender.sendText(target, "⌛ Таймаут 30 с");
    } else if (error instanceof BusyError) {
      await runtime.sender.sendText(target, "⏳ Все сессии заняты, попробуйте позже");
    } else {
      await runtime.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
    }
  } finally {
    if (runtime.config.TELEGRAM_REACTIONS && ctx.message) {
      void runtime.sender.react(target, ctx.message.message_id, ok ? "👍" : "👎");
    }
  }
}

async function handleFile(runtime: Runtime, target: Target, argument: string): Promise<void> {
  if (argument === "") {
    await runtime.sender.sendText(target, "Использование: <code>/file &lt;path&gt;</code>");
    return;
  }
  const actual = await resolveSandboxPath(runtime.config, argument);
  if (actual === null) {
    await runtime.sender.sendText(target, "⛔ Файл вне рабочего каталога");
    return;
  }
  try {
    const info = await stat(actual);
    if (!info.isFile()) {
      await runtime.sender.sendText(target, "⛔ Это не файл");
      return;
    }
    if (info.size > FILE_MAX_BYTES) {
      await runtime.sender.sendText(target, "⛔ Файл больше 50 MB");
      return;
    }
    await runtime.sender.sendAttachment(target, actual);
  } catch (error) {
    await runtime.sender.sendText(target, `⚠️ ${escapeFor("HTML", errorText(error))}`);
  }
}

function truncateUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder().decode(bytes.subarray(0, limit)) + "\n…[обрезано]";
}

export function mediaError(error: unknown): string {
  if (error instanceof MediaTooLargeError) return "⛔ Файл больше 20 MB";
  if (error instanceof MediaDownloadError) return `⚠️ ${escapeFor("HTML", error.message)}`;
  return `⚠️ ${escapeFor("HTML", errorText(error))}`;
}

async function handleDigest(runtime: Runtime, target: Target, argument: string): Promise<void> {
  const arg = argument.trim();
  if (arg === "off") await runtime.digest.remove(target);
  else if (arg === "") await runtime.digest.describe(target);
  else await runtime.digest.set(target, arg);
}

function helpText(target: Target, userId: number | undefined): string {
  return [
    "<b>omp-tg</b> — Telegram-шлюз OMP.",
    "Обычное сообщение — запрос агенту; голос, аудио, видео и документы уходят как файл.",
    "<code>!cmd</code> — выполнить bash через OMP.",
    "<code>@path</code> — передать файл из рабочего каталога.",
    "<code>MEDIA:/path</code> в ответе агента — отправить вложение автоматически.",
    "<code>/new</code> — новая сессия, <code>/stop</code> — остановить, <code>/status</code> — состояние.",
    "<code>/model</code> — выбрать модель, <code>/usage</code> — токены и стоимость.",
    "<code>/commands</code> — команды OMP, <code>/whoami</code> — ID и доступ.",
    "<code>/file &lt;path&gt;</code> — отправить файл, <code>/cancel</code> — закрыть диалог.",
    "<code>/retry</code> — переспросить последнее, <code>/voice</code> — голосовые ответы, <code>/ping</code> — замер модели.",
    "<code>/digest HH:MM &lt;промпт&gt;</code> — ежедневный дайджест, <code>/version</code> — версия.",
    `<code>/id</code> — chat_id, thread_id, user_id (${target.chatId}, ${target.messageThreadId ?? "main"}, ${userId ?? "—"}).`,
  ].join("\n");
}
