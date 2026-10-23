import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Api } from "grammy";
import type { PhotoSize } from "grammy/types";
import type { ImageContent } from "../omp/protocol.ts";

export class MediaTooLargeError extends Error {
  constructor(limit: number) {
    super(`file exceeds ${limit} bytes`);
    this.name = "MediaTooLargeError";
  }
}

export class MediaDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaDownloadError";
  }
}

async function download(
  api: Api,
  token: string,
  fileId: string,
  limit: number,
  declaredSize?: number,
): Promise<{ bytes: Uint8Array; filePath: string }> {
  if (declaredSize !== undefined && declaredSize > limit) throw new MediaTooLargeError(limit);
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new MediaDownloadError("Telegram returned no file_path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new MediaDownloadError(`download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > limit) throw new MediaTooLargeError(limit);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new MediaTooLargeError(limit);
  return { bytes, filePath: file.file_path };
}

export async function fetchPhoto(api: Api, token: string, photo: PhotoSize[], limit: number): Promise<ImageContent> {
  const largest = photo[photo.length - 1];
  if (!largest) throw new MediaDownloadError("empty photo");
  const { bytes } = await download(api, token, largest.file_id, limit, largest.file_size);
  return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" };
}

export async function fetchFileAttachment(
  api: Api,
  token: string,
  file: { file_id: string; file_name?: string; file_size?: number },
  uploadDir: string,
  limit: number,
  fallbackName = "file.bin",
): Promise<string> {
  const { bytes, filePath } = await download(api, token, file.file_id, limit, file.file_size);
  await mkdir(uploadDir, { recursive: true });
  const name = file.file_name ?? basename(filePath) ?? fallbackName;
  const raw = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || fallbackName;
  const path = join(uploadDir, `${randomUUID()}-${raw}`);
  await Bun.write(path, bytes);
  return path;
}

export async function fetchDocument(
  api: Api,
  token: string,
  document: { file_id: string; file_name?: string; file_size?: number },
  uploadDir: string,
  limit: number,
): Promise<string> {
  return fetchFileAttachment(api, token, document, uploadDir, limit, "file.bin");
}
