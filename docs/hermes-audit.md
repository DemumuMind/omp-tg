# Hermes audit: what to port into omp-tg

Source: `NousResearch/hermes-agent`, MIT, snapshot `2a88712124` (2026-10-23).
Scope: Telegram adapter (7.3k lines), voice stack, gateway supervision. Line numbers are approximate; function names are exact.

Our gateway: Bun + grammY, one OMP RPC child per `chat:thread:user`, HTML streaming, rich final, local faster-whisper + Piper sidecars, systemd.

Most of Hermes is Python/PTB/asyncio plumbing and does not transfer. The valuable part is a set of small behavioural contracts.

## Priority table

| # | Feature | Hermes anchor | Our gap | Effort |
|---|---|---|---|---|
| 1 | STT anti-hallucination | `tools/transcription_local.py:201` `build_local_transcribe_kwargs`, `:236` `_is_hallucinated_segment` | `scripts/stt_server.py` only enables `vad_filter`; silence can become a prompt | S |
| 2 | Empty/inaudible transcript sentinel | `gateway/run_inbound_transcription.py:156` `_untranscribed_audio_note` | `transcribeAudio -> null` falls back to a file path; agent guesses | S |
| 3 | Long-form TTS split + concat | `tools/tts_tool.py:176` `_split_text_for_tts`, `:332` `_concat_audio_files` | `src/tts/text.ts` truncates at 1500 chars | M |
| 4 | Spoken-text normalization | `tools/tts_text_normalize.py:283` `prepare_spoken_text` | bare URLs, emoji, MEDIA paths, units, tables leak into speech | S-M |
| 5 | Voice-only reply gate + duration | `gateway/run_voice.py:371` `_should_send_voice_reply`; `adapter.py:194` `_probe_voice_duration_seconds` | `voiceReply` also set for audio files; voice sent after text; no duration | S |
| 6 | Entity-based mention detection | `adapter.py:6016` `_message_mentions_bot`, `:5960` `_extract_bot_mention_usernames` | `bot.ts gateGroup` uses `text.includes("@bot")` | S |
| 7 | Polling stall watchdog | `adapter.py:2345` `_check_polling_stall`, `:2159` `_polling_heartbeat_loop` | silently deaf long-poll is not detected | M |
| 8 | 409 conflict ladder | `adapter.py:2445` `_handle_polling_conflict` | restart can produce conflict retry storm or silence | S-M |
| 9 | Progress-gated `sd_notify` | `gateway/systemd_notify.py:77` `record_tick` | watchdog feeds on timer, not on event-loop progress | S |
| 10 | Flood ledger shared by send/edit | `adapter.py:5500` `_chat_send_lock`, `:5522` `_record_send_flood_cooldown` | auto-retry reacts, but streaming keeps hammering a 429 | M |
| 11 | Persistent update receipts | `plugins/platforms/telegram/update_admission.py:36` | in-memory dedupe only; restart can replay a prompt | S-M |
| 12 | Inline picker ranking/pagination | `plugins/platforms/telegram/inline_picker.py:62` `filter_catalog` | simple `includes` + slice(50), no `next_offset` | S |
| 13 | Rich transient vs fallback | `adapter.py:1523` `_rich_transient_result` | any rich error falls back to text; timeout can duplicate an answer | M |
| 14 | Media metadata | `adapter.py:229` `_probe_video_geometry`, `:194` `_probe_voice_duration_seconds`, `:262` `_video_thumbnail_jpeg` | video >10 MB lacks dimensions/thumbnail; long voice shows `0:00` | S-M |
| 15 | Batch client-split messages | `gateway/platforms/base.py` `_enqueue_text_event` | a >4096 paste becomes N prompts | S-M |

## Details

### 1. STT anti-hallucination

Hermes uses one kwargs owner for every local Whisper call:

```python
{
  "beam_size": 5,
  "condition_on_previous_text": False,
  "vad_filter": True,
  "vad_parameters": {"min_silence_duration_ms": 500},
  "no_speech_threshold": 0.6,
  "log_prob_threshold": -1.0,
}
```

It also drops a segment only when **both** signals say non-speech: `no_speech_prob > 0.6` AND `avg_logprob < -1.0`. Quiet but confident speech survives.

Map to `scripts/stt_server.py`: pass these kwargs into `MODEL.transcribe`, filter `segments` with the same AND gate, and return `no_speech: true` when everything was dropped. Keep VAD on. Do not apply an English phrase blocklist: the user may legitimately say "thank you".

Risk: low. Test with silence, quiet speech, and noisy speech.

### 2. Empty/inaudible sentinel

Hermes emits a neutral note for failed/empty transcription:

> The user sent a voice message but it came through empty or inaudible — speech-to-text returned no words. Do not guess at the content; ask the user to resend or type it out.

Map to `src/telegram/bot.ts` `describeAttachment`: return a discriminated result:

