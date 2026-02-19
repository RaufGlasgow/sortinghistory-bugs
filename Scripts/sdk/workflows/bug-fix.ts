/**
 * Story SDK-BF.1: Bug Fix Subagent Workflow
 * Story PV2-3.3: QA Gate Integration
 *
 * Spawns an Opus 4.6 subagent with full tool suite to fix bugs in the
 * SortingHistory iOS game codebase. After the fix subagent completes,
 * captures the diff and runs a QA review gate before PR creation.
 *
 * Flow (PV2-3.3):
 *   1. Fetch issue context from GitHub
 *   2. Spawn fix subagent (Opus 4.6)
 *   3. Capture git diff in game repo
 *   4. Check compilation from self-report — skip QA if failed
 *   5. Determine QA profile from changed file extensions
 *   6. Run QA review (code, content, or both)
 *   7. Handle verdict:
 *      - approved -> quality gate -> PR creation
 *      - needs_revision -> escalate with handoff (interim until Epic 4 retry loop)
 *      - rejected -> escalate with handoff, no PR
 *   8. If QA subagent crashes -> still create PR with warning banner
 *   9. Return QA summary for YAML to include in PR body
 *
 * Hooks (buildBugFixHooksConfig):
 *   - ALLOWS writes to .swift files and Data JSON files
 *   - BLOCKS writes to .github/, Scripts/, .yml, .yaml, .ts, .js,
 *     Package.swift, .pbxproj, .xcworkspace
 *
 * State file: bug_fix workflow type, "bf-" prefix
 *
 * Exit codes:
 * - 0: Success (fix applied, QA approved, JSON summary returned)
 * - 1: Failure (subagent error, compilation failure, QA rejection, invalid response)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { MODELS, BUG_FIX_TOOLS, PATHS, ROUTING } from "../config.js";
import { spawnSubagent, type SubagentResult } from "../lib/subagent.js";
import { buildBugFixHooksConfig } from "../lib/hooks.js";
import { extractJson } from "../lib/json-extract.js";
import { extractBase64Images, stripBase64Images } from "../lib/image-extract.js";
import {
  createWorkflowState,
  updateWorkflowState,
  type WorkflowState,
} from "../lib/state.js";
import { runQAReview, toVerdictEntry, type QAInput, type QAResult } from "../lib/qa-gate.js";
import { determineQAProfile } from "../lib/model-router.js";
import { runQualityGate } from "../lib/quality-gate.js";
import {
  generateHandoff,
  commitHandoff,
  postHandoffComment,
  type HandoffInput,
} from "../lib/handoff-generator.js";
import { getMinEventCount, fileNameToCategory } from "../lib/categories.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Structured JSON output from the bug fix subagent */
export interface BugFixSummary {
  files_modified: string[];
  fix_summary: string;
  compilation_result: string;
  confidence: "high" | "medium" | "low";
}

/** Input parameters for the bug fix workflow */
export interface BugFixInput {
  /** GitHub issue number from the private repo */
  issueNumber: number;
  /** Path to the game repo checkout */
  gameRepoPath: string;
  /** If true, skip actual subagent spawn and log what would happen */
  dryRun: boolean;
}

/** Result of the bug fix workflow */
export interface BugFixResult {
  /** Whether the fix was applied successfully */
  success: boolean;
  /** Workflow ID for state tracking */
  workflowId: string;
  /** Issue number that was fixed */
  issueNumber: number;
  /** Parsed fix summary from the subagent (null if parsing failed) */
  summary: BugFixSummary | null;
  /** Subagent metrics */
  metrics: {
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    costUsd: number;
    toolsUsed: string[];
  } | null;
  /** Error message if something went wrong */
  error: string | null;
  /** QA review summary for inclusion in PR body (PV2-3.3) */
  qaSummary: string | null;
}

// ------------------------------------------------------------------
// GitHub Helpers
// ------------------------------------------------------------------

