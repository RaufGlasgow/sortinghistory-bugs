/**
 * Story PV2-4.1: Retry Loop Module
 *
 * Orchestrates the fix -> compile -> QA -> quality gate cycle with up to
 * MAX_FIX_ATTEMPTS attempts. Each retry escalates the model (via model-router)
 * and includes all previous failure context so the next attempt avoids
 * repeating failed approaches.
 *
 * Key behaviors:
 *   - On compile/QA failure: captures details, bans the approach, escalates model
 *   - On QA verdict "rejected": STOP immediately (no more retries)
 *   - On QA infrastructure failure: retry QA only (same diff, no new fix),
 *     with its own counter (max 2 retries, 5s delay), independent of fix attempts
 *   - On all attempts exhausted: generates a handoff document
 *   - Each attempt is logged to AttemptLogEntry
 *
 * This module is standalone -- it does NOT modify bug-fix.ts (that is PV2-4.2).
 * It imports and calls: model-router, qa-gate, quality-gate, handoff-generator, state.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { MODELS, BUG_FIX_TOOLS, LIMITS } from "../config.js";
import { spawnSubagent, type SubagentResult } from "./subagent.js";
import { buildBugFixHooksConfig } from "./hooks.js";
import { extractJson } from "./json-extract.js";
import {
  selectModels,
  determineBugProfile,
  determineQAProfile,
  type BugProfile,
  type ModelSelection,
} from "./model-router.js";
import { runQAReview, toVerdictEntry, type QAInput, type QAResult } from "./qa-gate.js";
import { runQualityGate, type QualityGateResult } from "./quality-gate.js";
import {
  generateHandoff,
  type HandoffInput,
  type HandoffResult,
  type AttemptLogSummary,
  type QAResultSummary,
} from "./handoff-generator.js";
import type { AttemptLogEntry, QAVerdictEntry, ModelUsageEntry } from "./state.js";
import type { ExtractedImage } from "./image-extract.js";
import { logPipelineEvent } from "./pipeline-log.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Maximum number of QA-only retries for infrastructure failures (AC10c) */
const MAX_QA_INFRA_RETRIES = 2;

/** Delay in milliseconds between QA infra retries (AC10c) */
const QA_INFRA_RETRY_DELAY_MS = 5_000;

/**
 * Patterns that indicate a retryable QA infrastructure error (AC10d).
 * Non-retryable errors (missing prompt file, invalid config) fall through
 * immediately without retry.
 */
const RETRYABLE_ERROR_PATTERNS: readonly string[] = [
  "credit balance",
  "timeout",
  "rate limit",
  "rate_limit",
  "ECONNREFUSED",
];

/** HTTP status codes that indicate retryable QA infrastructure errors (AC10d) */
const RETRYABLE_HTTP_CODES: readonly number[] = [429, 500, 502, 503];

/**
 * Per-attempt timeout in milliseconds (PV2-6.5 AC4).
 * Later attempts get more time because they use more capable models with larger context.
 * Increased after analysis showed subagents need 20+ minutes for code bugs.
 */
const ATTEMPT_TIMEOUT_MS: Record<number, number> = {
  1: 25 * 60 * 1000,  // 25 minutes for attempt 1 (Haiku/Sonnet)
  2: 35 * 60 * 1000,  // 35 minutes for attempt 2 (Sonnet/Opus)
  3: 45 * 60 * 1000,  // 45 minutes for attempt 3 (Opus)
};

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Context from the triage step, needed by the retry loop */
export interface TriageContext {
  classification: string;
  confidence: number;
  severity: string;
  reasoning: string;
  fileExtensions: string[];
}

/** Input parameters for runRetryLoop() -- AC1 */
export interface RetryLoopInput {
  /** Issue number from the private repo */
  issueNumber: number;
  /** Issue title */
  issueTitle: string;
  /** Issue body (base64 images already stripped) */
  issueBody: string;
  /** Triage result context */
  triage: TriageContext;
  /** Extracted screenshots from the bug report */
  screenshots: ExtractedImage[];
  /** Path to the game repo checkout */
  gameRepoPath: string;
  /** Maximum fix attempts (defaults to LIMITS.MAX_FIX_ATTEMPTS) */
  maxAttempts?: number;
  /** Triage analysis comment, if available */
  triageComment?: string | null;
}

/** Result from the retry loop -- AC8 */
export interface RetryLoopResult {
  /** Whether any attempt succeeded (QA approved + quality gate passed) */
  success: boolean;
  /** All attempt log entries -- AC7 */
  attemptLogs: AttemptLogEntry[];
  /** All QA verdict entries */
  qaResults: QAVerdictEntry[];
  /** All model usage entries */
  modelsUsed: ModelUsageEntry[];
  /** The final git diff (if success) -- AC8 */
  diff: string | null;
  /** List of changed files (if success) */
  changedFiles: string[];
  /** Handoff markdown document (if failure) -- AC8 */
  handoffMarkdown: string | null;
  /** Handoff file path (if failure) */
  handoffFilePath: string | null;
  /** QA summary for PR body (if success) */
  qaSummary: string | null;
  /** Fix summary from the subagent (if success) */
  fixSummary: FixSummary | null;
  /** Error message describing the final failure, if any */
  error: string | null;
  /** Number of fix attempts consumed */
  fixAttemptsUsed: number;
}

