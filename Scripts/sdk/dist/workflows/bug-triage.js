/**
 * Story 4.1: Bug Triager Subagent
 *
 * Spawns a Haiku subagent to classify bug reports into one of 6 categories:
 * content_error, translation_error, ui_bug, gameplay_bug, feature_request, needs_human_review
 *
 * Returns structured JSON with classification, severity, confidence,
 * reasoning, extracted_context, and routing_recommendation.
 *
 * JSON parsing uses the proven regex + brace fallback from proof.ts (ATT-004).
 *
 * Exit codes:
 * - 0: Success (valid triage result returned)
 * - 1: Failure (subagent error, invalid JSON, missing required fields)
 */
import { MODELS, TRIAGE_TOOLS, CLASSIFICATION_SET } from "../config.js";
import { spawnSubagent } from "../lib/subagent.js";
import { extractJson } from "../lib/json-extract.js";
import { stripBase64Images } from "../lib/image-extract.js";
import * as fs from "node:fs";
import * as path from "node:path";
/** Valid classification values — imported from config.ts (BA-011 AC1: single source of truth) */
const VALID_CLASSIFICATIONS = CLASSIFICATION_SET;
/** Valid severity values */
const VALID_SEVERITIES = new Set(["P1", "P2", "P3", "P4"]);
/**
 * Validate that the parsed object has all required triage fields.
 * Returns an array of validation error messages (empty = valid).
 */
