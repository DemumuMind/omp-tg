import { z } from "zod";

export const ImageContentSchema = z
  .object({ type: z.literal("image"), data: z.string(), mimeType: z.string() })
  .passthrough();
export type ImageContent = z.infer<typeof ImageContentSchema>;

export const ReadySchema = z
  .object({
    type: z.literal("ready"),
    protocolVersion: z.number().int(),
    supportedProtocolVersions: z.array(z.number().int()).optional(),
    maxFrameBytes: z.number().int().positive().optional(),
    maxReassembledFrameBytes: z.number().int().positive().optional(),
  })
  .passthrough();

export const ChunkSchema = z
  .object({
    type: z.literal("rpc_chunk"),
    chunkId: z.string(),
    index: z.number().int().nonnegative(),
    count: z.number().int().positive(),
    byteLength: z.number().int().positive(),
    data: z.string(),
  })
  .passthrough();

export const ResponseSchema = z
  .object({
    type: z.literal("response"),
    id: z.string().optional(),
    command: z.string(),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export const PromptResultSchema = z
  .object({
    type: z.literal("prompt_result"),
    id: z.string().optional(),
    agentInvoked: z.boolean(),
    status: z.enum(["completed", "aborted", "error"]),
    error: z.object({ message: z.string() }).passthrough().optional(),
    sessionSettled: z.boolean(),
  })
  .passthrough();
export type PromptResult = z.infer<typeof PromptResultSchema>;

const TimeoutSchema = z.number().int().positive().optional();

export const UiRequestSchema = z.discriminatedUnion("method", [
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("select"),
      title: z.string(),
      options: z.array(z.string()),
      optionDetails: z.array(z.object({ description: z.string().optional() }).passthrough()).optional(),
      timeout: TimeoutSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("confirm"),
      title: z.string(),
      message: z.string(),
      timeout: TimeoutSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("input"),
      title: z.string(),
      placeholder: z.string().optional(),
      timeout: TimeoutSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("editor"),
      title: z.string(),
      prefill: z.string().optional(),
      promptStyle: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("ask"),
      questions: z.array(
        z
          .object({
            id: z.string(),
            question: z.string(),
            header: z.string().optional(),
            options: z.array(
              z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() }).passthrough(),
            ),
            multi: z.boolean().optional(),
            recommended: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      ),
      timeout: TimeoutSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("cancel"),
      targetId: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("notify"),
      message: z.string(),
      notifyType: z.enum(["info", "warning", "error"]).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("setStatus"),
      statusKey: z.string(),
      statusText: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("setWidget"),
      widgetKey: z.string(),
      widgetLines: z.array(z.string()).optional(),
      widgetPlacement: z.enum(["aboveEditor", "belowEditor"]).optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.literal("setTitle"), title: z.string() })
    .passthrough(),
  z
    .object({ type: z.literal("extension_ui_request"), id: z.string(), method: z.literal("set_editor_text"), text: z.string() })
    .passthrough(),
  z
    .object({
      type: z.literal("extension_ui_request"),
      id: z.string(),
      method: z.literal("open_url"),
      url: z.string(),
      launchUrl: z.string().optional(),
      instructions: z.string().optional(),
    })
    .passthrough(),
]);
export type UiRequest = z.infer<typeof UiRequestSchema>;
export type AskQuestion = Extract<UiRequest, { method: "ask" }>["questions"][number];

export interface UiAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

export type UiResponsePayload =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true; timedOut?: boolean }
  | { answers: UiAnswer[] };


export type RpcCommand =
  | { id: string; type: "negotiate_protocol"; protocolVersion: 2 }
  | { id: string; type: "set_event_filter"; events: string[] | null; messageUpdates?: "full" | "delta" }
  | { id: string; type: "set_ask_dialog"; enabled: boolean }
  | { id: string; type: "open_session"; sessionDir: string }
  | { id: string; type: "prompt"; message: string; images?: ImageContent[] }
  | { id: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id: string; type: "abort" }
  | { id: string; type: "new_session" }
  | { id: string; type: "bash"; command: string }
  | { id: string; type: "abort_bash" }
  | { id: string; type: "get_state" }
  | { id: string; type: "get_available_commands" }
  | { id: string; type: "get_available_models" }
  | { id: string; type: "set_model"; provider: string; modelId: string }
  | { id: string; type: "get_session_stats" }
  | { id: string; type: "export_html"; outputPath?: string }
  | { id: string; type: "set_session_name"; name: string }
  | { id: string; type: "switch_session"; sessionPath: string };

/** Command shape without the transport id; distributes over the command union. */
export type RpcCommandPayload = RpcCommand extends infer Command
  ? Command extends RpcCommand
    ? Omit<Command, "id">
    : never
  : never;

export type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }
  | { type: "extension_ui_response"; id: string; answers: UiAnswer[] };

