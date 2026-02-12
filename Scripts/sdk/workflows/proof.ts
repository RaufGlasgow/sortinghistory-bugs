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

import { MODELS, VERIFIER_TOOLS, PATHS } from "../config.js";
import { spawnSubagent, type SubagentResult } from "../lib/subagent.js";

/** Expected shape of the subagent's JSON response */
interface ProofResponse {
  event_count: number;
  first_event: {
    title: string;
    year: number;
    category: string;
  };
}

/** Run the Story 1.3 proof workflow */
export async function runProof(): Promise<void> {
  console.log("=== Story 1.3: Haiku Read-Only Proof ===");
  console.log(`Model: ${MODELS.VERIFIER}`);
  console.log(`Tools: [${VERIFIER_TOOLS.join(", ")}]`);
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

  // Resolve repo root (two levels up from Scripts/sdk/)
  const repoRoot = new URL("../../", import.meta.url).pathname;

  // Spawn the Haiku subagent with cwd at repo root so game-repo/ is accessible
  const result: SubagentResult = await spawnSubagent({
    model: MODELS.VERIFIER,
    tools: [...VERIFIER_TOOLS],
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

  let parsedResponse: ProofResponse;
  try {
    // The response may contain markdown code block wrapping, strip it
    let jsonText = result.responseText.trim();
    // Remove ```json ... ``` wrapper if present
    if (jsonText.startsWith("```")) {
      const lines = jsonText.split("\n");
      // Remove first line (```json) and last line (```)
      lines.shift();
      if (lines.length > 0 && lines[lines.length - 1]!.trim() === "```") {
        lines.pop();
      }
      jsonText = lines.join("\n");
    }
    parsedResponse = JSON.parse(jsonText) as ProofResponse;
  } catch (err: unknown) {
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
