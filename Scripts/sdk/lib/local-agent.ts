/**
 * Local agent loop for driving multi-turn tool-use conversations
 * with an OpenAI-compatible model server (e.g. MLX).
 *
 * Sends prompts to /v1/chat/completions with tool definitions,
 * executes tool calls locally via tool-executor, and continues
 * the conversation until the model stops requesting tools or
 * maxTurns is reached.
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions.js";
import type { HookEvent, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { executeTool, WRITE_TOOL_NAMES } from "./tool-executor.js";
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
export async function runLocalAgentLoop(params: LocalAgentLoopParams): Promise<LocalAgentResult> {
  const startTime = Date.now();

  const result: LocalAgentResult = {
    responseText: null,
    turns: 0,
    toolsUsed: [],
    usedWriteTools: false,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    error: null,
  };

  const toolsUsedSet = new Set<string>();

  // Initialize the OpenAI client pointing at the local MLX server
  const client = new OpenAI({
    baseURL: params.endpoint,
    apiKey: "local-mlx", // MLX servers typically don't require a real key
  });

  // Build the initial messages array
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userPrompt },
  ];

  try {
    for (let turn = 1; turn <= params.maxTurns; turn++) {
      const turnStart = Date.now();
      const messagesSnapshot = [...messages];

      // Check for abort
      if (params.abortController?.signal.aborted) {
        result.error = "Aborted";
        break;
      }

      console.log(`[local-agent] Turn ${turn}/${params.maxTurns}`);

      // Send to the model
      const response = await client.chat.completions.create({
        model: params.model,
        messages,
        tools: params.tools.length > 0 ? params.tools : undefined,
      });

      const choice = response.choices[0];
      if (!choice) {
        result.error = "No choices in model response";
        break;
      }

      // Extract token usage (AC #9: handle missing usage field)
      let turnTokensIn = 0;
      let turnTokensOut = 0;
      if (response.usage) {
        turnTokensIn = response.usage.prompt_tokens ?? 0;
        turnTokensOut = response.usage.completion_tokens ?? 0;
      } else {
        console.warn("[local-agent] Response missing usage field -- token counts will be 0");
      }
      result.inputTokens += turnTokensIn;
      result.outputTokens += turnTokensOut;
      result.turns = turn;

      // Append assistant message to conversation
      const assistantMessage = choice.message;
      messages.push({
        role: "assistant",
        content: assistantMessage.content,
        tool_calls: assistantMessage.tool_calls,
      } as ChatCompletionMessageParam);

      // Check if the model made tool calls
      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls — model is done
        result.responseText = assistantMessage.content ?? null;

        // Fire onTurn callback
        if (params.onTurn) {
          const turnDuration = Date.now() - turnStart;
          params.onTurn({
            turnNumber: turn,
            messagesIn: messagesSnapshot,
            response,
            toolResults: [],
            tokensIn: turnTokensIn,
            tokensOut: turnTokensOut,
            durationMs: turnDuration,
          });
        }

        break;
      }

      // Execute each tool call (filter to function tool calls only)
      const turnToolResults: ToolResult[] = [];
      const functionCalls = toolCalls.filter(
        (tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function"
      );
      for (const toolCall of functionCalls) {
        const toolName = toolCall.function.name;
        toolsUsedSet.add(toolName);

        if (WRITE_TOOL_NAMES.has(toolName)) {
          result.usedWriteTools = true;
        }

        // Parse arguments (AC #7: handle malformed JSON gracefully)
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseErr: unknown) {
          const parseMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
          const errorOutput = `Error: Invalid JSON in tool call arguments: ${parseMessage}`;
          console.warn(`[local-agent] Malformed tool call args for ${toolName}: ${parseMessage}`);

          turnToolResults.push({ success: false, output: errorOutput });
          messages.push({
            role: "tool",
            content: errorOutput,
            tool_call_id: toolCall.id,
          } as ChatCompletionMessageParam);
          continue;
        }

        console.log(`[local-agent] Executing tool: ${toolName}`);

        const toolResult = await executeTool(toolName, toolArgs, {
          cwd: params.cwd,
          hooks: params.hooks,
        });

        turnToolResults.push(toolResult);

        // Append tool result message
        messages.push({
          role: "tool",
          content: toolResult.output,
          tool_call_id: toolCall.id,
        } as ChatCompletionMessageParam);
      }

      // Fire onTurn callback (AC #8)
      if (params.onTurn) {
        const turnDuration = Date.now() - turnStart;
        params.onTurn({
          turnNumber: turn,
          messagesIn: messagesSnapshot,
          response,
          toolResults: turnToolResults,
          tokensIn: turnTokensIn,
          tokensOut: turnTokensOut,
          durationMs: turnDuration,
        });
      }

      // Capture last text response in case we hit maxTurns
      if (assistantMessage.content) {
        result.responseText = assistantMessage.content;
      }

      // If we are at maxTurns, stop (AC #6)
      if (turn >= params.maxTurns) {
        console.log(`[local-agent] Reached maxTurns (${params.maxTurns}), stopping`);
        break;
      }
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[local-agent] Error: ${result.error}`);
  }

  result.toolsUsed = Array.from(toolsUsedSet);
  result.durationMs = Date.now() - startTime;

  console.log(
    `[local-agent] Complete: turns=${result.turns} tools=[${result.toolsUsed.join(",")}] ` +
    `tokens=${result.inputTokens}/${result.outputTokens} duration=${result.durationMs}ms`,
  );

  return result;
}
