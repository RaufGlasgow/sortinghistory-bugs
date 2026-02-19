/**
 * Story PV2-3.1: QA Review Module + Code QA Profile
 * Story PV2-3.2: Content QA Profile + "Both" Merge Logic
 *
 * Spawns a SEPARATE read-only subagent to evaluate a bug fix diff against
 * the original bug report. The QA subagent has NO write tools — it can
 * only Read, Glob, and Grep to inspect surrounding code context.
 *
 * The QA gate is a standalone library module. It:
 *   - Does NOT call GitHub APIs or modify issues
 *   - Does NOT update workflow state
 *   - Returns a structured QAVerdict for the caller to act on
 *
 * The caller (bug-fix.ts in PV2-3.3) handles posting comments,
 * updating state, and deciding whether to retry or escalate.
 *
 * Model selection:
 *   - Uses the qaModel from ModelSelection (model-router.ts)
 *   - Haiku for single-file diffs, Sonnet for multi-file diffs
 *   - Content QA overrides to Sonnet when >= 3 JSON files changed (PV2-3.2)
 *
 * QA profiles:
 *   - "code" — uses prompts/qa-reviewer-code.md (PV2-3.1)
 *   - "content" — uses prompts/qa-reviewer-content.md (PV2-3.2)
 *   - "both" — runs code QA first, then content QA, merges verdicts (PV2-3.2)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { QA_TOOLS, MODELS } from "../config.js";
import { spawnSubagent, type SubagentResult } from "./subagent.js";
import { extractJson } from "./json-extract.js";
import type { QAProfile } from "./model-router.js";
import type { ExtractedImage } from "./image-extract.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** A single finding from the QA reviewer */
export interface QAFinding {
  /** Which evaluation criterion triggered this finding */
  criterion: "QC-1" | "QC-2" | "QC-3" | "QC-4" | "QC-5" | "QN-1" | "QN-2" | "QN-3" | "QN-4" | "QN-5";
  /** Severity: blocker prevents merge, warning is advisory, info is observational */
  severity: "blocker" | "warning" | "info";
  /** File path the finding refers to */
  file: string;
  /** Description of the finding, referencing specific code/lines */
  description: string;
}

/** Structured verdict from the QA reviewer subagent */
export interface QAVerdict {
  /** Overall verdict */
  verdict: "approved" | "needs_revision" | "rejected";
  /** Risk assessment of the diff */
  risk_level: "low" | "medium" | "high";
  /** Specific findings from the review */
  findings: QAFinding[];
  /** Human-readable summary of the review */
  summary: string;
}

/** Input parameters for runQAReview() */
export interface QAInput {
  /** The original bug report title */
  bugTitle: string;
  /** The original bug report body (base64 images already stripped) */
  bugBody: string;
  /** Triage classification (e.g. "ui_bug", "gameplay_bug", "content_error") */
  triageClassification: string;
  /** Triage analysis comment, if available */
  triageComment: string | null;
  /** Complete git diff of the fix */
  diff: string;
  /** List of files changed in the diff */
  changedFiles: string[];
  /** Path to the game repo for code context access */
  gameRepoPath: string;
  /** Model ID to use for QA (from model-router selectModels().qaModel) */
  qaModel: string;
  /** Max agentic turns for the QA subagent (from model-router selectModels().qaMaxTurns) */
  qaMaxTurns: number;
  /** QA profile: determines which prompt to use */
  qaProfile: QAProfile;
  /** Current attempt number (1-based) */
  attemptNumber: number;
  /** Optional screenshots from the bug report */
  images?: ExtractedImage[];
  /** Pre-computed event count context for content QA (e.g. "USHistory.json: 142 events (minimum: 100)") */
  eventCountContext?: string;
}

/** Result from runQAReview() */
export interface QAResult {
  /** Whether the QA review completed successfully (not whether the fix passed) */
  success: boolean;
  /** The structured verdict, or null if parsing failed */
  verdict: QAVerdict | null;
  /** Subagent metrics for cost tracking */
  metrics: {
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    costUsd: number;
  } | null;
  /** Error message if the QA review itself failed */
  error: string | null;
}

// ------------------------------------------------------------------
// Prompt file map
// ------------------------------------------------------------------

/**
 * Map single QA profile to the system prompt file name.
 * The "both" profile is not in this map — it runs code then content
 * as two separate subagent calls and merges the results.
 */
