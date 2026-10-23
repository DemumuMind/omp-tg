import { z } from "zod";

const SttResponseSchema = z
  .object({
    text: z.string(),
    language: z.string().optional(),
    duration: z.number().optional(),
  })
  .passthrough();

export interface TranscribeOptions {
  url: string;
  bytes: Uint8Array;
  fileName: string;
  language?: string;
  timeoutMs: number;
}

/** Calls the local faster-whisper sidecar. Returns null for silence or transport errors. */
export async function transcribeAudio(options: TranscribeOptions): Promise<string | null> {
  try {
    const response = await fetch(`${options.url.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": options.fileName,
        ...(options.language ? { "x-language": options.language } : {}),
      },
      body: options.bytes,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return null;
    const parsed = SttResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const text = parsed.data.text.trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}