/** Structured JSON output from the fix subagent */
interface FixSummary {
  files_modified: string[];
  fix_summary: string;
  compilation_result: string;
  confidence: "high" | "medium" | "low";
}

/** Internal tracking for a single attempt's intermediate state */
interface AttemptState {
  diff: string;
  changedFiles: string[];
  fixSummary: FixSummary | null;
  fixSubagentResult: SubagentResult;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Check whether a QA error is retryable based on the error message string.
 * AC10d: Only specific patterns trigger QA infra retry. Unrecognized errors
 * (missing prompt file, invalid config) fall through immediately.
 */
export function isRetryableQAError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();

  // Check string patterns
  for (const pattern of RETRYABLE_ERROR_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return true;
    }
  }

  // Check HTTP status codes (look for patterns like "HTTP 429", "status 502", "error 500")
  for (const code of RETRYABLE_HTTP_CODES) {
    const codeStr = String(code);
    if (
      errorMessage.includes(codeStr) &&
      (lower.includes("http " + codeStr) ||
       lower.includes("status " + codeStr) ||
       lower.includes("error " + codeStr) ||
       lower.includes("status_code") ||
       lower.includes(codeStr + " "))
    ) {
      return true;
    }
  }

  return false;
}

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capture the git diff and changed file list from the game repo.
 * Matches the pattern from bug-fix.ts captureDiff().
 */
