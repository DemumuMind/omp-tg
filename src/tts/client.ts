export interface SynthesizeOptions {
  url: string;
  text: string;
  timeoutMs: number;
}

/** Calls the local Piper sidecar and returns an OGG/Opus voice payload. */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<Uint8Array | null> {
  try {
    const response = await fetch(`${options.url.replace(/\/$/, "")}/speak`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: options.text,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === 0 ? null : bytes;
  } catch {
    return null;
  }
}
