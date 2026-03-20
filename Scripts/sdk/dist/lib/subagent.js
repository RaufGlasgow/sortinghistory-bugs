/**
 * Reusable subagent spawner for the SDK automation pipeline.
 *
 * Wraps the Claude Agent SDK query() function to provide:
 * - Structured result capture (session_id, tokens, duration, response text)
 * - Write/edit tool usage detection (for read-only enforcement)
 * - Logging for CI debugging
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { runLocalAgentLoop } from "./local-agent.js";
import { getToolDefinitions } from "./tool-definitions.js";
import { WORKFLOW_BACKENDS, LOCAL_MODELS } from "../config.js";
import { captureTrainingTurn } from "./training-capture.js";
/**
 * Create an async generator that yields a single SDKUserMessage with
 * multimodal content blocks (text + images).
 *
 * Used when bug reports contain inline base64 screenshots that should
 * be sent as proper image content blocks rather than raw text.
 */
async function* createMultimodalPrompt(text, images) {
    const content = [
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
        type: "user",
        session_id: "",
        message: {
            role: "user",
            content,
        },
        parent_tool_use_id: null,
    };
}
// ---------------------------------------------------------------------------
// Story 1.3: Backend resolution
// ---------------------------------------------------------------------------
/**
 * Determine which backend to use based on explicit override, workflow type, or default.
 */
function resolveBackend(params) {
    // Explicit override wins
    if (params.backend)
        return params.backend;
    // Workflow type -> config lookup
    if (params.workflowType) {
        const configured = WORKFLOW_BACKENDS[params.workflowType];
        if (configured)
            return configured;
    }
    // Safe default: Claude API
    return "claude";
}
/**
 * Check whether the local inference endpoint is reachable.
 * Sends a lightweight request to /v1/models and returns true if it responds.
 */