```ts
{ kind: "ok"; text: string } | { kind: "empty" } | { kind: "error"; path: string }
```

Only `ok` sets `voiceReply: true`. `empty` gets the "do not guess" note; `error` gets the existing file-path note.

### 3. Long-form TTS

Hermes normalizes, splits at sentence/word boundaries to provider cap (Piper 5000), synthesizes chunks, then concatenates with ffmpeg into one OGG/Opus.

Our `src/tts/text.ts` clips at 1500 chars with `…`, so long answers lose their conclusion. Fix by moving splitting into `scripts/tts_server.py`: accept full text, split to <=5000, synthesize each WAV, ffmpeg concat, encode one OGG. Keep `src/tts/client.ts` as one request. Add an optional speed header mapped to Piper `SynthesisConfig(length_scale=1/speed)`.

Risk: low-medium; ffmpeg is already required by STT/TTS.

### 4. Spoken-text normalization

Hermes pipeline (`prepare_spoken_text`): strip ` thinking` blocks, Markdown, bare URLs, `MEDIA:` paths; fold headings into the next sentence; expand units/currency/percent/arrows; remove emoji; smooth whitespace and dangling colons.

Port the high-value subset to `src/tts/text.ts`:

- remove fenced/inline code, bare URLs, `MEDIA:\S+`, images;
- links -> anchor text;
- headings -> sentence lead-in;
- tables -> `; ` pauses;
- emoji -> removed;
- `°C`, `%`, `₽`, `$`, `→` -> Russian words;
- collapse spaces, close dangling `:;` before speech.

Keep a max length only after splitting works.

### 5. Voice reply semantics

Hermes gates voice replies on `MessageType.VOICE` only, sends the voice note **before** text, and passes `duration` for OGG/Opus. Other audio formats go as audio/document, not voice.

Map to `src/telegram/bot.ts`: set `voiceReply` only in the `message:voice` handler, not `message:audio`. Map to `src/telegram/sender.ts`: probe Ogg granule/ffprobe duration, pass `duration`, verify `OggS` magic; fall back to `sendAudio`/document. In `SessionManager`, send voice before final text (or at least do not wait for text delivery).

### 6. Entity-based mentions

Hermes checks, in order:

- own message (`from.id === bot.id`) -> drop;
- `entities`/`caption_entities` of type `mention` equal `@ourusername`;
- `text_mention` with our bot id;
- `bot_command` entity covering `/cmd@ourusername`;
- reply-to-bot (`reply_to_message.from.id === bot.id`);
- raw regex only if Telegram sent **zero** entities;
- if another bot is explicitly mentioned and ours is not -> drop, even on a reply;
- strip the trigger handle only when we are the sole addressee.

Map to a new `src/telegram/mentions.ts` with pure functions. Telegram offsets are UTF-16 code units, so `text.slice(offset, offset + length)` is correct in JS. Feed `gateGroup` in `src/telegram/bot.ts`.

### 7. Polling stall watchdog

Hermes detects three failure modes:

1. dead socket: `getMe()` every 90 s with 15 s timeout;
2. wedged consumer: `getWebhookInfo().pending_update_count > 0` twice while `getMe()` is healthy;
3. no long-poll round-trip for 150 s.

On confirmation it stops the updater and rebuilds; it does not trust `updater.running`.

Map to `src/telegram/polling.ts`:

- a grammY API transformer stamps `lastGetUpdatesAt` on every `getUpdates` response;
- every 90 s: `getMe()` and `getWebhookInfo()` with timeouts;
- two consecutive bad probes or no progress for 150 s -> `bot.stop()`, then restart; if restart fails, exit non-zero for systemd.

Risk: two false positives restart a healthy bot. Require two signals and skip probes while an update is being processed.

### 8. 409 conflict ladder

Hermes stops the updater, sleeps `10 + n*10` seconds (15..55), retries with `drop_pending_updates=True`, max 5 attempts, then exits fatal. Retrying without dropping pending updates creates a new session that conflicts with the previous one.

Map to `src/index.ts`/`bot.ts`: wrap `bot.start()`; catch `GrammyError` 409, stop, sleep, retry with `drop_pending_updates: true`. Keep `TELEGRAM_DROP_PENDING_UPDATES` for cold boot only.

### 9. Progress-gated `sd_notify`

Hermes feeds `WATCHDOG=1` only if the loop woke within 25% of the scheduled cadence; a late tick marks the watchdog unhealthy and stops feeding. It sends `READY=1` after initialization and `STOPPING=1` once.

Our `src/utils/watchdog.ts` uses a fixed interval and always feeds. Add `scheduledAt` and refuse to feed when `now - scheduledAt > interval * 0.25`; send a status line, stop the timer, let systemd kill. Optionally replace the `systemd-notify` fork with a native datagram if Bun exposes Unix `SOCK_DGRAM`; otherwise keep the CLI.

