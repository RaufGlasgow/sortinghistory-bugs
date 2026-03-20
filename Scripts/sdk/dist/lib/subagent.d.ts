/**
 * Reusable subagent spawner for the SDK automation pipeline.
 *
 * Wraps the Claude Agent SDK query() function to provide:
 * - Structured result capture (session_id, tokens, duration, response text)
 * - Write/edit tool usage detection (for read-only enforcement)
 * - Logging for CI debugging
 */
import type { HookEvent, HookCallbackMatcher, ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { ExtractedImage } from "./image-extract.js";
import { type WorkflowType } from "../config.js";
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
    /** Optional AbortController for cancellation (C9: kill timed-out subagents) */
    abortController?: AbortController;
    /** Story 1.3: Backend override — "local" for local inference, "claude" for Claude API */
    backend?: "local" | "claude";
    /** Story 1.3: Workflow type — used to determine default backend from WORKFLOW_BACKENDS */
    workflowType?: WorkflowType;
    /** Story 1.4: Workflow ID for training data capture */
    workflowId?: string;
    /** Story 1.4: Attempt number for training data capture */
    attemptNumber?: number;
}
/**
 * Spawn a subagent via local inference or Claude API.
 *
 * Routing logic (Story 1.3):
 * 1. If `backend` is specified, use it directly
 * 2. Else if `workflowType` is specified, look up WORKFLOW_BACKENDS
 * 3. Else default to "claude" (safe fallback — backward compatible)
 *
 * CI detection (AC #10): If backend resolves to "local" but the local endpoint
 * is unreachable and no LOCAL_MODEL_ENDPOINT env var is set, falls back to Claude.
 */
export declare function spawnSubagent(params: SubagentParams): Promise<SubagentResult>;