function captureDiff(gameRepoPath: string): { diff: string; changedFiles: string[] } {
  console.log("[retry-loop] Capturing git diff in " + gameRepoPath);

  let diff = "";
  let changedFilesRaw = "";

  try {
    diff = execSync("git diff", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[retry-loop] WARNING: git diff failed: " + errMsg);
  }

  try {
    changedFilesRaw = execSync("git diff --name-only", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[retry-loop] WARNING: git diff --name-only failed: " + errMsg);
  }

  // Also check for untracked files
  let untrackedRaw = "";
  try {
    untrackedRaw = execSync("git ls-files --others --exclude-standard", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  } catch {
    // Non-fatal
  }

  const allFiles = [changedFilesRaw, untrackedRaw]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .filter(Boolean);

  // For untracked files, capture their content as diff too
  if (untrackedRaw) {
    for (const untrackedFile of untrackedRaw.split("\n").filter(Boolean)) {
      try {
        const fileDiff = execSync("git diff --no-index /dev/null " + JSON.stringify(untrackedFile), {
          cwd: gameRepoPath,
          encoding: "utf-8",
          timeout: 10_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        diff += "\n" + fileDiff;
      } catch (err: unknown) {
        // git diff --no-index returns exit code 1 when differences found (normal)
        const stdout = (err as { stdout?: string })?.stdout;
        if (typeof stdout === "string" && stdout.length > 0) {
          diff += "\n" + stdout;
        }
      }
    }
  }

  console.log("[retry-loop] Diff captured: " + diff.split("\n").length + " lines, " + allFiles.length + " files changed");

  return { diff, changedFiles: allFiles };
}

/**
 * Reset the game repo working tree to discard any changes from a failed attempt.
 * This ensures the next attempt starts from a clean state.
 * Throws if the reset fails or the working tree is still dirty (PV2-6.5 AC1/AC2).
 */
function resetGameRepo(gameRepoPath: string): void {
  console.log("[retry-loop] Resetting game repo working tree...");
  try {
    execSync("git checkout -- .", { cwd: gameRepoPath, encoding: "utf-8", timeout: 15_000 });
    execSync("git clean -fd", { cwd: gameRepoPath, encoding: "utf-8", timeout: 15_000 });

    // PV2-6.5 AC1: Verify clean state after reset
    const status = execSync("git status --porcelain", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    if (status !== "") {
      console.error("[retry-loop] ERROR: Game repo still dirty after reset:");
      console.error(status);
      throw new Error("Game repo reset incomplete — dirty files remain");
    }

    console.log("[retry-loop] Game repo reset complete (verified clean)");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // PV2-6.5 AC2: Re-throw so the retry loop knows this attempt is poisoned
    console.error("[retry-loop] FATAL: Could not reset game repo: " + errMsg);
    throw new Error("Game repo reset failed: " + errMsg);
  }
}

/**
 * Extract file extensions from a list of file paths.
 */
function extractFileExtensions(changedFiles: string[]): string[] {
  const extensions: string[] = [];
  for (const file of changedFiles) {
    const ext = path.extname(file);
    if (ext) {
      extensions.push(ext);
    }
  }
  return extensions;
}

/**
 * Parse fix summary JSON from subagent response text.
 * Matches the pattern from bug-fix.ts.
 */
function parseFixSummary(responseText: string | null): FixSummary | null {
  if (!responseText) return null;

  try {
    const jsonText = extractJson(responseText, "files_modified");
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;

    if (
      Array.isArray(parsed.files_modified) &&
      typeof parsed.fix_summary === "string" &&
      typeof parsed.compilation_result === "string" &&
      typeof parsed.confidence === "string"
    ) {
      return {
        files_modified: parsed.files_modified as string[],
        fix_summary: parsed.fix_summary,
        compilation_result: parsed.compilation_result,
        confidence: parsed.confidence as "high" | "medium" | "low",
      };
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[retry-loop] WARNING: Could not parse fix summary: " + errMsg);
  }

  return null;
}

/**
 * Build the user prompt for a fix attempt, including failure context
 * from all previous attempts (AC4).
 */
function buildFixPrompt(
  input: RetryLoopInput,
  attemptNumber: number,
  previousFailures: Array<{
    attempt: number;
    approach: string;
    result: string;
    errorOutput: string;
    qaFeedback: string | null;
  }>,
  bannedApproaches: string[],
): string {
  const parts: string[] = [];

  parts.push("Fix the following bug in the SortingHistory iOS game.");
  parts.push("");
  parts.push("## Bug Report (Issue #" + input.issueNumber + ")");
  parts.push("**Title:** " + input.issueTitle);
  parts.push("");
  parts.push(input.issueBody);

  if (input.triageComment) {
    parts.push("");
    parts.push("## Triage Analysis");
    parts.push(input.triageComment);
  }

  // Include previous failure context for retries (AC4)
  if (previousFailures.length > 0) {
    parts.push("");
    parts.push("## Previous Attempts (ALL FAILED)");
    parts.push("");
    parts.push("You MUST learn from these failures. Do NOT repeat the same mistakes.");
    parts.push("");

    for (const failure of previousFailures) {
      parts.push("### Attempt " + failure.attempt + " -- " + failure.result.toUpperCase());
      parts.push("- **Approach:** " + failure.approach);
      parts.push("- **Error:** " + failure.errorOutput);
      if (failure.qaFeedback) {
        parts.push("- **QA Feedback:** " + failure.qaFeedback);
      }
      parts.push("");
    }

    // Banned approaches (AC4)
    if (bannedApproaches.length > 0) {
      parts.push("## BANNED APPROACHES -- do NOT repeat these:");
      parts.push("");
      for (const banned of bannedApproaches) {
        parts.push("- " + banned);
      }
      parts.push("");
    }
  }

  parts.push("");
  parts.push("## Instructions");
  parts.push("1. Explore the codebase to understand the relevant code");
  parts.push("2. Identify the root cause of the bug");
  parts.push("3. Apply a targeted fix using Edit (not full file rewrites)");
  parts.push("4. Verify compilation passes with xcodebuild");
  parts.push("5. Output your JSON summary");

  if (attemptNumber > 1) {
    parts.push("");
    parts.push("**This is attempt " + attemptNumber + " of " + (input.maxAttempts ?? LIMITS.MAX_FIX_ATTEMPTS) + ".** Take a fundamentally different approach than previous attempts.");
  }

  return parts.join("\n");
}

/**
 * Format a QA review result into a human-readable markdown summary
 * for inclusion in PR bodies.
 */
function formatQASummary(qaResult: QAResult, qaProfile: string): string {
  const parts: string[] = [];

  parts.push("## QA Review");
  parts.push("");

  if (!qaResult.success || !qaResult.verdict) {
    parts.push("**Status:** QA REVIEW INCOMPLETE");
    parts.push("**Error:** " + (qaResult.error ?? "Unknown error"));
    parts.push("");
    parts.push("> **Warning:** The QA review could not be completed. Manual review is required.");
    return parts.join("\n");
  }

  const verdict = qaResult.verdict;
  const verdictLabel = verdict.verdict === "approved" ? "APPROVED" :
    verdict.verdict === "needs_revision" ? "NEEDS REVISION" : "REJECTED";

  parts.push("**Verdict:** " + verdictLabel);
  parts.push("**Risk Level:** " + verdict.risk_level);
  parts.push("**Profile:** " + qaProfile);
  parts.push("");

  if (verdict.findings.length > 0) {
    parts.push("### Findings");
    parts.push("");
    for (const finding of verdict.findings) {
      parts.push("- **[" + finding.criterion + "/" + finding.severity + "]** `" + finding.file + "`: " + finding.description);
    }
    parts.push("");
  }

  parts.push("### Summary");
  parts.push("");
  parts.push(verdict.summary);

  if (qaResult.metrics) {
    parts.push("");
    parts.push("<details>");
    parts.push("<summary>QA Review Metrics</summary>");
    parts.push("");
    parts.push("- **Model:** " + qaResult.metrics.model);
    parts.push("- **Input tokens:** " + qaResult.metrics.inputTokens);
    parts.push("- **Output tokens:** " + qaResult.metrics.outputTokens);
    parts.push("- **Duration:** " + qaResult.metrics.durationMs + "ms");
    parts.push("- **Cost:** $" + qaResult.metrics.costUsd.toFixed(4));
    parts.push("");
    parts.push("</details>");
  }

  return parts.join("\n");
}

// ------------------------------------------------------------------
// QA with infra retry (AC10)
// ------------------------------------------------------------------

/**
 * Run QA review with infrastructure failure retry logic (AC10).
 *
 * If runQAReview() returns success: false OR throws an exception,
 * and the error is retryable (AC10d), retries QA only -- using the
 * same captured diff, no new fix subagent call (AC10b).
 *
 * QA infra retries have their own counter (max 2 retries with 5s delay,
 * independent of the fix attempt counter) (AC10c).
 *
 * Returns the QA result and the number of infra retries consumed.
 */
async function runQAWithInfraRetry(
  qaInput: QAInput,
  attemptNumber: number,
): Promise<{ qaResult: QAResult; infraRetriesUsed: number }> {
  let infraRetriesUsed = 0;

  for (let qaAttempt = 0; qaAttempt <= MAX_QA_INFRA_RETRIES; qaAttempt++) {
    let qaResult: QAResult;

    // Normalize exceptions to QAResult with success: false (AC10 W-1)
    try {
      qaResult = await runQAReview(qaInput);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[retry-loop] QA review threw exception: " + errMsg);
      qaResult = {
        success: false,
        verdict: null,
        metrics: null,
        error: "QA review exception: " + errMsg,
      };
    }

    // If QA succeeded (regardless of verdict), return immediately
    if (qaResult.success) {
      return { qaResult, infraRetriesUsed };
    }

    // QA infrastructure failure -- check if retryable (AC10d)
    const errorMsg = qaResult.error ?? "unknown error";

    if (!isRetryableQAError(errorMsg)) {
      console.log("[retry-loop] QA error is NOT retryable: " + errorMsg);
      console.log("[retry-loop] Falling through to QA incomplete fallback");
      return { qaResult, infraRetriesUsed };
    }

    // Retryable error -- retry if we have attempts left
    if (qaAttempt < MAX_QA_INFRA_RETRIES) {
      infraRetriesUsed++;
      console.log("[retry-loop] QA infra failure (retryable): " + errorMsg);
      console.log("[retry-loop] QA infra retry " + infraRetriesUsed + "/" + MAX_QA_INFRA_RETRIES + " -- waiting " + (QA_INFRA_RETRY_DELAY_MS / 1000) + "s...");
      await sleep(QA_INFRA_RETRY_DELAY_MS);
    } else {
      // All QA infra retries exhausted (AC10e)
      console.log("[retry-loop] QA infra retries exhausted (" + MAX_QA_INFRA_RETRIES + "/" + MAX_QA_INFRA_RETRIES + ")");
      console.log("[retry-loop] Falling through to QA incomplete fallback (AC10e -> AC8)");
      return { qaResult, infraRetriesUsed };
    }
  }

  // Should not reach here, but TypeScript needs a return
  return {
    qaResult: { success: false, verdict: null, metrics: null, error: "QA infra retry logic error" },
    infraRetriesUsed,
  };
}

// ------------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------------

/**
 * Run the fix -> compile -> QA -> quality gate retry loop.
 *
 * AC1: Accepts issue context, triage result, screenshots, game repo path, max attempts.
 * AC2: On each attempt: selects model, spawns fix subagent, runs compile check, QA, quality gate.
 * AC3: On gate failure: captures failure, bans approach, escalates model.
 * AC4: Retry prompt includes all previous failure reasons + QA feedback + banned approaches.
 * AC5: If QA verdict is "rejected": STOP immediately.
 * AC6: If all attempts exhausted: generate handoff document.
 * AC7: Each attempt is logged to AttemptLogEntry.
 * AC8: Returns success/failure + attempt logs + final diff (success) + handoff (failure).
 * AC10: QA infrastructure failure handling with separate retry counter.
 */
export async function runRetryLoop(input: RetryLoopInput): Promise<RetryLoopResult> {
  const maxAttempts = input.maxAttempts ?? LIMITS.MAX_FIX_ATTEMPTS;

  console.log("=== PV2-4.1: Retry Loop ===");
  console.log("  Issue: #" + input.issueNumber);
  console.log("  Max attempts: " + maxAttempts);
  console.log("  Game repo: " + input.gameRepoPath);
  console.log("  Screenshots: " + input.screenshots.length);
  console.log("");

  // Determine bug profile for model selection
  const bugProfile = determineBugProfile({
    classification: input.triage.classification,
    confidence: input.triage.confidence,
    fileExtensions: input.triage.fileExtensions,
  });

  console.log("[retry-loop] Bug profile: " + bugProfile);

  // Load system prompt for fix subagent
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "bug-fixer.md");
  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(promptPath, "utf-8");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[retry-loop] FATAL: Could not read system prompt at " + promptPath + ": " + errMsg);
    return {
      success: false,
      attemptLogs: [],
      qaResults: [],
      modelsUsed: [],
      diff: null,
      changedFiles: [],
      handoffMarkdown: null,
      handoffFilePath: null,
      qaSummary: null,
      fixSummary: null,
      error: "Could not read system prompt: " + errMsg,
      fixAttemptsUsed: 0,
    };
  }

  // Tracking across attempts
  const attemptLogs: AttemptLogEntry[] = [];
  const qaResults: QAVerdictEntry[] = [];
  const modelsUsed: ModelUsageEntry[] = [];
  const previousFailures: Array<{
    attempt: number;
    approach: string;
    result: string;
    errorOutput: string;
    qaFeedback: string | null;
  }> = [];
  const bannedApproaches: string[] = [];

  let fixAttemptsUsed = 0;

  // ------------------------------------------------------------------
  // Main retry loop (AC2, AC3)
  // ------------------------------------------------------------------
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    fixAttemptsUsed = attempt;

    console.log("");
    console.log("=== Fix Attempt " + attempt + "/" + maxAttempts + " ===");

    // Select models based on bug profile and attempt number (AC2)
    const modelSelection = selectModels(bugProfile, attempt, input.triage.fileExtensions);

    console.log("[retry-loop] Fix model: " + modelSelection.fixModel);
    console.log("[retry-loop] QA model: " + modelSelection.qaModel);
    console.log("[retry-loop] QA profile: " + modelSelection.qaProfile);
    console.log("[retry-loop] Fix max turns: " + modelSelection.fixMaxTurns);
    console.log("");

    // Reset game repo before each attempt (except the first)
    // PV2-6.5 AC3: Catch reset failure and skip to next attempt
    if (attempt > 1) {
      try {
        resetGameRepo(input.gameRepoPath);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[retry-loop] Reset failed -- skipping attempt " + attempt);

        const logEntry: AttemptLogEntry = {
          attempt_number: attempt,
          model: "n/a",
          approach: "skipped — game repo reset failed",
          result: "error",
          error_output: errMsg,
          timestamp: new Date().toISOString(),
        };
        attemptLogs.push(logEntry);

        previousFailures.push({
          attempt,
          approach: "skipped — game repo reset failed",
          result: "error",
          errorOutput: errMsg,
          qaFeedback: null,
        });

        continue;
      }
    }

    // Build the fix prompt with failure context (AC4)
    const userPrompt = buildFixPrompt(input, attempt, previousFailures, bannedApproaches);

    // --------------------------------------------------
    // Step 1: Spawn fix subagent (AC2)
    // --------------------------------------------------
    console.log("[retry-loop] Spawning fix subagent (attempt " + attempt + ")...");

    const hooks = buildBugFixHooksConfig(input.gameRepoPath);
    let fixResult: SubagentResult;

    // PV2-6.5 AC4: Per-attempt timeout
    const attemptTimeoutMs = ATTEMPT_TIMEOUT_MS[attempt] ?? 20 * 60 * 1000;
    const timeoutMinutes = attemptTimeoutMs / 60_000;

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Fix subagent timed out after " + timeoutMinutes + " minutes")),
          attemptTimeoutMs,
        ),
      );

      fixResult = await Promise.race([
        spawnSubagent({
          model: modelSelection.fixModel,
          tools: [...BUG_FIX_TOOLS],
          prompt: userPrompt,
          systemPrompt,
          hooks,
          cwd: input.gameRepoPath,
          maxTurns: modelSelection.fixMaxTurns,
          images: input.screenshots,
        }),
        timeoutPromise,
      ]);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errMsg.includes("timed out after");
      console.error("[retry-loop] Fix subagent " + (isTimeout ? "timed out" : "spawn failed") + ": " + errMsg);

      // PV2-6.5 AC5/AC6: Log timeout as "timeout" result with error message
      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: modelSelection.fixModel,
        approach: isTimeout ? "timed out after " + timeoutMinutes + " minutes" : "subagent spawn failed",
        result: isTimeout ? "timeout" : "error",
        error_output: errMsg,
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      previousFailures.push({
        attempt,
        approach: isTimeout ? "timed out after " + timeoutMinutes + " minutes" : "subagent spawn failed",
        result: isTimeout ? "timeout" : "error",
        errorOutput: errMsg,
        qaFeedback: null,
      });

      continue; // Try next attempt
    }

    // Log fix subagent usage
    modelsUsed.push({
      step: "fix_attempt_" + attempt,
      model: fixResult.model ?? modelSelection.fixModel,
      input_tokens: fixResult.inputTokens,
      output_tokens: fixResult.outputTokens,
      cost_estimate: fixResult.costUsd,
      timestamp: new Date().toISOString(),
    });

    console.log("[retry-loop] Fix subagent complete:");
    console.log("  Model: " + (fixResult.model ?? modelSelection.fixModel));
    console.log("  Tokens: " + fixResult.inputTokens + "/" + fixResult.outputTokens);
    console.log("  Cost: $" + fixResult.costUsd.toFixed(4));
    console.log("  Duration: " + fixResult.durationMs + "ms");

    if (!fixResult.success) {
      console.error("[retry-loop] Fix subagent failed: " + fixResult.error);

      logPipelineEvent({
        workflow_id: "bf-" + input.issueNumber,
        issue: input.issueNumber,
        event: "fix_attempt_failed",
        severity: "error",
        model: fixResult.model ?? modelSelection.fixModel,
        attempt,
        tokens_in: fixResult.inputTokens,
        tokens_out: fixResult.outputTokens,
        cost_usd: fixResult.costUsd,
        error_msg: fixResult.error ?? "unknown",
      });

      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: "subagent error: " + (fixResult.error ?? "unknown"),
        result: "error",
        error_output: fixResult.error,
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      previousFailures.push({
        attempt,
        approach: "subagent error: " + (fixResult.error ?? "unknown"),
        result: "error",
        errorOutput: fixResult.error ?? "unknown",
        qaFeedback: null,
      });

      continue;
    }

    // --------------------------------------------------
    // Step 2: Parse fix summary
    // --------------------------------------------------
    const fixSummary = parseFixSummary(fixResult.responseText);
    if (fixSummary) {
      console.log("[retry-loop] Fix summary: " + fixSummary.fix_summary);
      console.log("[retry-loop] Compilation: " + fixSummary.compilation_result);
      console.log("[retry-loop] Confidence: " + fixSummary.confidence);
    } else {
      console.log("[retry-loop] WARNING: Could not parse fix summary from response");
    }

    // --------------------------------------------------
    // Step 3: Capture git diff
    // --------------------------------------------------
    const { diff, changedFiles } = captureDiff(input.gameRepoPath);

    if (changedFiles.length === 0) {
      console.log("[retry-loop] No changes detected -- attempt " + attempt + " produced no diff");

      logPipelineEvent({
        workflow_id: "bf-" + input.issueNumber,
        issue: input.issueNumber,
        event: "no_changes_produced",
        severity: "warn",
        model: fixResult.model ?? modelSelection.fixModel,
        attempt,
        tokens_in: fixResult.inputTokens,
        tokens_out: fixResult.outputTokens,
        cost_usd: fixResult.costUsd,
        details: fixSummary?.fix_summary ?? "subagent ran but produced zero file changes",
      });

      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: fixSummary?.fix_summary ?? "no changes produced",
        result: "error",
        error_output: "Fix subagent produced no file changes",
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      previousFailures.push({
        attempt,
        approach: fixSummary?.fix_summary ?? "no changes produced",
        result: "error",
        errorOutput: "Fix subagent produced no file changes",
        qaFeedback: null,
      });

      if (fixSummary?.fix_summary) {
        bannedApproaches.push(fixSummary.fix_summary);
      }

      continue;
    }

    // --------------------------------------------------
    // Step 4: Check compilation from self-report (AC2)
    // --------------------------------------------------
    const compilationFailed = fixSummary?.compilation_result?.toLowerCase() !== "success";

    if (compilationFailed) {
      console.log("[retry-loop] Compilation self-report: " + (fixSummary?.compilation_result ?? "unknown") + " -- skipping QA");

      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "compilation_error",
        error_output: "Compilation: " + (fixSummary?.compilation_result ?? "unknown"),
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      // AC3: capture failure details, ban approach, escalate on next iteration
      previousFailures.push({
        attempt,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "compilation_error",
        errorOutput: "Compilation: " + (fixSummary?.compilation_result ?? "unknown"),
        qaFeedback: null,
      });

      if (fixSummary?.fix_summary) {
        bannedApproaches.push(fixSummary.fix_summary);
      }

      continue;
    }

    // --------------------------------------------------
    // Step 5: Run QA review with infra retry (AC2, AC10)
    // --------------------------------------------------
    console.log("[retry-loop] Running QA review...");

    const fileExtensions = extractFileExtensions(changedFiles);
    const qaProfile = determineQAProfile(fileExtensions);

    const qaInput: QAInput = {
      bugTitle: input.issueTitle,
      bugBody: input.issueBody,
      triageClassification: input.triage.classification,
      triageComment: input.triageComment ?? null,
      diff,
      changedFiles,
      gameRepoPath: input.gameRepoPath,
      qaModel: modelSelection.qaModel,
      qaMaxTurns: modelSelection.qaMaxTurns,
      qaProfile,
      attemptNumber: attempt,
      images: input.screenshots,
    };

    const { qaResult, infraRetriesUsed } = await runQAWithInfraRetry(qaInput, attempt);

    // Log QA model usage
    if (qaResult.metrics) {
      modelsUsed.push({
        step: "qa_review_" + attempt,
        model: qaResult.metrics.model ?? modelSelection.qaModel,
        input_tokens: qaResult.metrics.inputTokens,
        output_tokens: qaResult.metrics.outputTokens,
        cost_estimate: qaResult.metrics.costUsd,
        timestamp: new Date().toISOString(),
      });
    }

    if (infraRetriesUsed > 0) {
      console.log("[retry-loop] QA infra retries used: " + infraRetriesUsed);
    }

    // --------------------------------------------------
    // Step 5a: Handle QA infrastructure failure (AC10e -> AC8 fallback)
    // --------------------------------------------------
    if (!qaResult.success) {
      console.log("[retry-loop] QA review did not complete (after " + infraRetriesUsed + " infra retries)");
      console.log("[retry-loop] Falling through to QA INCOMPLETE fallback (PV2-3.3 AC8)");

      // AC10a: Log the infra failure
      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "error",
        error_output: "qa_infra_failure: " + (qaResult.error ?? "unknown"),
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      // AC10e: QA infra retries exhausted -- return with QA incomplete
      // The caller (bug-fix.ts / PV2-4.2) creates the PR with "QA INCOMPLETE" warning
      const qaWarning = "## QA Review\n\n" +
        "> **QA REVIEW INCOMPLETE:** " + (qaResult.error ?? "Unknown QA error") + ". Manual review required.\n\n" +
        "The QA review subagent could not complete its analysis. This does NOT mean the fix is bad --\n" +
        "it means QA infrastructure had an issue. Please review the changes manually before merging.";

      return {
        success: true, // Fix itself succeeded, QA just couldn't run
        attemptLogs,
        qaResults,
        modelsUsed,
        diff,
        changedFiles,
        handoffMarkdown: null,
        handoffFilePath: null,
        qaSummary: qaWarning,
        fixSummary,
        error: null,
        fixAttemptsUsed,
      };
    }

    // --------------------------------------------------
    // Step 6: Handle QA verdict (AC2, AC5)
    // --------------------------------------------------
    const verdict = qaResult.verdict!;

    // Log QA result
    const qaVerdictEntry = toVerdictEntry(verdict, attempt);
    qaResults.push(qaVerdictEntry);

    console.log("[retry-loop] QA verdict: " + verdict.verdict);
    console.log("[retry-loop] QA risk: " + verdict.risk_level);

    // --- AC5: QA rejected -> STOP immediately ---
    if (verdict.verdict === "rejected") {
      console.log("[retry-loop] QA REJECTED -- stopping immediately (AC5)");

      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "qa_rejected",
        error_output: "QA rejected: " + verdict.summary,
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      // Generate handoff for rejection
      const handoff = buildHandoff(input, attemptLogs, qaResults, "QA review rejected the fix. The automated fix did not meet quality standards.", attempt);

      return {
        success: false,
        attemptLogs,
        qaResults,
        modelsUsed,
        diff: null,
        changedFiles: [],
        handoffMarkdown: handoff.markdown,
        handoffFilePath: handoff.filePath,
        qaSummary: formatQASummary(qaResult, qaProfile),
        fixSummary,
        error: "QA rejected -- fix does not meet quality standards",
        fixAttemptsUsed,
      };
    }

    // --- QA needs_revision -> log failure, ban approach, continue loop ---
    if (verdict.verdict === "needs_revision") {
      console.log("[retry-loop] QA NEEDS REVISION -- will retry with escalated model");

      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "qa_needs_revision",
        error_output: "QA needs revision: " + verdict.summary,
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      const qaFeedback = verdict.findings
        .map(f => "[" + f.criterion + "/" + f.severity + "] " + f.file + ": " + f.description)
        .join("; ");

      // AC3: capture failure, ban approach, escalate
      previousFailures.push({
        attempt,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "qa_needs_revision",
        errorOutput: verdict.summary,
        qaFeedback,
      });

      if (fixSummary?.fix_summary) {
        bannedApproaches.push(fixSummary.fix_summary);
      }

      continue;
    }

    // --- QA approved -> run quality gate ---
    console.log("[retry-loop] QA APPROVED -- running quality gate");

    // --------------------------------------------------
    // Step 7: Run quality gate (AC2)
    // --------------------------------------------------
    const qualityGateResult = runQualityGate(diff, changedFiles);

    if (!qualityGateResult.passed) {
      console.log("[retry-loop] Quality gate FAILED:");
      for (const failure of qualityGateResult.failures) {
        console.log("  [" + failure.check + "] " + failure.description);
      }

      const logEntry: AttemptLogEntry = {
        attempt_number: attempt,
        model: fixResult.model ?? modelSelection.fixModel,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "quality_gate_fail",
        error_output: qualityGateResult.failures.map(f => "[" + f.check + "] " + f.description).join("; "),
        timestamp: new Date().toISOString(),
      };
      attemptLogs.push(logEntry);

      // AC3: capture failure, ban approach
      previousFailures.push({
        attempt,
        approach: fixSummary?.fix_summary ?? "unknown",
        result: "quality_gate_fail",
        errorOutput: qualityGateResult.failures.map(f => f.check + ": " + f.description).join("; "),
        qaFeedback: null,
      });

      if (fixSummary?.fix_summary) {
        bannedApproaches.push(fixSummary.fix_summary);
      }

      continue;
    }

    // --------------------------------------------------
    // SUCCESS! QA approved + quality gate passed
    // --------------------------------------------------
    console.log("[retry-loop] Quality gate PASSED");
    console.log("");
    console.log("=== Retry Loop SUCCESS on attempt " + attempt + "/" + maxAttempts + " ===");

    logPipelineEvent({
      workflow_id: "bf-" + input.issueNumber,
      issue: input.issueNumber,
      event: "fix_success",
      severity: "info",
      model: fixResult.model ?? modelSelection.fixModel,
      attempt,
      tokens_in: fixResult.inputTokens,
      tokens_out: fixResult.outputTokens,
      cost_usd: fixResult.costUsd,
      details: fixSummary?.fix_summary ?? "fix applied and QA approved",
    });

    const logEntry: AttemptLogEntry = {
      attempt_number: attempt,
      model: fixResult.model ?? modelSelection.fixModel,
      approach: fixSummary?.fix_summary ?? "unknown",
      result: "success",
      error_output: null,
      timestamp: new Date().toISOString(),
    };
    attemptLogs.push(logEntry);

    return {
      success: true,
      attemptLogs,
      qaResults,
      modelsUsed,
      diff,
      changedFiles,
      handoffMarkdown: null,
      handoffFilePath: null,
      qaSummary: formatQASummary(qaResult, qaProfile),
      fixSummary,
      error: null,
      fixAttemptsUsed,
    };
  }

  // ------------------------------------------------------------------
  // All attempts exhausted (AC6)
  // ------------------------------------------------------------------
  console.log("");
  console.log("=== Retry Loop FAILED -- all " + maxAttempts + " attempts exhausted ===");

  logPipelineEvent({
    workflow_id: "bf-" + input.issueNumber,
    issue: input.issueNumber,
    event: "all_attempts_exhausted",
    severity: "error",
    attempt: maxAttempts,
    details: "All " + maxAttempts + " fix attempts used. Profile: " + bugProfile,
  });

  const handoff = buildHandoff(
    input,
    attemptLogs,
    qaResults,
    "All " + maxAttempts + " fix attempts exhausted. Each attempt used an escalated model but could not produce a fix that passed all gates.",
    maxAttempts,
  );

  return {
    success: false,
    attemptLogs,
    qaResults,
    modelsUsed,
    diff: null,
    changedFiles: [],
    handoffMarkdown: handoff.markdown,
    handoffFilePath: handoff.filePath,
    qaSummary: null,
    fixSummary: null,
    error: "All " + maxAttempts + " fix attempts exhausted",
    fixAttemptsUsed: maxAttempts,
  };
}

// ------------------------------------------------------------------
// Handoff builder
// ------------------------------------------------------------------

/**
 * Build a handoff document from retry loop state.
 */
function buildHandoff(
  input: RetryLoopInput,
  attemptLogs: AttemptLogEntry[],
  qaResults: QAVerdictEntry[],
  failureReason: string,
  totalAttempts: number,
): HandoffResult {
  const attemptLogSummaries: AttemptLogSummary[] = attemptLogs.map(log => ({
    attempt_number: log.attempt_number,
    model: log.model,
    approach: log.approach,
    result: log.result as AttemptLogSummary["result"],
    error_summary: log.error_output ?? "No error",
  }));

  const qaResultSummaries: QAResultSummary[] = qaResults.map(qa => ({
    attempt_number: qa.attempt_number,
    verdict: qa.verdict as QAResultSummary["verdict"],
    findings: qa.findings,
    summary: qa.summary,
  }));

  const handoffInput: HandoffInput = {
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
    triageClassification: input.triage.classification,
    triageSeverity: input.triage.severity,
    triageReasoning: input.triage.reasoning,
    extractedContext: {},
    attemptLogs: attemptLogSummaries,
    qaResults: qaResultSummaries,
    screenshotCount: input.screenshots.length,
    suggestedApproach: "Review all " + totalAttempts + " failed approaches above to understand what was tried. Take a fundamentally different approach or consider that the bug may require architectural changes.",
    failureReason,
    tier: 3,
  };

  return generateHandoff(handoffInput);
}
