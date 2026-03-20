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
import { executeTool, WRITE_TOOL_NAMES } from "./tool-executor.js";
/**
 * Run the local agent loop: send prompts to the model, execute tool calls,
 * and continue until the model stops or maxTurns is reached.
 */
export async function runLocalAgentLoop(params) {
    const startTime = Date.now();
    const result = {
        responseText: null,
        turns: 0,
        toolsUsed: [],
        usedWriteTools: false,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        error: null,
    };
    const toolsUsedSet = new Set();
    // Initialize the OpenAI client pointing at the local MLX server
    const client = new OpenAI({
        baseURL: params.endpoint,
        apiKey: "local-mlx", // MLX servers typically don't require a real key
    });
    // Build the initial messages array
    const messages = [
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
            }
            else {
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
            });
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
            const turnToolResults = [];
            const functionCalls = toolCalls.filter((tc) => tc.type === "function");
            for (const toolCall of functionCalls) {
                const toolName = toolCall.function.name;
                toolsUsedSet.add(toolName);
                if (WRITE_TOOL_NAMES.has(toolName)) {
                    result.usedWriteTools = true;
                }
                // Parse arguments (AC #7: handle malformed JSON gracefully)
                let toolArgs;
                try {
                    toolArgs = JSON.parse(toolCall.function.arguments);
                }
                catch (parseErr) {
                    const parseMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
                    const errorOutput = `Error: Invalid JSON in tool call arguments: ${parseMessage}`;
                    console.warn(`[local-agent] Malformed tool call args for ${toolName}: ${parseMessage}`);
                    turnToolResults.push({ success: false, output: errorOutput });
                    messages.push({
                        role: "tool",
                        content: errorOutput,
                        tool_call_id: toolCall.id,
                    });
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
                });
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
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        console.error(`[local-agent] Error: ${result.error}`);
    }
    result.toolsUsed = Array.from(toolsUsedSet);
    result.durationMs = Date.now() - startTime;
    console.log(`[local-agent] Complete: turns=${result.turns} tools=[${result.toolsUsed.join(",")}] ` +
        `tokens=${result.inputTokens}/${result.outputTokens} duration=${result.durationMs}ms`);
    return result;
}