const PROMPT_FILES: Record<"code" | "content", string> = {
  code: "qa-reviewer-code.md",
  content: "qa-reviewer-content.md",
};

// ------------------------------------------------------------------
// Verdict / risk ranking for "both" profile merge (PV2-3.2)
// ------------------------------------------------------------------

const VERDICT_RANK: Record<QAVerdict["verdict"], number> = {
  approved: 0,
  needs_revision: 1,
  rejected: 2,
};

const RISK_RANK: Record<QAVerdict["risk_level"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Load the QA system prompt from the prompts/ directory.
 *
 * @param profile - Single QA profile ("code" or "content") to select the right prompt.
 *   The "both" profile calls this twice — once for each.
 * @returns System prompt text
 * @throws If the prompt file does not exist
 */
function loadSystemPrompt(profile: "code" | "content"): string {
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  const promptFile = PROMPT_FILES[profile];
  const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", promptFile);

  if (!fs.existsSync(promptPath)) {
    throw new Error(
      "QA system prompt not found: " + promptPath +
      " (profile: " + profile + "). Ensure the prompt file exists."
    );
  }

  return fs.readFileSync(promptPath, "utf-8");
}

/**
 * Build the user prompt that provides the QA reviewer with all context.
 *
 * Includes: bug report, triage classification, complete diff, and
 * instructions for what surrounding context to inspect.
 *
 * @param input - QA review input
 * @param singleProfile - The specific profile for this prompt ("code" or "content").
 *   Used to tailor the task instructions and include content-specific context.
 */
function buildUserPrompt(input: QAInput, singleProfile: "code" | "content"): string {
  const parts: string[] = [];

  parts.push("Review the following bug fix diff for the SortingHistory iOS game.");
  parts.push("");

  // Bug report context
  parts.push("## Bug Report");
  parts.push("**Title:** " + input.bugTitle);
  parts.push("");
  parts.push(input.bugBody);
  parts.push("");

  // Triage classification
  parts.push("## Triage Classification");
  parts.push("**Type:** " + input.triageClassification);
  if (input.triageComment) {
    parts.push("");
    parts.push(input.triageComment);
  }
  parts.push("");

  // Attempt context
  parts.push("## Fix Attempt");
  parts.push("**Attempt number:** " + input.attemptNumber);
  parts.push("**Files changed:** " + input.changedFiles.join(", "));
  parts.push("");

  // Content-specific: event count context (PV2-3.2)
  if (singleProfile === "content" && input.eventCountContext) {
    parts.push("## Event Count Context");
    parts.push(input.eventCountContext);
    parts.push("");
  }

  // The diff itself
  parts.push("## Complete Diff");
  parts.push("```diff");
  parts.push(input.diff);
  parts.push("```");
  parts.push("");

  // Instructions for using read-only tools — tailored by profile
  parts.push("## Your Task");
  parts.push("1. Read the bug report and triage classification to understand the expected fix");
  parts.push("2. Read the diff carefully to understand what was changed");
  parts.push("3. Use Read/Glob/Grep to inspect surrounding code in the changed files for regression risk");

  if (singleProfile === "code") {
    parts.push("4. Evaluate the diff against all 5 QC criteria (QC-1 through QC-5)");
  } else {
    parts.push("4. Evaluate the diff against all 5 QN criteria (QN-1 through QN-5)");
  }
  parts.push("5. Output your JSON verdict");

  return parts.join("\n");
}

/**
 * Parse the QA verdict from the subagent's response text.
 *
 * Uses extractJson() with "verdict" as the required key to find the
 * correct JSON block even if the model wraps it in narrative.
 */
function parseVerdict(responseText: string): QAVerdict | null {
  try {
    const jsonText = extractJson(responseText, "verdict");
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;

    // Validate required fields
    if (
      typeof parsed.verdict !== "string" ||
      !["approved", "needs_revision", "rejected"].includes(parsed.verdict)
    ) {
      console.log("[qa-gate] WARNING: Invalid verdict value: " + String(parsed.verdict));
      return null;
    }

    if (
      typeof parsed.risk_level !== "string" ||
      !["low", "medium", "high"].includes(parsed.risk_level)
    ) {
      console.log("[qa-gate] WARNING: Invalid risk_level value: " + String(parsed.risk_level));
      return null;
    }

    if (!Array.isArray(parsed.findings)) {
      console.log("[qa-gate] WARNING: findings is not an array");
      return null;
    }

    if (typeof parsed.summary !== "string") {
      console.log("[qa-gate] WARNING: summary is not a string");
      return null;
    }

    // Validate each finding
    const validFindings: QAFinding[] = [];
    for (const f of parsed.findings) {
      if (
        typeof f === "object" && f !== null &&
        typeof (f as Record<string, unknown>).criterion === "string" &&
        typeof (f as Record<string, unknown>).severity === "string" &&
        typeof (f as Record<string, unknown>).file === "string" &&
        typeof (f as Record<string, unknown>).description === "string"
      ) {
        validFindings.push({
          criterion: (f as Record<string, unknown>).criterion as QAFinding["criterion"],
          severity: (f as Record<string, unknown>).severity as QAFinding["severity"],
          file: (f as Record<string, unknown>).file as string,
          description: (f as Record<string, unknown>).description as string,
        });
      } else {
        console.log("[qa-gate] WARNING: Skipping malformed finding: " + JSON.stringify(f));
      }
    }

    return {
      verdict: parsed.verdict as QAVerdict["verdict"],
      risk_level: parsed.risk_level as QAVerdict["risk_level"],
      findings: validFindings,
      summary: parsed.summary as string,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[qa-gate] WARNING: Could not parse verdict JSON: " + errMsg);
    return null;
  }
}

/**
 * Convert a QAVerdict to the QAVerdictEntry format used by workflow state.
 *
 * Maps: approved -> "pass", rejected -> "fail", needs_revision -> "partial"
 * Flattens findings to string descriptions for the state log.
 */
export function toVerdictEntry(
  verdict: QAVerdict,
  attemptNumber: number,
): { attempt_number: number; verdict: string; findings: string[]; summary: string; timestamp: string } {
  const verdictMap: Record<QAVerdict["verdict"], string> = {
    approved: "pass",
    needs_revision: "partial",
    rejected: "fail",
  };

  return {
    attempt_number: attemptNumber,
    verdict: verdictMap[verdict.verdict],
    findings: verdict.findings.map(
      (f) => "[" + f.criterion + "/" + f.severity + "] " + f.file + ": " + f.description,
    ),
    summary: verdict.summary,
    timestamp: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------
// Single-profile review (inner function)
// ------------------------------------------------------------------

/**
 * Run a single-profile QA review (code OR content, not both).
 *
 * Spawns a SEPARATE read-only subagent (not the fixer) with only
 * Read/Glob/Grep tools. The subagent evaluates the diff against the
 * criteria for its profile and returns a structured verdict.
 *
 * This function:
 *   - Loads the appropriate system prompt based on single profile
 *   - Builds the user prompt with all context
 *   - Applies content model override when >= 3 JSON files changed
 *   - Spawns the subagent via spawnSubagent()
 *   - Parses and validates the structured JSON verdict
 *   - Returns a QAResult with the verdict and metrics
 *
 * It does NOT:
 *   - Call GitHub APIs
 *   - Modify issues or PRs
 *   - Update workflow state
 *   - Post comments
 *
 * @param input - QA review input with bug context, diff, and model config
 * @param singleProfile - "code" or "content" (not "both")
 * @returns QAResult with verdict and metrics
 */
async function runSingleProfileReview(
  input: QAInput,
  singleProfile: "code" | "content",
): Promise<QAResult> {
  console.log("=== QA Review (" + singleProfile + " profile) ===");

  // --------------------------------------------------
  // Step 1: Determine model — content profile may override
  // --------------------------------------------------
  let actualModel = input.qaModel;
  if (singleProfile === "content") {
    const jsonFileCount = input.changedFiles.filter(f => f.endsWith(".json")).length;
    if (jsonFileCount >= 3) {
      actualModel = MODELS.FIXER; // Override to Sonnet for complex content reviews
      console.log("[qa-gate] Content model override: " + jsonFileCount + " JSON files -> Sonnet");
    }
  }

  console.log("  Model: " + actualModel);
  console.log("  Profile: " + singleProfile);
  console.log("  Attempt: " + input.attemptNumber);
  console.log("  Changed files: " + input.changedFiles.length);
  console.log("  Tools: [" + QA_TOOLS.join(", ") + "]");
  console.log("");

  // --------------------------------------------------
  // Step 2: Load system prompt
  // --------------------------------------------------
  let systemPrompt: string;
  try {
    systemPrompt = loadSystemPrompt(singleProfile);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[qa-gate] FATAL: " + errMsg);
    return {
      success: false,
      verdict: null,
      metrics: null,
      error: errMsg,
    };
  }

  // --------------------------------------------------
  // Step 3: Build user prompt
  // --------------------------------------------------
  const userPrompt = buildUserPrompt(input, singleProfile);
  console.log("[qa-gate] Prompt length: " + userPrompt.length + " chars");
  console.log("[qa-gate] System prompt length: " + systemPrompt.length + " chars");

  // --------------------------------------------------
  // Step 4: Spawn read-only QA subagent
  // --------------------------------------------------
  console.log("[qa-gate] Spawning QA subagent (" + singleProfile + ")...");

  let result: SubagentResult;
  try {
    result = await spawnSubagent({
      model: actualModel,
      tools: [...QA_TOOLS],
      prompt: userPrompt,
      systemPrompt,
      cwd: input.gameRepoPath,
      maxTurns: input.qaMaxTurns,
      images: input.images,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[qa-gate] Subagent spawn failed: " + errMsg);
    return {
      success: false,
      verdict: null,
      metrics: null,
      error: "QA subagent spawn failed (" + singleProfile + "): " + errMsg,
    };
  }

  // --------------------------------------------------
  // Step 5: Log metrics
  // --------------------------------------------------
  console.log("");
  console.log("[qa-gate] Subagent complete (" + singleProfile + ")");
  console.log("  Model: " + (result.model ?? actualModel));
  console.log("  Session ID: " + result.sessionId);
  console.log("  Input tokens: " + result.inputTokens);
  console.log("  Output tokens: " + result.outputTokens);
  console.log("  Duration: " + result.durationMs + "ms");
  console.log("  Cost: $" + result.costUsd.toFixed(4));
  console.log("  Tools used: [" + result.toolsUsed.join(", ") + "]");
  console.log("  Used write tools: " + result.usedWriteTools);
  console.log("");

  const metrics = {
    model: result.model ?? actualModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
  };

  // Safety check: QA subagent should NEVER use write tools
  if (result.usedWriteTools) {
    console.error("[qa-gate] CRITICAL: QA subagent used write tools! Tools: [" + result.toolsUsed.join(", ") + "]");
    console.error("[qa-gate] This should be impossible with QA_TOOLS=[" + QA_TOOLS.join(", ") + "]");
    // Still continue with the review — the tool restriction at SDK level
    // should have blocked the writes, but log it as a safety concern
  }

  if (!result.success) {
    console.error("[qa-gate] Subagent failed (" + singleProfile + "): " + result.error);
    return {
      success: false,
      verdict: null,
      metrics,
      error: "QA subagent failed (" + singleProfile + "): " + (result.error ?? "unknown error"),
    };
  }

  // --------------------------------------------------
  // Step 6: Parse structured verdict
  // --------------------------------------------------
  if (!result.responseText) {
    console.log("[qa-gate] WARNING: No response text from QA subagent (" + singleProfile + ")");
    return {
      success: false,
      verdict: null,
      metrics,
      error: "QA subagent returned no response text (" + singleProfile + ")",
    };
  }

  const verdict = parseVerdict(result.responseText);
  if (!verdict) {
    console.log("[qa-gate] WARNING: Could not parse QA verdict from response (" + singleProfile + ")");
    console.log("[qa-gate] Response text (first 500 chars): " + result.responseText.slice(0, 500));
    return {
      success: false,
      verdict: null,
      metrics,
      error: "Could not parse QA verdict from subagent response (" + singleProfile + ")",
    };
  }

  // --------------------------------------------------
  // Step 7: Log verdict
  // --------------------------------------------------
  console.log("[qa-gate] QA Verdict (" + singleProfile + "): " + verdict.verdict);
  console.log("[qa-gate] Risk level: " + verdict.risk_level);
  console.log("[qa-gate] Findings: " + verdict.findings.length);
  for (const f of verdict.findings) {
    console.log("  [" + f.criterion + "/" + f.severity + "] " + f.file + ": " + f.description);
  }
  console.log("[qa-gate] Summary: " + verdict.summary);
  console.log("");
  console.log("=== QA Review (" + singleProfile + ") " + verdict.verdict.toUpperCase() + " ===");

  return {
    success: true,
    verdict,
    metrics,
    error: null,
  };
}

// ------------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------------

/**
 * Run a QA review on a bug fix diff.
 *
 * For "code" or "content" profiles, runs a single subagent review.
 * For "both" profile, runs code QA first, then content QA, then
 * merges the two verdicts (worst verdict wins, findings concatenated).
 *
 * @param input - QA review input with bug context, diff, and model config
 * @returns QAResult with verdict and metrics
 */
export async function runQAReview(input: QAInput): Promise<QAResult> {
  console.log("=== PV2-3.1/3.2: QA Review ===");
  console.log("  Profile: " + input.qaProfile);
  console.log("  Model: " + input.qaModel);
  console.log("  Attempt: " + input.attemptNumber);
  console.log("  Changed files: " + input.changedFiles.length);
  console.log("");

  // Single profile: delegate directly
  if (input.qaProfile === "code" || input.qaProfile === "content") {
    return runSingleProfileReview(input, input.qaProfile);
  }

  // --------------------------------------------------
  // "both" profile: run code then content, merge results
  // --------------------------------------------------
  console.log("[qa-gate] Running combined 'both' profile: code first, then content");
  console.log("");

  // --- Run code QA ---
  const codeResult = await runSingleProfileReview(input, "code");
  console.log("");

  // --- Run content QA (always, regardless of code verdict) ---
  const contentResult = await runSingleProfileReview(input, "content");
  console.log("");

  // --- Merge results ---
  console.log("[qa-gate] Merging 'both' profile results...");

  // If both failed at the infrastructure level, return combined error
  if (!codeResult.success && !contentResult.success) {
    return {
      success: false,
      verdict: null,
      metrics: mergeMetrics(codeResult.metrics, contentResult.metrics),
      error: "Both QA profiles failed: code=[" + (codeResult.error ?? "unknown") + "] content=[" + (contentResult.error ?? "unknown") + "]",
    };
  }

  // If one failed at infrastructure level but the other succeeded,
  // treat the failed one as a "rejected" verdict for merge purposes
  const codeVerdict = codeResult.verdict ?? {
    verdict: "rejected" as const,
    risk_level: "high" as const,
    findings: [{
      criterion: "QC-1" as const,
      severity: "blocker" as const,
      file: "N/A",
      description: "Code QA review failed to complete: " + (codeResult.error ?? "unknown error"),
    }],
    summary: "Code QA review did not complete successfully.",
  };

  const contentVerdict = contentResult.verdict ?? {
    verdict: "rejected" as const,
    risk_level: "high" as const,
    findings: [{
      criterion: "QN-1" as const,
      severity: "blocker" as const,
      file: "N/A",
      description: "Content QA review failed to complete: " + (contentResult.error ?? "unknown error"),
    }],
    summary: "Content QA review did not complete successfully.",
  };

  // Worst verdict wins
  const finalVerdict: QAVerdict["verdict"] =
    VERDICT_RANK[codeVerdict.verdict] >= VERDICT_RANK[contentVerdict.verdict]
      ? codeVerdict.verdict
      : contentVerdict.verdict;

  const finalRisk: QAVerdict["risk_level"] =
    RISK_RANK[codeVerdict.risk_level] >= RISK_RANK[contentVerdict.risk_level]
      ? codeVerdict.risk_level
      : contentVerdict.risk_level;

  const mergedVerdict: QAVerdict = {
    verdict: finalVerdict,
    risk_level: finalRisk,
    findings: [...codeVerdict.findings, ...contentVerdict.findings],
    summary: codeVerdict.summary + " | " + contentVerdict.summary,
  };

  console.log("[qa-gate] Merged verdict: " + mergedVerdict.verdict);
  console.log("[qa-gate] Merged risk: " + mergedVerdict.risk_level);
  console.log("[qa-gate] Total findings: " + mergedVerdict.findings.length);
  console.log("[qa-gate] Code verdict: " + codeVerdict.verdict + " / Content verdict: " + contentVerdict.verdict);
  console.log("");
  console.log("=== QA Review (both) " + mergedVerdict.verdict.toUpperCase() + " ===");

  return {
    success: true,
    verdict: mergedVerdict,
    metrics: mergeMetrics(codeResult.metrics, contentResult.metrics),
    error: null,
  };
}

/**
 * Merge metrics from two QA profile runs.
 * Sums tokens and costs, takes the longer duration, uses the model from
 * whichever run was non-null (prefers code model label).
 */
function mergeMetrics(
  a: QAResult["metrics"],
  b: QAResult["metrics"],
): QAResult["metrics"] {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  return {
    model: a.model ?? b.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    durationMs: a.durationMs + b.durationMs,
    costUsd: a.costUsd + b.costUsd,
  };
}