/** Fetch issue body and comments from the private repo */
function fetchIssueContext(issueNumber: number): { title: string; body: string; triageComment: string | null; triageClassification: string | null } {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[bug-fix] Fetching issue #" + issueNumber + " from " + repo);

  // Fetch issue title and body
  let issueJson: string;
  try {
    issueJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json title,body",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error("Failed to fetch issue #" + issueNumber + ": " + errMsg);
  }

  let parsed: { title: string; body: string };
  try {
    parsed = JSON.parse(issueJson) as { title: string; body: string };
  } catch {
    throw new Error("Failed to parse issue JSON: " + issueJson);
  }

  console.log("[bug-fix] Issue title: " + parsed.title);

  // Fetch comments to find triage/analysis comment
  let triageComment: string | null = null;
  let triageClassification: string | null = null;
  try {
    const commentsJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json comments",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();

    const commentsParsed = JSON.parse(commentsJson) as {
      comments: Array<{ body: string }>;
    };

    // Find the triage classification comment (contains "## Triage Classification")
    for (const comment of commentsParsed.comments) {
      if (comment.body.includes("Triage Classification") || comment.body.includes("Bug Analysis")) {
        triageComment = comment.body;

        // Try to extract classification from the triage comment
        const classMatch = comment.body.match(/\*\*Classification:\*\*\s*(\S+)/);
        if (classMatch) {
          triageClassification = classMatch[1];
        }

        break;
      }
    }

    if (triageComment) {
      console.log("[bug-fix] Found triage/analysis comment");
      if (triageClassification) {
        console.log("[bug-fix] Triage classification: " + triageClassification);
      }
    } else {
      console.log("[bug-fix] No triage/analysis comment found on issue");
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: Could not fetch comments: " + errMsg);
  }

  return {
    title: parsed.title,
    body: parsed.body ?? "",
    triageComment,
    triageClassification,
  };
}

// ------------------------------------------------------------------
// Diff Capture Helpers (PV2-3.3 AC1)
// ------------------------------------------------------------------

/**
 * Capture the git diff and changed file list from the game repo.
 * Uses execSync to run git commands in the game repo working tree.
 */
function captureDiff(gameRepoPath: string): { diff: string; changedFiles: string[] } {
  console.log("[bug-fix] Capturing git diff in " + gameRepoPath);

  let diff = "";
  let changedFilesRaw = "";

  try {
    diff = execSync("git diff", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: git diff failed: " + errMsg);
  }

  try {
    changedFilesRaw = execSync("git diff --name-only", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: git diff --name-only failed: " + errMsg);
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

  // Combine tracked changes and untracked files
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
        // The diff output is on stdout, accessible via the error object
        const stdout = (err as any)?.stdout;
        if (typeof stdout === "string" && stdout.length > 0) {
          diff += "\n" + stdout;
        }
      }
    }
  }

  console.log("[bug-fix] Diff captured: " + diff.split("\n").length + " lines, " + allFiles.length + " files changed");
  console.log("[bug-fix] Changed files: " + allFiles.join(", "));

  return { diff, changedFiles: allFiles };
}

/**
 * Extract file extensions from a list of file paths.
 * Returns the extensions including the leading dot.
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

// ------------------------------------------------------------------
// QA Summary Formatter (PV2-3.3 AC10)
// ------------------------------------------------------------------

/**
 * Format a QA review result into a human-readable markdown summary
 * suitable for inclusion in PR bodies and issue comments.
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
  const verdictEmoji = verdict.verdict === "approved" ? "APPROVED" :
    verdict.verdict === "needs_revision" ? "NEEDS REVISION" : "REJECTED";

  parts.push("**Verdict:** " + verdictEmoji);
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

/**
 * Format a QA failure warning banner for PR bodies when QA infrastructure fails.
 * (PV2-3.3 AC8)
 */
function formatQAFailureWarning(error: string): string {
  const parts: string[] = [];
  parts.push("## QA Review");
  parts.push("");
  parts.push("> **QA REVIEW INCOMPLETE:** " + error + ". Manual review required.");
  parts.push("");
  parts.push("The QA review subagent could not complete its analysis. This does NOT mean the fix is bad --");
  parts.push("it means QA infrastructure had an issue. Please review the changes manually before merging.");
  return parts.join("\n");
}

// ------------------------------------------------------------------
// Event Count Context Builder (for content QA)
// ------------------------------------------------------------------

/**
 * Build event count context string for content QA review.
 * For each changed JSON file in Data/Events/, reports the current event count
 * and the minimum required for that category.
 */
function buildEventCountContext(changedFiles: string[], gameRepoPath: string): string | undefined {
  const contextLines: string[] = [];

  for (const file of changedFiles) {
    if (!file.endsWith(".json")) continue;
    if (!file.includes("Data/Events/") && !file.includes("Data/events/")) continue;

    const baseName = path.basename(file, ".json");
    const category = fileNameToCategory(baseName);
    if (!category) continue;

    const minCount = getMinEventCount(category);
    const fullPath = path.join(gameRepoPath, file);

    let eventCount = 0;
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(content) as { events?: unknown[] };
      if (Array.isArray(parsed.events)) {
        eventCount = parsed.events.length;
      }
    } catch {
      // File might not exist yet or be malformed
      eventCount = -1;
    }

    if (eventCount >= 0) {
      contextLines.push(baseName + ".json: " + eventCount + " events (minimum: " + minCount + ")");
    } else {
      contextLines.push(baseName + ".json: could not read event count (minimum: " + minCount + ")");
    }
  }

  return contextLines.length > 0 ? contextLines.join("\n") : undefined;
}