export const BashResultSchema = z
  .object({
    output: z.string(),
    exitCode: z.number().int().optional(),
    cancelled: z.boolean(),
    timedOut: z.boolean().optional(),
    truncated: z.boolean(),
    images: z.array(ImageContentSchema).optional(),
  })
  .passthrough();
export type BashResult = z.infer<typeof BashResultSchema>;

export const SessionStateSchema = z
  .object({
    sessionId: z.string(),
    sessionFile: z.string().optional(),
    sessionName: z.string().optional(),
    isStreaming: z.boolean(),
    messageCount: z.number().int(),
    model: z
      .object({ id: z.string().optional(), provider: z.string().optional(), name: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SessionState = z.infer<typeof SessionStateSchema>;

export const OpenSessionResultSchema = z
  .object({
    cancelled: z.boolean(),
    resumed: z.boolean(),
    sessionId: z.string(),
    sessionFile: z.string().optional(),
  })
  .passthrough();
export type OpenSessionResult = z.infer<typeof OpenSessionResultSchema>;

export const ModelSchema = z
  .object({ id: z.string(), provider: z.string(), name: z.string().optional() })
  .passthrough();
export type ModelInfo = z.infer<typeof ModelSchema>;

export const AvailableCommandsSchema = z
  .object({
    commands: z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough()),
  })
  .passthrough();

export const ExportResultSchema = z.object({ path: z.string() }).passthrough();
export const SwitchSessionResultSchema = z.object({ cancelled: z.boolean() }).passthrough();

export const AvailableModelsSchema = z.object({ models: z.array(ModelSchema) }).passthrough();

export const SessionStatsSchema = z
  .object({
    sessionId: z.string(),
    userMessages: z.number().int(),
    assistantMessages: z.number().int(),
    toolCalls: z.number().int(),
    totalMessages: z.number().int(),
    tokens: z
      .object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        total: z.number(),
      })
      .passthrough(),
    cost: z.number(),
  })
  .passthrough();
export type SessionStats = z.infer<typeof SessionStatsSchema>;

const TextDeltaFrameSchema = z
  .object({
    type: z.literal("message_update"),
    assistantMessageEvent: z.object({ type: z.literal("text_delta"), delta: z.string() }).passthrough(),
  })
  .passthrough();

const ImageFrameSchema = z
  .object({
    type: z.enum(["message_end", "message_update"]),
    message: z.object({ role: z.string().optional(), content: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough();

const ToolStartFrameSchema = z
  .object({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown().optional(),
    intent: z.string().optional(),
  })
  .passthrough();

const ToolEndFrameSchema = z
  .object({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    toolName: z.string(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export interface ToolActivity {
  phase: "start" | "end";
  toolCallId: string;
  toolName: string;
  summary?: string;
  isError?: boolean;
}

const SUMMARY_KEYS = ["command", "path", "file_path", "pattern", "query", "url", "description", "prompt"] as const;
const ToolArgsSchema = z.record(z.string(), z.unknown());

function summarizeArgs(args: unknown): string | undefined {
  const parsed = ToolArgsSchema.safeParse(args);
  if (!parsed.success) return undefined;
  for (const key of SUMMARY_KEYS) {
    const value = parsed.data[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const flat = value.replace(/\s+/g, " ").trim();
    return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
  }
  return undefined;
}

/** Tool lifecycle reported by OMP, used to show what the agent is doing. */
export function extractToolActivity(frame: unknown): ToolActivity | null {
  const start = ToolStartFrameSchema.safeParse(frame);
  if (start.success) {
    const summary = start.data.intent?.trim() || summarizeArgs(start.data.args);
    return {
      phase: "start",
      toolCallId: start.data.toolCallId,
      toolName: start.data.toolName,
      ...(summary ? { summary } : {}),
    };
  }
  const end = ToolEndFrameSchema.safeParse(frame);
  if (end.success) {
    return {
      phase: "end",
      toolCallId: end.data.toolCallId,
      toolName: end.data.toolName,
      isError: end.data.isError === true,
    };
  }
  return null;
}

/** Text appended by one `message_update` frame under `messageUpdates: "delta"`. */
export function extractTextDelta(frame: unknown): string | null {
  const parsed = TextDeltaFrameSchema.safeParse(frame);
  return parsed.success ? parsed.data.assistantMessageEvent.delta : null;
}

/** Image blocks reported in a completed assistant message; user frames are ignored so inbound media is never echoed. */
export function extractImages(frame: unknown): ImageContent[] {
  const parsed = ImageFrameSchema.safeParse(frame);
  if (!parsed.success) return [];
  // The user's own upload is echoed back as a user message; never send it back to them.
  const role = parsed.data.message.role;
  if (role !== "assistant" && role !== "toolResult") return [];
  const images: ImageContent[] = [];
  for (const block of parsed.data.message.content) {
    const image = ImageContentSchema.safeParse(block);
    if (image.success) images.push(image.data);
  }
  return images;
}
