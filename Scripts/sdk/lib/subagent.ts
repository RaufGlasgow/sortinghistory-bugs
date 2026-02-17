/**
 * Reusable subagent spawner for the SDK automation pipeline.
 *
 * Wraps the Claude Agent SDK query() function to provide:
 * - Structured result capture (session_id, tokens, duration, response text)
 * - Write/edit tool usage detection (for read-only enforcement)
 * - Logging for CI debugging
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKAssistantMessage,
  SDKUserMessage,
  Options,
  HookEvent,
  HookCallbackMatcher,
  ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ExtractedImage } from "./image-extract.js";

/** Result returned by spawnSubagent */
export interface SubagentResult {
  /** Whether the subagent completed successfully */
  success: boolean;
  /** Session ID assigned by the SDK */
  sessionId: string | null;
  /** Model used (from init message) */
  model: string | null;
  /** Final text response from the subagent */
  responseText: string | null;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens consumed */
  outputTokens: number;
  /** Total cost in USD */
  costUsd: number;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Per-model usage breakdown */
  modelUsage: Record<string, ModelUsage>;
  /** Whether any write/edit tools were invoked */
  usedWriteTools: boolean;
  /** Names of tools that were actually invoked */
  toolsUsed: string[];
  /** Error message if success is false */
  error: string | null;
}

/** Parameters for spawning a subagent */
export interface SubagentParams {
  /** Model ID (e.g. "claude-haiku-4-5-20251001") */
  model: string;
  /** Array of tool names to make available */
  tools: readonly string[] | string[];
  /** The prompt to send to the subagent */
  prompt: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional hooks configuration */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Working directory for the subagent (defaults to process.cwd()) */
  cwd?: string;
  /** Maximum agentic turns (default: 10) */
  maxTurns?: number;
  /** Persist session to disk for later resumption (default: false) */
  persistSession?: boolean;
  /** Session ID to resume from a previous run */
  resume?: string;
  /** Optional images to include as multimodal content blocks */
  images?: ExtractedImage[];
}

/**
 * Create an async generator that yields a single SDKUserMessage with
 * multimodal content blocks (text + images).
 *
 * Used when bug reports contain inline base64 screenshots that should
 * be sent as proper image content blocks rather than raw text.
 */
async function* createMultimodalPrompt(
  text: string,
  images: ExtractedImage[],
): AsyncGenerator<SDKUserMessage> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text },
  ];

  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

  yield {
    type: "user" as const,
    message: {
      role: "user" as const,
      content,
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/**
 * Spawn a Claude subagent via the SDK query() function.
 *
 * Iterates the full async message stream, collecting:
 * - session_id from the init message
 * - response text from the result message
 * - token usage and cost from the result message
 * - tool invocations for audit logging
 */
export async function spawnSubagent(params: SubagentParams): Promise<SubagentResult> {
  const startTime = Date.now();

  const result: SubagentResult = {
    success: false,
    sessionId: null,
    model: null,
    responseText: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    modelUsage: {},
    usedWriteTools: false,
    toolsUsed: [],
    error: null,
  };

  const writeToolNames = new Set(["Write", "Edit", "NotebookEdit"]);
  const toolsUsedSet = new Set<string>();

  try {
    console.log(`[subagent] Spawning with model=${params.model} tools=[${params.tools.join(",")}]`);

    const options: Options = {
      model: params.model,
      tools: [...params.tools],
      allowedTools: [...params.tools],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: params.maxTurns ?? 10,
      cwd: params.cwd,
      persistSession: params.persistSession ?? false,
      thinking: { type: "disabled" },
      hooks: params.hooks,
      resume: params.resume,
    };

    if (params.systemPrompt) {
      options.systemPrompt = params.systemPrompt;
    }

    const promptInput = (params.images && params.images.length > 0)
      ? createMultimodalPrompt(params.prompt, params.images)
      : params.prompt;
    const conversation = query({ prompt: promptInput, options });

    for await (const message of conversation) {
      logMessage(message);

      // Capture session ID and model from init
      if (message.type === "system" && "subtype" in message && message.subtype === "init") {
        const initMsg = message as SDKSystemMessage;
        result.sessionId = initMsg.session_id;
        result.model = initMsg.model;
        console.log(`[subagent] Session initialized: id=${initMsg.session_id} model=${initMsg.model}`);
      }

      // Track tool usage from assistant messages (they contain tool_use content blocks)
      if (message.type === "assistant") {
        const assistantMsg = message as SDKAssistantMessage;
        if (assistantMsg.message?.content) {
          for (const block of assistantMsg.message.content) {
            if ("type" in block && block.type === "tool_use" && "name" in block) {
              const toolName = (block as { name: string }).name;
              toolsUsedSet.add(toolName);
              if (writeToolNames.has(toolName)) {
                result.usedWriteTools = true;
                console.log(`[subagent] WARNING: Write tool used: ${toolName}`);
              }
            }
          }
        }
      }

      // Capture result
      if (message.type === "result") {
        const resultMsg = message as SDKResultSuccess | SDKResultError;
        result.durationMs = resultMsg.duration_ms;
        result.costUsd = resultMsg.total_cost_usd;
        result.modelUsage = resultMsg.modelUsage;

        if (resultMsg.usage) {
          result.inputTokens = resultMsg.usage.input_tokens;
          result.outputTokens = resultMsg.usage.output_tokens;
        }

        if (resultMsg.subtype === "success") {
          result.success = true;
          result.responseText = (resultMsg as SDKResultSuccess).result;
        } else {
          const errorResult = resultMsg as SDKResultError;
          result.error = errorResult.errors?.join("; ") ?? `Subagent error: ${errorResult.subtype}`;
        }
      }
    }

    result.toolsUsed = Array.from(toolsUsedSet);

  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[subagent] Error: ${result.error}`);
  }

  // If durationMs wasn't set by the result message, calculate from wall clock
  if (result.durationMs === 0) {
    result.durationMs = Date.now() - startTime;
  }

  console.log(`[subagent] Complete: success=${result.success} tokens=${result.inputTokens}/${result.outputTokens} duration=${result.durationMs}ms cost=$${result.costUsd.toFixed(4)}`);

  return result;
}

/** Log SDK messages at appropriate detail level */
function logMessage(message: SDKMessage): void {
  switch (message.type) {
    case "system":
      if ("subtype" in message) {
        console.log(`[subagent:msg] system/${message.subtype}`);
      }
      break;
    case "assistant":
      console.log(`[subagent:msg] assistant message`);
      break;
    case "result":
      console.log(`[subagent:msg] result/${message.subtype}`);
      break;
    case "tool_progress":
      // These are frequent, log at lower detail
      console.log(`[subagent:msg] tool_progress: ${message.tool_name} (${message.elapsed_time_seconds}s)`);
      break;
    default:
      console.log(`[subagent:msg] ${message.type}`);
      break;
  }
}