function validateTriageResult(obj) {
    const errors = [];
    if (typeof obj.classification !== "string" || !VALID_CLASSIFICATIONS.has(obj.classification)) {
        errors.push("Invalid classification: \"" + String(obj.classification) + "\". Must be one of: " + Array.from(VALID_CLASSIFICATIONS).join(", "));
    }
    if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
        errors.push("Invalid confidence: " + String(obj.confidence) + ". Must be a number between 0.0 and 1.0");
    }
    if (typeof obj.severity !== "string" || !VALID_SEVERITIES.has(obj.severity)) {
        errors.push("Invalid severity: \"" + String(obj.severity) + "\". Must be one of: " + Array.from(VALID_SEVERITIES).join(", "));
    }
    if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
        errors.push("Missing or empty reasoning field");
    }
    if (typeof obj.extracted_context !== "object" || obj.extracted_context === null) {
        errors.push("Missing extracted_context object");
    }
    if (typeof obj.routing_recommendation !== "string" || obj.routing_recommendation.length === 0) {
        errors.push("Missing or empty routing_recommendation field");
    }
    return errors;
}
/** Run the bug triage workflow */
export async function runTriage(input) {
    const reportId = input.report_id ?? "unknown";
    const imageCount = input.images?.length ?? 0;
    console.log("=== Story 4.1: Bug Triage — Report " + reportId + " ===");
    console.log("Model: " + MODELS.VERIFIER);
    console.log("Tools: [" + TRIAGE_TOOLS.join(", ") + "]");
    console.log("Screenshots: " + imageCount + " image(s) attached");
    console.log("Report text: \"" + input.report_text + "\"");
    console.log("");
    // Resolve repo root — same pattern as proof.ts (ATT-003)
    const repoRoot = process.env.GITHUB_WORKSPACE
        ?? process.env.SDK_REPO_ROOT
        ?? process.cwd();
    // Load system prompt from prompts/bug-triager.md
    // The prompt file is in the source tree, not dist — resolve relative to repo root
    const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    let systemPrompt;
    try {
        systemPrompt = fs.readFileSync(promptPath, "utf-8");
    }
    catch (err) {
        console.error("FAIL: Could not read system prompt at " + promptPath);
        console.error("Error: " + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
    }
    // Strip base64 images from report text to avoid sending raw base64 as text tokens.
    // Images are passed separately as multimodal content blocks (if provided by caller).
    const cleanReportText = stripBase64Images(input.report_text);
    // Build user prompt — classify from text + screenshots only (PV2-5.1: no file searching)
    const userPrompt = [
        "Classify the following bug report for the SortingHistory iOS game.",
        "",
        "## Bug Report",
        "Report ID: " + reportId,
        (imageCount > 0
            ? "(This report includes " + imageCount + " screenshot(s) — see attached images for visual evidence)"
            : "(No screenshots attached)"),
        "\"" + cleanReportText + "\"",
        "",
        "## Instructions",
        "1. Read the bug report carefully (and examine any attached screenshots)",
        "2. Classify the report and return your TRIAGE RESULT as a JSON object with these keys: classification, confidence, severity, reasoning, extracted_context, routing_recommendation",
    ].join("\n");
    // Spawn Haiku subagent with read-only triage tools
    // Pass screenshots as multimodal image blocks so the model can analyze visual bugs
    const result = await spawnSubagent({
        model: MODELS.VERIFIER,
        tools: [...TRIAGE_TOOLS],
        prompt: userPrompt,
        systemPrompt,
        cwd: repoRoot,
        maxTurns: 5,
        images: input.images,
    });
    console.log("");
    console.log("=== Triage Results — Report " + reportId + " ===");
    // Validation 1: Subagent completed successfully
    if (!result.success) {
        if (result.error?.includes("API billing error") || result.responseText?.includes("Credit balance")) {
            console.error("FAIL: Anthropic API credit balance depleted.");
            console.error("Top up credits at https://console.anthropic.com before retrying.");
            console.error("Pipeline will not retry — this is a billing issue, not a bug.");
        }
        else {
            console.error("FAIL: Subagent did not complete successfully");
            console.error("Error: " + result.error);
        }
        process.exit(1);
    }
    console.log("PASS: Subagent completed successfully");
    // Validation 2: No write tools used (read-only enforcement)
    if (result.usedWriteTools) {
        console.error("FAIL: Subagent used write/edit tools (read-only violation)");
        console.error("Tools used: " + result.toolsUsed.join(", "));
        process.exit(1);
    }
    console.log("PASS: No write/edit tools used (read-only confirmed)");
    // Validation 3: Response exists
    if (!result.responseText) {
        console.error("FAIL: No response text from subagent");
        process.exit(1);
    }
    // Validation 4: Parse JSON from response (defensive — ATT-004 pattern)
    let parsed;
    try {
        const jsonText = extractJson(result.responseText, "classification");
        parsed = JSON.parse(jsonText);
    }
    catch (err) {
        console.error("FAIL: Response is not valid JSON");
        console.error("Raw response: " + result.responseText);
        console.error("Parse error: " + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
    }
    console.log("PASS: Response is valid JSON");
    // Validation 5: Required fields present and valid
    const validationErrors = validateTriageResult(parsed);
    if (validationErrors.length > 0) {
        console.error("FAIL: Triage result validation failed:");
        for (const ve of validationErrors) {
            console.error("  - " + ve);
        }
        console.error("Parsed result: " + JSON.stringify(parsed, null, 2));
        process.exit(1);
    }
    console.log("PASS: All required fields present and valid");
    const triageResult = {
        classification: parsed.classification,
        confidence: parsed.confidence,
        severity: parsed.severity,
        reasoning: parsed.reasoning,
        extracted_context: parsed.extracted_context,
        routing_recommendation: parsed.routing_recommendation,
    };
    // Log the result
    console.log("");
    console.log("Classification: " + triageResult.classification);
    console.log("Confidence: " + triageResult.confidence);
    console.log("Severity: " + triageResult.severity);
    console.log("Reasoning: " + triageResult.reasoning);
    console.log("Routing: " + triageResult.routing_recommendation);
    if (Object.keys(triageResult.extracted_context).length > 0) {
        console.log("Context: " + JSON.stringify(triageResult.extracted_context, null, 2));
    }
    // Log metrics (including screenshot cost tracking for PV2-1.4)
    console.log("");
    console.log("=== Metrics ===");
    console.log("Model: " + (result.model ?? MODELS.VERIFIER));
    console.log("Session ID: " + result.sessionId);
    console.log("Screenshots sent: " + imageCount);
    console.log("Input tokens: " + result.inputTokens);
    console.log("Output tokens: " + result.outputTokens);
    console.log("Duration: " + result.durationMs + "ms");
    console.log("Cost: $" + result.costUsd.toFixed(4));
    if (imageCount > 0) {
        console.log("Cost with screenshots: $" + result.costUsd.toFixed(4) + " (target: ~$0.03-0.05/bug)");
    }
    console.log("Tools used: [" + result.toolsUsed.join(", ") + "]");
    if (Object.keys(result.modelUsage).length > 0) {
        console.log("Per-model usage:");
        for (const [model, usage] of Object.entries(result.modelUsage)) {
            console.log("  " + model + ": in=" + usage.inputTokens + " out=" + usage.outputTokens + " cost=$" + usage.costUSD.toFixed(4));
        }
    }
    console.log("");
    console.log("=== Triage COMPLETE — Report " + reportId + ": " + triageResult.classification + " (" + triageResult.severity + ") ===");
    return triageResult;
}