async function isLocalEndpointReachable(endpoint) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(endpoint + "/models", {
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return response.ok || response.status === 200;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Story 1.3: Local agent adapter
// ---------------------------------------------------------------------------
/**
 * Map SubagentParams to LocalAgentLoopParams, call runLocalAgentLoop(),
 * and map LocalAgentResult back to SubagentResult.
 */
async function spawnLocalAgent(params) {
    const startTime = Date.now();
    // Determine which local model config to use based on the model ID
    const localModelConfig = params.model === LOCAL_MODELS.BACKUP.id ? LOCAL_MODELS.BACKUP : LOCAL_MODELS.PRIMARY;
    const endpoint = localModelConfig.endpoint;
    console.log(`[subagent:local] Spawning local agent: model=${params.model} endpoint=${endpoint}`);
    // AC #9: Check if the server is reachable before trying
    const reachable = await isLocalEndpointReachable(endpoint);
    if (!reachable) {
        const durationMs = Date.now() - startTime;
        console.error(`[subagent:local] Server unreachable at ${endpoint}`);
        return {
            success: false,
            sessionId: null,
            model: params.model,
            responseText: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs,
            modelUsage: {},
            usedWriteTools: false,
            toolsUsed: [],
            error: `Local inference server unreachable at ${endpoint}. Ensure the MLX server is running.`,
        };
    }
    // Map tool names to OpenAI function calling definitions
    const toolDefs = getToolDefinitions([...params.tools]);
    let localResult;
    try {
        localResult = await runLocalAgentLoop({
            endpoint,
            model: params.model,
            systemPrompt: params.systemPrompt ?? "",
            userPrompt: params.prompt,
            tools: toolDefs,
            maxTurns: params.maxTurns ?? 10,
            cwd: params.cwd ?? process.cwd(),
            hooks: params.hooks,
            abortController: params.abortController,
            // Story 1.4: Wire onTurn callback for training data capture
            onTurn: params.workflowId
                ? (turnData) => {
                    try {
                        const input = {
                            workflowId: params.workflowId,
                            workflowType: params.workflowType ?? "bug_fix",
                            backend: "local",
                            model: params.model,
                            attemptNumber: params.attemptNumber ?? 0,
                            turnNumber: turnData.turnNumber,
                            messagesIn: turnData.messagesIn.map((m) => ({
                                role: String(m.role),
                                content: typeof m.content === "string" ? m.content : null,
                                tool_calls: "tool_calls" in m ? m.tool_calls : undefined,
                            })),
                            toolsAvailable: toolDefs.map((t) => t.function.name),
                            response: {
                                content: typeof turnData.response?.choices === "object"
                                    ? turnData.response.choices?.[0]?.message?.content ?? null
                                    : null,
                                tool_calls: turnData.response?.choices?.[0]?.message?.tool_calls,
                            },
                            toolResults: turnData.toolResults.map((tr) => ({
                                name: "tool",
                                result: tr.output,
                            })),
                            tokensIn: turnData.tokensIn,
                            tokensOut: turnData.tokensOut,
                            durationMs: turnData.durationMs,
                            outcome: null,
                        };
                        captureTrainingTurn(input);
                    }
                    catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        console.warn(`[subagent:local] Training capture failed (non-fatal): ${errMsg}`);
                    }
                }
                : undefined,
        });
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startTime;
        console.error(`[subagent:local] Error: ${errMsg}`);
        return {
            success: false,
            sessionId: null,
            model: params.model,
            responseText: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            durationMs,
            modelUsage: {},
            usedWriteTools: false,
            toolsUsed: [],
            error: errMsg,
        };
    }
    // Map LocalAgentResult -> SubagentResult
    // Build a ModelUsage entry compatible with the SDK's ModelUsage type
    const modelUsage = {};
    if (localResult.inputTokens > 0 || localResult.outputTokens > 0) {
        modelUsage[params.model] = {
            inputTokens: localResult.inputTokens,
            outputTokens: localResult.outputTokens,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0, // Local models are free
            contextWindow: localModelConfig.context_window,
            maxOutputTokens: 0, // Not tracked by local server
        };
    }
    const success = localResult.error === null;
    const result = {
        success,
        sessionId: null, // Local agents don't have SDK sessions
        model: params.model,
        responseText: localResult.responseText,
        inputTokens: localResult.inputTokens,
        outputTokens: localResult.outputTokens,
        costUsd: 0, // Local inference is free
        durationMs: localResult.durationMs,
        modelUsage,
        usedWriteTools: localResult.usedWriteTools,
        toolsUsed: localResult.toolsUsed,
        error: localResult.error,
    };
    console.log(`[subagent:local] Complete: success=${result.success} turns=${localResult.turns} tokens=${result.inputTokens}/${result.outputTokens} duration=${result.durationMs}ms`);
    return result;
}
// ---------------------------------------------------------------------------
// Story 1.3: Claude agent adapter (extracted from original spawnSubagent)
// ---------------------------------------------------------------------------
/**
 * Spawn a Claude subagent via the SDK query() function.
 *
 * Iterates the full async message stream, collecting:
 * - session_id from the init message
 * - response text from the result message
 * - token usage and cost from the result message
 * - tool invocations for audit logging
 */
async function spawnClaudeSubagent(params) {
    const startTime = Date.now();
    const result = {
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
    const toolsUsedSet = new Set();
    try {
        console.log(`[subagent:claude] Spawning with model=${params.model} tools=[${params.tools.join(",")}]`);
        const options = {
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
            abortController: params.abortController,
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
                const initMsg = message;
                result.sessionId = initMsg.session_id;
                result.model = initMsg.model;
                console.log(`[subagent:claude] Session initialized: id=${initMsg.session_id} model=${initMsg.model}`);
            }
            // Track tool usage from assistant messages (they contain tool_use content blocks)
            if (message.type === "assistant") {
                const assistantMsg = message;
                if (assistantMsg.message?.content) {
                    for (const block of assistantMsg.message.content) {
                        if ("type" in block && block.type === "tool_use" && "name" in block) {
                            const toolName = block.name;
                            toolsUsedSet.add(toolName);
                            if (writeToolNames.has(toolName)) {
                                result.usedWriteTools = true;
                                console.log(`[subagent:claude] WARNING: Write tool used: ${toolName}`);
                            }
                        }
                    }
                }
            }
            // Capture result
            if (message.type === "result") {
                const resultMsg = message;
                result.durationMs = resultMsg.duration_ms;
                result.costUsd = resultMsg.total_cost_usd;
                result.modelUsage = resultMsg.modelUsage;
                if (resultMsg.usage) {
                    result.inputTokens = resultMsg.usage.input_tokens;
                    result.outputTokens = resultMsg.usage.output_tokens;
                }
                if (resultMsg.subtype === "success") {
                    result.success = true;
                    result.responseText = resultMsg.result;
                }
                else {
                    const errorResult = resultMsg;
                    result.error = errorResult.errors?.join("; ") || `Subagent error: ${errorResult.subtype}`;
                }
            }
        }
        result.toolsUsed = Array.from(toolsUsedSet);
        // Story 1.4: Capture a single training turn entry for the entire Claude session
        if (params.workflowId) {
            try {
                const input = {
                    workflowId: params.workflowId,
                    workflowType: params.workflowType ?? "bug_fix",
                    backend: "claude",
                    model: result.model ?? params.model,
                    attemptNumber: params.attemptNumber ?? 0,
                    turnNumber: 0,
                    messagesIn: [{ role: "user", content: params.prompt }],
                    toolsAvailable: [...params.tools],
                    response: {
                        content: result.responseText,
                        tool_calls: undefined,
                    },
                    toolResults: result.toolsUsed.map((name) => ({
                        name,
                        result: "(claude sdk - details not captured)",
                    })),
                    tokensIn: result.inputTokens,
                    tokensOut: result.outputTokens,
                    durationMs: result.durationMs,
                    outcome: result.success ? "success" : (result.error ?? "error"),
                };
                captureTrainingTurn(input);
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(`[subagent:claude] Training capture failed (non-fatal): ${errMsg}`);
            }
        }
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        result.success = false;
        console.error(`[subagent:claude] Error: ${result.error}`);
    }
    // Detect API billing/quota errors that the SDK reports as "success" with zero tokens.
    const KNOWN_API_ERRORS = ["Credit balance is too low", "insufficient_quota", "billing"];
    if (result.responseText && result.inputTokens === 0 && result.outputTokens === 0) {
        const matchedError = KNOWN_API_ERRORS.find(err => result.responseText.toLowerCase().includes(err.toLowerCase()));
        if (matchedError) {
            result.success = false;
            result.error = "API billing error: " + result.responseText;
            console.error("[subagent:claude] BILLING ERROR DETECTED: " + result.responseText);
        }
    }
    // If durationMs wasn't set by the result message, calculate from wall clock
    if (result.durationMs === 0) {
        result.durationMs = Date.now() - startTime;
    }
    console.log(`[subagent:claude] Complete: success=${result.success} tokens=${result.inputTokens}/${result.outputTokens} duration=${result.durationMs}ms cost=$${result.costUsd.toFixed(4)}`);
    return result;
}
// ---------------------------------------------------------------------------
// Public entry point — routes to local or Claude backend
// ---------------------------------------------------------------------------
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
export async function spawnSubagent(params) {
    let backend = resolveBackend(params);
    // AC #10: CI detection — if local is selected but we're in an environment
    // without a local server (e.g. GitHub Actions), fall back to Claude
    if (backend === "local") {
        const localConfig = params.model === LOCAL_MODELS.BACKUP.id ? LOCAL_MODELS.BACKUP : LOCAL_MODELS.PRIMARY;
        const endpoint = localConfig.endpoint;
        const reachable = await isLocalEndpointReachable(endpoint);
        if (!reachable) {
            const hasExplicitEndpoint = !!process.env.LOCAL_MODEL_ENDPOINT;
            if (!hasExplicitEndpoint) {
                // No explicit endpoint configured and default is unreachable — likely CI
                console.warn(`[subagent] Local backend selected but endpoint unreachable (${endpoint}) and LOCAL_MODEL_ENDPOINT not set — falling back to Claude`);
                backend = "claude";
            }
            // If LOCAL_MODEL_ENDPOINT IS set but unreachable, spawnLocalAgent will
            // return a proper error (AC #9) rather than silently falling back
        }
    }
    console.log(`[subagent] Backend: ${backend} (explicit=${params.backend ?? "none"}, workflow=${params.workflowType ?? "none"})`);
    if (backend === "local") {
        return spawnLocalAgent(params);
    }
    return spawnClaudeSubagent(params);
}
/** Log SDK messages at appropriate detail level */
function logMessage(message) {
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
