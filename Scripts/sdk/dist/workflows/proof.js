/**
 * Story 1.3: First Subagent Proof (Haiku Read-Only)
 *
 * THE CRITICAL PROOF POINT. Spawns a Haiku subagent that:
 * 1. Reads game-repo/Data/Events/USHistory.json
 * 2. Counts the events
 * 3. Extracts the first event's title, year, and category
 * 4. Returns structured JSON
 *
 * Validates:
 * - The subagent returns valid JSON
 * - No write/edit tools were used (read-only enforcement)
 * - Logs model, token usage, and duration
 *
 * Exit codes:
 * - 0: Success (all validations passed)
 * - 1: Failure (any validation failed)
 */
import { MODELS, PROOF_TOOLS, PATHS } from "../config.js";
import { spawnSubagent } from "../lib/subagent.js";
import { extractJson } from "../lib/json-extract.js";
/** Run the Story 1.3 proof workflow */
export async function runProof() {
    console.log("=== Story 1.3: Haiku Read-Only Proof ===");
    console.log(`Model: ${MODELS.VERIFIER}`);
    console.log(`Tools: [${PROOF_TOOLS.join(", ")}]`);
    console.log(`Game repo path: ${PATHS.GAME_REPO}`);
    console.log("");
    const prompt = [
        `Read the file at ${PATHS.GAME_REPO}/Data/Events/USHistory.json.`,
        `Count the total number of events in the JSON array.`,
        `For the FIRST event in the array, extract its title, year, and category.`,
        `Output ONLY a JSON object with this exact structure (no markdown, no explanation, just raw JSON):`,
        `{`,
        `  "event_count": <number>,`,
        `  "first_event": {`,
        `    "title": "<string>",`,
        `    "year": <number>,`,
        `    "category": "<string>"`,
        `  }`,
        `}`,
    ].join("\n");
    const systemPrompt = [
        "You are a read-only verification agent.",
        "You MUST NOT write, edit, or create any files.",
        "You MUST NOT run any commands that modify the filesystem.",
        "Read the requested file, extract the requested data, and output ONLY the JSON result.",
        "Do not wrap the JSON in markdown code blocks. Output raw JSON only.",
    ].join(" ");
    // Resolve repo root: where game-repo/ is checked out.
    // - CI: GITHUB_WORKSPACE is set automatically by Actions (not affected by working-directory)
    // - Local: SDK_REPO_ROOT override, or run from repo root so process.cwd() is correct
    const repoRoot = process.env.GITHUB_WORKSPACE
        ?? process.env.SDK_REPO_ROOT
        ?? process.cwd();
    // Spawn the Haiku subagent with cwd at repo root so game-repo/ is accessible
    const result = await spawnSubagent({
        model: MODELS.VERIFIER,
        tools: [...PROOF_TOOLS],
        prompt,
        systemPrompt,
        cwd: repoRoot,
        maxTurns: 15,
    });
    console.log("");
    console.log("=== Proof Results ===");
    // Validation 1: Subagent completed successfully
    if (!result.success) {
        console.error("FAIL: Subagent did not complete successfully");
        console.error(`Error: ${result.error}`);
        process.exit(1);
    }
    console.log("PASS: Subagent completed successfully");
    // Validation 2: No write tools used
    if (result.usedWriteTools) {
        console.error("FAIL: Subagent used write/edit tools (read-only violation)");
        console.error(`Tools used: ${result.toolsUsed.join(", ")}`);
        process.exit(1);
    }
    console.log("PASS: No write/edit tools used (read-only confirmed)");
    // Validation 3: Response is valid JSON
    if (!result.responseText) {
        console.error("FAIL: No response text from subagent");
        process.exit(1);
    }
    let parsedResponse;
    try {
        // Extract JSON from response — Haiku may add narrative text around it
        const jsonText = extractJson(result.responseText);
        parsedResponse = JSON.parse(jsonText);
    }
    catch (err) {
        console.error("FAIL: Response is not valid JSON");
        console.error(`Raw response: ${result.responseText}`);
        console.error(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    console.log("PASS: Response is valid JSON");
    // Validation 4: Response has expected structure
    if (typeof parsedResponse.event_count !== "number" || parsedResponse.event_count < 1) {
        console.error("FAIL: event_count is not a valid positive number");
        console.error(`Got: ${JSON.stringify(parsedResponse)}`);
        process.exit(1);
    }
    console.log(`PASS: event_count = ${parsedResponse.event_count}`);
    if (!parsedResponse.first_event ||
        typeof parsedResponse.first_event.title !== "string" ||
        typeof parsedResponse.first_event.year !== "number" ||
        typeof parsedResponse.first_event.category !== "string") {
        console.error("FAIL: first_event does not have expected structure");
        console.error(`Got: ${JSON.stringify(parsedResponse.first_event)}`);
        process.exit(1);
    }
    console.log(`PASS: first_event = "${parsedResponse.first_event.title}" (${parsedResponse.first_event.year}) [${parsedResponse.first_event.category}]`);
    // Log metrics (required by acceptance criteria)
    console.log("");
    console.log("=== Metrics ===");
    console.log(`Model: ${result.model ?? MODELS.VERIFIER}`);
    console.log(`Session ID: ${result.sessionId}`);
    console.log(`Input tokens: ${result.inputTokens}`);
    console.log(`Output tokens: ${result.outputTokens}`);
    console.log(`Duration: ${result.durationMs}ms`);
    console.log(`Cost: $${result.costUsd.toFixed(4)}`);
    console.log(`Tools used: [${result.toolsUsed.join(", ")}]`);
    if (Object.keys(result.modelUsage).length > 0) {
        console.log("Per-model usage:");
        for (const [model, usage] of Object.entries(result.modelUsage)) {
            console.log(`  ${model}: in=${usage.inputTokens} out=${usage.outputTokens} cost=$${usage.costUSD.toFixed(4)}`);
        }
    }
    console.log("");
    console.log("=== Story 1.3 PROOF PASSED ===");
    console.log(`Haiku subagent successfully read ${parsedResponse.event_count} events from USHistory.json`);
}