### 10. Flood ledger

Hermes has one FIFO lock per chat, one 1-second outbound slot shared by `sendMessage` and `editMessageText`, 429 cooldown clamped 1..300 s, and a 5 s inline wait cap. Longer penalties fail closed instead of sleeping inline.

Map to `src/telegram/sender.ts`:

- `Map<chatKey, {nextSlotAt, cooldownUntil, typingUntil}>`;
- `sendText` awaits the slot; interim `editText` skips when closed; final delivery is never gated;
- parse `GrammyError.parameters.retry_after`; set cooldown; return a typed failure;
- `stream.ts` treats a skipped edit as a no-op;
- `sender.typing()` respects its own cooldown.

Configure `auto-retry` with a small `maxRetryAttempts`; do not let it sleep for minutes inline.

### 11. Persistent update receipts

Hermes keys claims by `botId:updateId`, keeps a bounded set, persists completed IDs for 24 h, and records only after the handler returns. A crash mid-handler retries; a completed handler does not.

Map to `src/telegram/bot.ts`: load `state/telegram-receipts-<botId>.json` at start; middleware checks memory + file; on accept add to in-flight; after `next()` resolves add to completed and schedule a debounced atomic write. Cap 4096, TTL 24 h.

### 12. Inline picker

Hermes ranks prefix > name substring > description, normalizes `-`/`_`, supports `next_offset`, sets `is_personal`, and caches 10 s. Our handler filters and slices 50.

Map to `src/telegram/inline.ts`: pure `filterCatalog`, `buildInlineResults(query, offset)`; pass `next_offset` to `answerInlineQuery`; result IDs scoped by offset.

### 13. Rich transient handling

Hermes distinguishes:

- capability/permanent error -> latch rich off and fall back to legacy;
- transient/unknown -> do **not** resend via legacy, because the rich request may have landed.

Our `Sender.sendRich` returns `{ok:false}` for every error, and `deliverFinal` always falls back, which can duplicate an answer after a timeout.

Map: `isRichEligible(markdown)` (tables, task lists, details, math), `sendRich` -> `"ok" | "fallback" | "transient"`, module-level `richDisabled` latch for capability errors. Do not try rich for ordinary replies; this also removes the visual jump between streaming HTML and rich final.

### 14. Media metadata

Hermes probes video `width/height/duration` with ffprobe, grabs a 320px JPEG at 25% duration, and passes them to `sendVideo`; otherwise Telegram stores big videos as an unprocessed 320x320 tile with duration 0. It probes voice duration and only sends OGG/Opus as voice.

Map to `src/omp/media.ts` / `src/telegram/sender.ts`: `ffprobe -of json` (20 s timeout), `ffmpeg -ss ... -frames:v 1` (30 s), pass metadata; degrade to the current raw send if ffmpeg is absent. For images >1 MB, optional ffmpeg JPEG conversion (max 1600px, q~3) to avoid upload timeouts.

### 15. Client-split batching

Hermes buffers messages per session when a paste is split by Telegram (>4096), waits 180 ms for short text, 240 ms for <=1024, and up to the configured cap for near-4096 chunks. Albums with `media_group_id` are merged after 800 ms.

Map to `src/telegram/batcher.ts`: batch only when `text.length >= 4000` or the previous chunk was near 4000, so normal messages gain no latency. Flush pending buffers on shutdown. For photos, group by `media_group_id` and call `routeText` once with all images.

## Do not port

- DoH/IP fallback transport (`telegram_network.py`): needs a custom httpx transport; Bun has no equivalent. Use `TELEGRAM_PROXY` if needed.
- Full delivery ledger (`delivery_ledger.py`): SQLite state machine for multi-bot reconnects; overkill for one user. If we ever need it, use 3 states + boot sweep.
- Pairing, multi-profile authz, DM-topic binding tables, bot-loop guard: multi-tenant features.
- Full MarkdownV2 renderer (`format_message`): we are on HTML; port only `_strip_mdv2` as a plain-text degradation if needed.
- Streaming TTS / barge-in / stop phrases / echo guard: real-time voice-mode features, not Telegram voice notes.
- Idle model unload: systemd `MemoryMax` already bounds sidecars.
- Held-inbound queue: grammY confirms updates after the handler; our systemd stop budget and OMP abort cover the window.

## Recommended batches

**A - correctness (do first):** 1, 2, 3, 4, 5, 6, 9.
Fixes silence hallucinations, truncated voice, false mentions, voice on music files, and a watchdog that can be fooled by a late event loop.

**B - resilience:** 7, 8, 10, 11.
Covers a silently deaf poller, restart conflicts, Telegram 429 storms, and duplicate prompts after restart.

**C - polish:** 12, 13, 14, 15.
Inline pagination, duplicate-safe rich fallback, video/voice metadata, long-paste batching.