// ------------------------------------------------------------------
// Label Helper (PV2-3.3 AC6, AC7)
// ------------------------------------------------------------------

/**
 * Add the needs-handoff-review label to an issue.
 * Non-fatal on failure -- label is important but not worth crashing the pipeline.
 */
function addHandoffLabel(issueNumber: number): void {
  const repo = ROUTING.PRIVATE_REPO;
  try {
    execSync(
      "gh issue edit " + issueNumber + " --repo " + repo + " --add-label needs-handoff-review",
      { encoding: "utf-8", timeout: 15_000 },
    );
    console.log("[bug-fix] Added needs-handoff-review label to issue #" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: Could not add needs-handoff-review label: " + errMsg);
  }
}

// ------------------------------------------------------------------
// Main Workflow
// ------------------------------------------------------------------

/**
 * Run the bug fix workflow with integrated QA gate (PV2-3.3).
 *
 * 1. Fetch issue body + triage analysis from GitHub
 * 2. Load system prompt from prompts/bug-fixer.md
 * 3. Spawn Opus 4.6 subagent with BUG_FIX_TOOLS + buildBugFixHooksConfig
 * 4. Parse structured JSON summary from response
 * 5. Capture git diff + changed files
 * 6. Check compilation from self-report -- skip QA if failed
 * 7. Determine QA profile from changed file extensions
 * 8. Run QA review with diff, changed files, bug context
 * 9. Handle verdict: approved -> quality gate -> PR, needs_revision/rejected -> escalate
 * 10. If QA crashes -> still create PR with warning banner
 * 11. Return QA summary for YAML to include in PR body
 */
export async function runBugFix(input: BugFixInput): Promise<BugFixResult> {
  const { issueNumber, gameRepoPath, dryRun } = input;

  console.log("=== SDK-BF.1 + PV2-3.3: Bug Fix Subagent with QA Gate ===");
  console.log("Issue: #" + issueNumber);
  console.log("Game repo: " + gameRepoPath);
  console.log("Model: " + MODELS.COMPLEX_BUG);
  console.log("Tools: [" + BUG_FIX_TOOLS.join(", ") + "]");
  console.log("Dry run: " + dryRun);
  console.log("");

  // --------------------------------------------------
  // Step 1: Create workflow state
  // --------------------------------------------------
  const state = await createWorkflowState(
    "bug_fix",
    "dispatch",
    undefined,
    issueNumber,
  );
  console.log("[bug-fix] Workflow created: " + state.workflow_id);
  console.log("");

  // --------------------------------------------------
  // Step 2: Fetch issue context from GitHub
  // --------------------------------------------------
  let issueContext: { title: string; body: string; triageComment: string | null; triageClassification: string | null };
  try {
    issueContext = fetchIssueContext(issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bug-fix] FATAL: " + errMsg);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Could not fetch issue: " + errMsg,
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: "Could not fetch issue: " + errMsg,
      qaSummary: null,
    };
  }

  // --------------------------------------------------
  // Step 3: Load system prompt
  // --------------------------------------------------
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "bug-fixer.md");
  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(promptPath, "utf-8");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bug-fix] Could not read system prompt at " + promptPath);
    console.error("Error: " + errMsg);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Could not read system prompt: " + errMsg,
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: "Could not read system prompt: " + errMsg,
      qaSummary: null,
    };
  }

  // --------------------------------------------------
  // Step 4: Build user prompt with issue context
  // --------------------------------------------------
  // Extract base64 images from the issue body for multimodal content blocks
  const images = extractBase64Images(issueContext.body);
  if (images.length > 0) {
    console.log("[bug-fix] Extracted " + images.length + " screenshot(s) from issue body");
  }

  // Strip base64 images from text to avoid sending raw data as prompt noise
  const cleanBody = stripBase64Images(issueContext.body);
  const cleanTriageComment = issueContext.triageComment
    ? stripBase64Images(issueContext.triageComment)
    : null;

  const contextParts = [
    "Fix the following bug in the SortingHistory iOS game.",
    "",
    "## Bug Report (Issue #" + issueNumber + ")",
    "**Title:** " + issueContext.title,
    "",
    cleanBody,
  ];

  if (cleanTriageComment) {
    contextParts.push("");
    contextParts.push("## Triage Analysis");
    contextParts.push(cleanTriageComment);
  }

  contextParts.push("");
  contextParts.push("## Instructions");
  contextParts.push("1. Explore the codebase to understand the relevant code");
  contextParts.push("2. Identify the root cause of the bug");
  contextParts.push("3. Apply a targeted fix using Edit (not full file rewrites)");
  contextParts.push("4. Verify compilation passes with xcodebuild");
  contextParts.push("5. Output your JSON summary");

  const userPrompt = contextParts.join("\n");

  // --------------------------------------------------
  // Step 5: Dry run check
  // --------------------------------------------------
  if (dryRun) {
    console.log("[bug-fix] DRY RUN: Would spawn Opus 4.6 subagent with:");
    console.log("  Model: " + MODELS.COMPLEX_BUG);
    console.log("  Tools: [" + BUG_FIX_TOOLS.join(", ") + "]");
    console.log("  Prompt length: " + userPrompt.length + " chars");
    console.log("  System prompt length: " + systemPrompt.length + " chars");
    console.log("  cwd: " + gameRepoPath);
    console.log("");

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      error: null,
    });

    return {
      success: true,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: null,
      qaSummary: null,
    };
  }

  // --------------------------------------------------
  // Step 6: Spawn Opus 4.6 subagent
  // --------------------------------------------------
  console.log("[bug-fix] Spawning Opus 4.6 subagent...");
  await updateWorkflowState(state.workflow_id, {
    status: "fixing",
  });

  const hooks = buildBugFixHooksConfig(gameRepoPath);

  const result: SubagentResult = await spawnSubagent({
    model: MODELS.COMPLEX_BUG,
    tools: [...BUG_FIX_TOOLS],
    prompt: userPrompt,
    systemPrompt,
    hooks,
    cwd: gameRepoPath,
    maxTurns: 100,
    images,
  });

  // --------------------------------------------------
  // Step 7: Log metrics
  // --------------------------------------------------
  console.log("");
  console.log("[bug-fix] Subagent complete");
  console.log("  Model: " + (result.model ?? MODELS.COMPLEX_BUG));
  console.log("  Session ID: " + result.sessionId);
  console.log("  Input tokens: " + result.inputTokens);
  console.log("  Output tokens: " + result.outputTokens);
  console.log("  Duration: " + result.durationMs + "ms");
  console.log("  Cost: $" + result.costUsd.toFixed(4));
  console.log("  Tools used: [" + result.toolsUsed.join(", ") + "]");
  console.log("  Used write tools: " + result.usedWriteTools);
  console.log("");

  const metrics = {
    model: result.model ?? MODELS.COMPLEX_BUG,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    toolsUsed: result.toolsUsed,
  };

  if (!result.success) {
    console.error("[bug-fix] Subagent failed: " + result.error);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Subagent failed: " + (result.error ?? "unknown error"),
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics,
      error: "Subagent failed: " + (result.error ?? "unknown error"),
      qaSummary: null,
    };
  }

  // --------------------------------------------------
  // Step 8: Parse JSON summary from response
  // --------------------------------------------------
  let summary: BugFixSummary | null = null;

  if (result.responseText) {
    try {
      const jsonText = extractJson(result.responseText, "files_modified");
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      if (
        Array.isArray(parsed.files_modified) &&
        typeof parsed.fix_summary === "string" &&
        typeof parsed.compilation_result === "string" &&
        typeof parsed.confidence === "string"
      ) {
        summary = {
          files_modified: parsed.files_modified as string[],
          fix_summary: parsed.fix_summary,
          compilation_result: parsed.compilation_result,
          confidence: parsed.confidence as "high" | "medium" | "low",
        };
        console.log("[bug-fix] Parsed fix summary:");
        console.log("  Files modified: " + summary.files_modified.length);
        console.log("  Summary: " + summary.fix_summary);
        console.log("  Compilation: " + summary.compilation_result);
        console.log("  Confidence: " + summary.confidence);
      } else {
        console.log("[bug-fix] WARNING: Response JSON missing expected fields");
        console.log("  Keys found: " + Object.keys(parsed).join(", "));
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log("[bug-fix] WARNING: Could not parse JSON from response: " + errMsg);
    }
  } else {
    console.log("[bug-fix] WARNING: No response text from subagent");
  }

  // --------------------------------------------------
  // Step 9: Capture git diff (PV2-3.3 AC1)
  // --------------------------------------------------
  const { diff, changedFiles } = captureDiff(gameRepoPath);

  if (changedFiles.length === 0) {
    console.log("[bug-fix] No changes detected in game repo -- escalating");

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      fix_attempts: 1,
      fix_results: summary ? [summary] : [],
      error: "Fix subagent produced no file changes",
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary,
      metrics,
      error: "Fix subagent produced no file changes",
      qaSummary: null,
    };
  }

  // --------------------------------------------------
  // Step 10: Check compilation from self-report (PV2-3.3 AC2)
  // --------------------------------------------------
  const compilationFailed = summary?.compilation_result !== "success";

  if (compilationFailed) {
    console.log("[bug-fix] Compilation self-report: " + (summary?.compilation_result ?? "unknown") + " -- skipping QA, escalating");

    // Log attempt
    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      fix_attempts: 1,
      fix_results: summary ? [summary] : [],
      attempt_log: [{
        attempt_number: 1,
        model: MODELS.COMPLEX_BUG,
        approach: summary?.fix_summary ?? "unknown",
        result: "compilation_error",
        error_output: "Compilation self-report: " + (summary?.compilation_result ?? "unknown"),
        timestamp: new Date().toISOString(),
      }],
      error: "Compilation " + (summary?.compilation_result ?? "unknown") + " -- manual review required",
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary,
      metrics,
      error: "Compilation " + (summary?.compilation_result ?? "unknown") + " -- manual review required",
      qaSummary: null,
    };
  }

  // --------------------------------------------------
  // Step 11: Determine QA profile (PV2-3.3 AC8 prereq)
  // --------------------------------------------------
  const fileExtensions = extractFileExtensions(changedFiles);
  const qaProfile = determineQAProfile(fileExtensions);

  console.log("");
  console.log("[bug-fix] QA profile: " + qaProfile);
  console.log("[bug-fix] File extensions: " + fileExtensions.join(", "));
  console.log("");

  // Use Haiku for QA as default (cheapest), upgrade for complex diffs
  // This matches the model-router pattern: QA model <= fix model tier
  const qaModel = changedFiles.length > 3 ? MODELS.FIXER : MODELS.VERIFIER;
  const qaMaxTurns = changedFiles.length > 3 ? 8 : 5;

  // Build event count context for content QA
  const eventCountContext = buildEventCountContext(changedFiles, gameRepoPath);

  // --------------------------------------------------
  // Step 12: Run QA review (PV2-3.3 AC3)
  // --------------------------------------------------
  console.log("[bug-fix] Running QA review...");

  const qaInput: QAInput = {
    bugTitle: issueContext.title,
    bugBody: cleanBody,
    triageClassification: issueContext.triageClassification ?? "unknown",
    triageComment: cleanTriageComment,
    diff,
    changedFiles,
    gameRepoPath,
    qaModel,
    qaMaxTurns,
    qaProfile,
    attemptNumber: 1,
    images,
    eventCountContext,
  };

  let qaResult: QAResult;
  try {
    qaResult = await runQAReview(qaInput);
  } catch (err: unknown) {
    // QA subagent crashed at infrastructure level (PV2-3.3 AC8)
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bug-fix] QA review crashed: " + errMsg);
    qaResult = {
      success: false,
      verdict: null,
      metrics: null,
      error: "QA review crashed: " + errMsg,
    };
  }

  // --------------------------------------------------
  // Step 13: Log QA results to workflow state (PV2-3.3 AC4)
  // --------------------------------------------------
  const qaResultsForState = qaResult.success && qaResult.verdict
    ? [toVerdictEntry(qaResult.verdict, 1)]
    : [];

  // --------------------------------------------------
  // Step 14: Handle QA verdict (PV2-3.3 AC5, AC6, AC7, AC8)
  // --------------------------------------------------

  // --- Case: QA infrastructure failure (AC8) ---
  if (!qaResult.success) {
    console.log("[bug-fix] QA review did not complete -- proceeding with PR and warning banner");

    let qaSummary = formatQAFailureWarning(qaResult.error ?? "Unknown QA error");

    // Post warning comment on issue (AC8)
    const warningComment = "## QA Review Warning\n\n" +
      "The QA review subagent could not complete its analysis for the fix on issue #" + issueNumber + ".\n\n" +
      "**Error:** " + (qaResult.error ?? "Unknown") + "\n\n" +
      "The fix PR will still be created, but **manual review is required** before merging.";

    const warningTmpFile = path.join(tmpdir(), "gh-qa-warning-" + issueNumber + "-" + Date.now() + ".md");
    try {
      fs.writeFileSync(warningTmpFile, warningComment, "utf-8");
      execSync(
        "gh issue comment " + issueNumber + " --repo " + ROUTING.PRIVATE_REPO + " --body-file " + warningTmpFile,
        { encoding: "utf-8", timeout: 30_000 },
      );
      console.log("[bug-fix] Posted QA warning comment on issue #" + issueNumber);
    } catch (warnErr: unknown) {
      const warnMsg = warnErr instanceof Error ? warnErr.message : String(warnErr);
      console.log("[bug-fix] WARNING: Could not post QA warning comment: " + warnMsg);
    } finally {
      try { fs.unlinkSync(warningTmpFile); } catch { /* cleanup best-effort */ }
    }

    // Run quality gate anyway — catch build artifacts even without QA
    const qualityGateResult = runQualityGate(diff, changedFiles);
    if (!qualityGateResult.passed) {
      console.log("[bug-fix] Quality gate failed despite QA skip:");
      const qgFailures: string[] = [];
      for (const failure of qualityGateResult.failures) {
        console.log("  [" + failure.check + "] " + failure.description);
        qgFailures.push("- **" + failure.check + ":** " + failure.description);
      }
      // Append quality gate failures to the warning banner
      qaSummary += "\n\n## Quality Gate Failures\n\n" + qgFailures.join("\n");
    }

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      fix_attempts: 1,
      fix_results: summary ? [summary] : [],
      qa_results: qaResultsForState,
      attempt_log: [{
        attempt_number: 1,
        model: MODELS.COMPLEX_BUG,
        approach: summary?.fix_summary ?? "unknown",
        result: "success",
        error_output: null,
        timestamp: new Date().toISOString(),
      }],
      error: null,
    });

    return {
      success: true,
      workflowId: state.workflow_id,
      issueNumber,
      summary,
      metrics,
      error: null,
      qaSummary,
    };
  }

  // From here, QA completed successfully -- check verdict
  const verdict = qaResult.verdict!;
  const qaSummary = formatQASummary(qaResult, qaProfile);

  console.log("[bug-fix] QA verdict: " + verdict.verdict);
  console.log("[bug-fix] QA risk: " + verdict.risk_level);

  // --- Case: QA approved (AC5) ---
  if (verdict.verdict === "approved") {
    console.log("[bug-fix] QA APPROVED -- proceeding to quality gate");

    // Run quality gate
    const qualityGateResult = runQualityGate(diff, changedFiles);
    if (!qualityGateResult.passed) {
      console.log("[bug-fix] Quality gate FAILED:");
      for (const failure of qualityGateResult.failures) {
        console.log("  [" + failure.check + "] " + failure.description);
      }

      // Quality gate failure after QA approval is an escalation
      await updateWorkflowState(state.workflow_id, {
        status: "escalated",
        fix_attempts: 1,
        fix_results: summary ? [summary] : [],
        qa_results: qaResultsForState,
        attempt_log: [{
          attempt_number: 1,
          model: MODELS.COMPLEX_BUG,
          approach: summary?.fix_summary ?? "unknown",
          result: "quality_gate_fail",
          error_output: qualityGateResult.failures.map(f => "[" + f.check + "] " + f.description).join("; "),
          timestamp: new Date().toISOString(),
        }],
        error: "Quality gate failed: " + qualityGateResult.failures.map(f => f.check).join(", "),
      });

      return {
        success: false,
        workflowId: state.workflow_id,
        issueNumber,
        summary,
        metrics,
        error: "Quality gate failed: " + qualityGateResult.failures.map(f => f.check).join(", "),
        qaSummary,
      };
    }

    console.log("[bug-fix] Quality gate PASSED -- ready for PR creation");

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      fix_attempts: 1,
      fix_results: summary ? [summary] : [],
      qa_results: qaResultsForState,
      attempt_log: [{
        attempt_number: 1,
        model: MODELS.COMPLEX_BUG,
        approach: summary?.fix_summary ?? "unknown",
        result: "success",
        error_output: null,
        timestamp: new Date().toISOString(),
      }],
      error: null,
    });

    console.log("");
    console.log("[bug-fix] Status: complete (QA approved + quality gate passed)");
    console.log("[bug-fix] Workflow " + state.workflow_id + " finished");
    console.log("");
    console.log("=== Bug Fix COMPLETE -- Issue #" + issueNumber + " ===");

    return {
      success: true,
      workflowId: state.workflow_id,
      issueNumber,
      summary,
      metrics,
      error: null,
      qaSummary,
    };
  }

  // --- Case: QA needs_revision (AC6) ---
  if (verdict.verdict === "needs_revision") {
    console.log("[bug-fix] QA NEEDS REVISION -- escalating (interim behavior until Epic 4 retry loop)");

    // Generate handoff document with QA findings
    const handoffInput: HandoffInput = {
      issueNumber,
      issueTitle: issueContext.title,
      issueBody: cleanBody,
      triageClassification: issueContext.triageClassification ?? "unknown",
      triageSeverity: "unknown",
      triageReasoning: cleanTriageComment ?? "No triage analysis available",
      extractedContext: {},
      attemptLogs: [{
        attempt_number: 1,
        model: MODELS.COMPLEX_BUG,
        approach: summary?.fix_summary ?? "unknown",
        result: "qa_needs_revision",
        error_summary: "QA review identified issues requiring revision: " + verdict.summary,
      }],
      qaResults: [{
        attempt_number: 1,
        verdict: verdict.verdict,
        findings: verdict.findings.map(f => "[" + f.criterion + "/" + f.severity + "] " + f.file + ": " + f.description),
        summary: verdict.summary,
      }],
      screenshotCount: images.length,
      suggestedApproach: "Review the QA findings above and address each issue. The fix was close but needs revision on the points flagged by QA.",
      failureReason: "QA review verdict: needs_revision. The automated fix was partially correct but requires human intervention to address QA findings. (Retry loop will be added in Epic 4.)",
      tier: 3,
    };

    const handoffResult = generateHandoff(handoffInput);

    // Commit handoff to pipeline/handoffs branch
    try {
      commitHandoff(handoffResult, gameRepoPath);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log("[bug-fix] WARNING: Could not commit handoff: " + errMsg);
    }

    // Post handoff as issue comment
    postHandoffComment(issueNumber, handoffResult.markdown);

    // Label issue (AC6)
    addHandoffLabel(issueNumber);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      fix_attempts: 1,
      fix_results: summary ? [summary] : [],
      qa_results: qaResultsForState,
      attempt_log: [{
        attempt_number: 1,
        model: MODELS.COMPLEX_BUG,
        approach: summary?.fix_summary ?? "unknown",
        result: "qa_needs_revision",
        error_output: "QA needs revision: " + verdict.summary,
        timestamp: new Date().toISOString(),
      }],
      error: "QA needs revision -- escalated for human review",
    });

    console.log("");
    console.log("[bug-fix] Status: escalated (QA needs_revision)");
    console.log("[bug-fix] Workflow " + state.workflow_id + " finished");
    console.log("");
    console.log("=== Bug Fix ESCALATED (needs_revision) -- Issue #" + issueNumber + " ===");

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary,
      metrics,
      error: "QA needs revision -- escalated for human review",
      qaSummary,
    };
  }

  // --- Case: QA rejected (AC7) ---
  console.log("[bug-fix] QA REJECTED -- escalating, no PR will be created");

  // Generate handoff document with QA findings
  const handoffInput: HandoffInput = {
    issueNumber,
    issueTitle: issueContext.title,
    issueBody: cleanBody,
    triageClassification: issueContext.triageClassification ?? "unknown",
    triageSeverity: "unknown",
    triageReasoning: cleanTriageComment ?? "No triage analysis available",
    extractedContext: {},
    attemptLogs: [{
      attempt_number: 1,
      model: MODELS.COMPLEX_BUG,
      approach: summary?.fix_summary ?? "unknown",
      result: "qa_rejected",
      error_summary: "QA review rejected the fix: " + verdict.summary,
    }],
    qaResults: [{
      attempt_number: 1,
      verdict: verdict.verdict,
      findings: verdict.findings.map(f => "[" + f.criterion + "/" + f.severity + "] " + f.file + ": " + f.description),
      summary: verdict.summary,
    }],
    screenshotCount: images.length,
    suggestedApproach: "The automated fix was rejected by QA. Review the findings carefully -- the fix may have introduced regressions or missed the root cause entirely.",
    failureReason: "QA review verdict: rejected. The automated fix did not meet quality standards.",
    tier: 3,
  };

  const handoffResult = generateHandoff(handoffInput);

  // Commit handoff to pipeline/handoffs branch
  try {
    commitHandoff(handoffResult, gameRepoPath);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: Could not commit handoff: " + errMsg);
  }

  // Post handoff as issue comment
  postHandoffComment(issueNumber, handoffResult.markdown);

  // Label issue (AC7)
  addHandoffLabel(issueNumber);

  await updateWorkflowState(state.workflow_id, {
    status: "escalated",
    fix_attempts: 1,
    fix_results: summary ? [summary] : [],
    qa_results: qaResultsForState,
    attempt_log: [{
      attempt_number: 1,
      model: MODELS.COMPLEX_BUG,
      approach: summary?.fix_summary ?? "unknown",
      result: "qa_rejected",
      error_output: "QA rejected: " + verdict.summary,
      timestamp: new Date().toISOString(),
    }],
    error: "QA rejected -- fix does not meet quality standards",
  });

  console.log("");
  console.log("[bug-fix] Status: escalated (QA rejected)");
  console.log("[bug-fix] Workflow " + state.workflow_id + " finished");
  console.log("");
  console.log("=== Bug Fix ESCALATED (rejected) -- Issue #" + issueNumber + " ===");

  return {
    success: false,
    workflowId: state.workflow_id,
    issueNumber,
    summary,
    metrics,
    error: "QA rejected -- fix does not meet quality standards",
    qaSummary,
  };
}
