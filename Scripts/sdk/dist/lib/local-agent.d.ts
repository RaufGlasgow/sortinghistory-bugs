/**
 * Local agent loop for driving multi-turn tool-use conversations
 * with an OpenAI-compatible model server (e.g. MLX).
 *
 * Sends prompts to /v1/chat/completions with tool definitions,
 * executes tool calls locally via tool-executor, and continues
 * the conversation until the model stops requesting tools or
 * maxTurns is reached.
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { HookEvent, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { ToolResult } from "./tool-executor.js";
import type { ToolDefinition } from "./tool-definitions.js";
/** Data captured for each turn of the agent loop */
export interface TurnCaptureData {
    turnNumber: number;
    messagesIn: ChatCompletionMessageParam[];
    response: unknown;
    toolResults: ToolResult[];
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
}
/** Parameters for the local agent loop */
export interface LocalAgentLoopParams {
    /** Base URL for the OpenAI-compatible endpoint (e.g. "http://localhost:8080/v1") */
    endpoint: string;
    /** Model name to request */
    model: string;
    /** System prompt */
    systemPrompt: string;
    /** User prompt */
    userPrompt: string;
    /** Tool definitions in OpenAI format */
    tools: ToolDefinition[];
    /** Maximum number of agent turns (hard stop) */
    maxTurns: number;
    /** Working directory for tool execution */
    cwd: string;
    /** Optional hooks configuration for tool safety */
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    /** Optional AbortController for cancellation */
    abortController?: AbortController;
    /** Optional callback invoked after each turn completes */
    onTurn?: (turnData: TurnCaptureData) => void;
}
/** Result returned by the local agent loop */
export interface LocalAgentResult {
    /** Final text response from the model (null if no text response received) */
    responseText: string | null;
    /** Number of turns executed */
    turns: number;
    /** Names of tools that were invoked */
    toolsUsed: string[];
    /** Whether any write/edit tools were used */
    usedWriteTools: boolean;
    /** Total input tokens consumed */
    inputTokens: number;
    /** Total output tokens consumed */
    outputTokens: number;
    /** Wall-clock duration in milliseconds */
    durationMs: number;
    /** Error message if the loop ended due to an error */
    error: string | null;
}
/**
 * Run the local agent loop: send prompts to the model, execute tool calls,
 * and continue until the model stops or maxTurns is reached.
 */
export declare function runLocalAgentLoop(params: LocalAgentLoopParams): Promise<LocalAgentResult>;
