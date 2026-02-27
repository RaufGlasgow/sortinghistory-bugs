/**
 * Story SDK-BF.1: Bug Fix Subagent Workflow
 * Story PV2-3.3: QA Gate Integration
 * Story PV2-4.2: Retry Loop Integration
 *
 * Thin wrapper around runRetryLoop() (PV2-4.1) that:
 *   1. Fetches issue context from GitHub
 *   2. Parses triage classification from the triage comment (AC2, AC3)
 *   3. Delegates fix -> compile -> QA -> quality gate cycle to runRetryLoop()
 *   4. On success: stages changes with safeGitAdd(), returns result for PR creation (AC5)
 *   5. On failure: commits handoff, posts issue comment, labels issue (AC6, AC7)
 *
 * The retry loop handles: model selection/escalation, fix subagent spawning,
 * compilation checking, QA review with infra retry, quality gate, handoff
 * generation, and attempt logging.
 *
 * State file: bug_fix workflow type, "bf-" prefix
 *
 * Exit codes:
 * - 0: Success (fix applied, QA approved, JSON summary returned)
 * - 1: Failure (all attempts exhausted, QA rejection, infrastructure error)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { ROUTING, LIMITS } from "../config.js";
import { extractBase64Images, stripBase64Images } from "../lib/image-extract.js";
import {
  createWorkflowState,
  updateWorkflowState,
} from "../lib/state.js";
import {
  commitHandoff,
  postHandoffComment,
} from "../lib/handoff-generator.js";
import { safeGitAdd } from "../lib/git-utils.js";
import {
  runRetryLoop,
  type TriageContext,
  type RetryLoopResult,
} from "../lib/retry-loop.js";
import { runQAReview, type QAInput, type QAResult } from "../lib/qa-gate.js";
import { runQualityGate } from "../lib/quality-gate.js";
import { selectModels, determineBugProfile, determineQAProfile } from "../lib/model-router.js";
import type { TriageData } from "../lib/types.js";
import { logPipelineEvent } from "../lib/pipeline-log.js";

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
  /** If true, skip fix generation and run QA on the existing fix branch (PV2-4.4) */
  qaOnly?: boolean;
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
  /** Subagent metrics (aggregated from retry loop) */
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
  /** Number of fix attempts used (PV2-4.2) */
  fixAttemptsUsed: number;
}

// ------------------------------------------------------------------
// GitHub Helpers
// ------------------------------------------------------------------

/** Fetch issue body and comments from the private repo */
function fetchIssueContext(issueNumber: number): {
  title: string;
  body: string;
  triageComment: string | null;
  triageClassification: string | null;
  triageSeverity: string | null;
  triageConfidence: number | null;
  triageReasoning: string | null;
} {
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

  // Fetch comments to find triage data
  let triageComment: string | null = null;
  let triageClassification: string | null = null;
  let triageSeverity: string | null = null;
  let triageConfidence: number | null = null;
  let triageReasoning: string | null = null;
  try {
    const commentsJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json comments",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();

    const commentsParsed = JSON.parse(commentsJson) as {
      comments: Array<{ body: string }>;
    };

    // PV2-6.1: Try machine-readable JSON block first (AC3, AC8)
    const triageData = extractTriageFromComments(commentsParsed.comments);

    if (triageData) {
      console.log("[bug-fix] Found machine-readable triage data (JSON block)");
      triageComment = "JSON triage data";
      triageClassification = triageData.classification;
      triageSeverity = triageData.severity;
      triageConfidence = triageData.confidence;
      triageReasoning = triageData.reasoning;
    } else {
      // PV2-6.1 AC5: Fall back to legacy regex parsing for older issues
      console.log("[bug-fix] WARNING: No machine-readable triage data found. Falling back to regex comment parsing (legacy issue).");
      const legacyResult = extractTriageFromCommentsLegacy(commentsParsed.comments);
      triageComment = legacyResult.triageComment;
      triageClassification = legacyResult.triageClassification;
      triageSeverity = legacyResult.triageSeverity;
      triageConfidence = legacyResult.triageConfidence;
      triageReasoning = legacyResult.triageReasoning;
    }

    if (triageClassification) {
      console.log("[bug-fix] Triage classification: " + triageClassification);
    }
    if (triageSeverity) {
      console.log("[bug-fix] Triage severity: " + triageSeverity);
    }
    if (triageConfidence !== null) {
      console.log("[bug-fix] Triage confidence: " + triageConfidence);
    }
    if (!triageComment) {
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
    triageSeverity,
    triageConfidence,
    triageReasoning,
  };
}

/**
 * PV2-6.1 AC3, AC8: Extract triage data from the machine-readable JSON block.
 *
 * Iterates comments in REVERSE order (most recent first) so re-triage
 * uses the latest classification, not stale data from the original triage.
 */
export function extractTriageFromComments(comments: Array<{ body: string }>): TriageData | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const match = comment.body.match(/<!-- TRIAGE_DATA_START\n```json\n([\s\S]*?)\n```\nTRIAGE_DATA_END -->/);
    if (match) {
      try {
        const data = JSON.parse(match[1]) as Record<string, unknown>;
        // Validate required fields
        if (
          typeof data.classification === "string" && data.classification !== "" &&
          typeof data.severity === "string" && data.severity !== "" &&
          typeof data.confidence === "number"
        ) {
          return data as unknown as TriageData;
        }
      } catch {
        // Malformed JSON — continue searching older comments
      }
    }
  }
  return null;
}

/**
 * PV2-6.1 AC5: Legacy regex-based triage extraction for issues triaged
 * before the JSON block was introduced.
 */
function extractTriageFromCommentsLegacy(comments: Array<{ body: string }>): {
  triageComment: string | null;
  triageClassification: string | null;
  triageSeverity: string | null;
  triageConfidence: number | null;
  triageReasoning: string | null;
} {
  let triageComment: string | null = null;
  let triageClassification: string | null = null;
  let triageSeverity: string | null = null;
  let triageConfidence: number | null = null;
  let triageReasoning: string | null = null;

  for (const comment of comments) {
    if (comment.body.includes("Triage Classification") || comment.body.includes("Bug Analysis")) {
      triageComment = comment.body;

      // Bold format: **Classification:** gameplay_bug
      // Table format: | Classification | `gameplay_bug` |
      const classMatch = comment.body.match(/\*\*Classification:\*\*\s*(\S+)/)
        ?? comment.body.match(/\|\s*Classification\s*\|\s*`?(\w+)`?\s*\|/);
      if (classMatch) {
        triageClassification = classMatch[1];
      }

      // Bold format: **Severity:** P2
      // Table format: | Severity | `P2` |
      const sevMatch = comment.body.match(/\*\*Severity:\*\*\s*(\S+)/)
        ?? comment.body.match(/\|\s*Severity\s*\|\s*`?(\w+)`?\s*\|/);
      if (sevMatch) {
        triageSeverity = sevMatch[1];
      }

      // Bold format: **Confidence:** 0.85
      // Table format: | Confidence | 85% |
      const confMatch = comment.body.match(/\*\*Confidence:\*\*\s*([\d.]+)/);
      if (confMatch) {
        triageConfidence = parseFloat(confMatch[1]);
        if (isNaN(triageConfidence)) triageConfidence = null;
      } else {
        const confTableMatch = comment.body.match(/\|\s*Confidence\s*\|\s*(\d+)%\s*\|/);
        if (confTableMatch) {
          triageConfidence = parseInt(confTableMatch[1], 10) / 100;
          if (isNaN(triageConfidence)) triageConfidence = null;
        }
      }

      // Reasoning
      const reasonMatch = comment.body.match(/\*\*Reasoning:\*\*\s*([\s\S]*?)(?=\n##|\n\*\*|$)/);
      if (reasonMatch) {
        triageReasoning = reasonMatch[1].trim();
      }

      break;
    }
  }

  return { triageComment, triageClassification, triageSeverity, triageConfidence, triageReasoning };
}

// ------------------------------------------------------------------
// Triage Context Parser (PV2-4.2 AC2, AC3)
// ------------------------------------------------------------------

/**
 * Build a TriageContext from the parsed issue context.
 *
 * AC2: Bug profile is determined from triage classification.
 * AC3: If triage comment is not found, default to code_complex profile (safe fallback).
 *
 * The TriageContext is passed to runRetryLoop() which uses it for model selection
 * via determineBugProfile() in model-router.ts.
 */
function buildTriageContext(issueContext: {
  triageClassification: string | null;
  triageSeverity: string | null;
  triageConfidence: number | null;
  triageReasoning: string | null;
}): TriageContext {
  // AC3: Default to code_complex if no triage context (safe fallback — uses highest model)
  if (!issueContext.triageClassification) {
    console.log("[bug-fix] No triage classification found -- defaulting to code_complex profile");
    return {
      classification: "ui_bug", // maps to code_complex when file extensions unknown
      confidence: 0.5, // low confidence = complex profile for content bugs
      severity: "medium",
      reasoning: "No triage analysis available -- using safe default",
      fileExtensions: [".swift", ".json"], // multiple extensions = code_complex
    };
  }

  return {
    classification: issueContext.triageClassification,
    confidence: issueContext.triageConfidence ?? 0.7,
    severity: issueContext.triageSeverity ?? "medium",
    reasoning: issueContext.triageReasoning ?? "Triage classification available but no detailed reasoning",
    fileExtensions: inferFileExtensions(issueContext.triageClassification),
  };
}

/**
 * Infer likely file extensions from triage classification.
 * Used for initial model selection before the actual diff is captured.
 */
function inferFileExtensions(classification: string): string[] {
  switch (classification) {
    case "content_error":
      return [".json"];
    case "translation_error":
      return [".json", ".strings"];
    case "ui_bug":
      return [".swift"];
    case "gameplay_bug":
      return [".swift"];
    default:
      // Unknown classification -- assume mixed (code_complex)
      return [".swift", ".json"];
  }
}

// ------------------------------------------------------------------
// Label Helper (PV2-4.2 AC6, AC7)
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
// QA-Only Mode (PV2-4.4)
// ------------------------------------------------------------------

/**
 * Run QA review on an existing fix branch without generating a new fix.
 *
 * PV2-4.4 AC3/AC8: Captures diff from the existing fix branch vs main,
 * validates it is non-empty, then runs QA review + quality gate.
 * Does NOT call runRetryLoop() or spawn any fix subagent.
 *
 * Returns a BugFixResult that the caller (orchestrator + YAML) can use
 * to create a PR or label the issue based on the QA verdict.
 */
async function runQAOnly(input: BugFixInput): Promise<BugFixResult> {
  const { issueNumber, gameRepoPath } = input;

  console.log("=== PV2-4.4: QA-Only Mode ===");
  console.log("Issue: #" + issueNumber);
  console.log("Game repo: " + gameRepoPath);
  console.log("");

  // Step 1: Create workflow state
  const state = await createWorkflowState(
    "bug_fix",
    "dispatch",
    undefined,
    issueNumber,
  );
  console.log("[qa-only] Workflow created: " + state.workflow_id);

  // Step 2: Fetch issue context
  let issueContext: ReturnType<typeof fetchIssueContext>;
  try {
    issueContext = fetchIssueContext(issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[qa-only] FATAL: " + errMsg);
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
      fixAttemptsUsed: 0,
    };
  }

  // Step 3: Capture diff from the existing fix branch vs main
  // AC3b: Use git diff main...HEAD for unified diff format compatible with QA
  console.log("[qa-only] Capturing diff from fix branch vs main...");

  let diff: string;
  let changedFiles: string[];
  try {
    diff = execSync("git diff main...HEAD", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const changedFilesRaw = execSync("git diff main...HEAD --name-only", {
      cwd: gameRepoPath,
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();

    changedFiles = changedFilesRaw ? changedFilesRaw.split("\n").filter(Boolean) : [];
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[qa-only] FATAL: Could not capture diff: " + errMsg);
    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Could not capture diff from fix branch: " + errMsg,
    });
    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: "Could not capture diff from fix branch: " + errMsg,
      qaSummary: null,
      fixAttemptsUsed: 0,
    };
  }

  // AC3c: Empty diff guard
  if (!diff.trim() || changedFiles.length === 0) {
    const emptyMsg = "No changes found on fix branch relative to main. The fix may have already been merged.";
    console.error("[qa-only] FATAL: " + emptyMsg);
    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: emptyMsg,
    });
    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: emptyMsg,
      qaSummary: null,
      fixAttemptsUsed: 0,
    };
  }

  console.log("[qa-only] Diff captured: " + diff.split("\n").length + " lines, " + changedFiles.length + " files");
  console.log("[qa-only] Changed files: " + changedFiles.join(", "));

  // Step 4: Parse triage context for model selection
  const triageContext = buildTriageContext(issueContext);
  const bugProfile = determineBugProfile({
    classification: triageContext.classification,
    confidence: triageContext.confidence,
    fileExtensions: triageContext.fileExtensions,
  });

  // Use attempt 1 model selection for QA-only (no escalation needed)
  const fileExtensions = changedFiles
    .map(f => { const d = f.lastIndexOf("."); return d > 0 ? f.slice(d) : ""; })
    .filter(Boolean);
  const modelSelection = selectModels(bugProfile, 1, fileExtensions);
  const qaProfile = determineQAProfile(fileExtensions);

  console.log("[qa-only] QA model: " + modelSelection.qaModel);
  console.log("[qa-only] QA profile: " + qaProfile);
  console.log("");

  // Strip base64 images from issue body
  const cleanBody = stripBase64Images(issueContext.body);
  const cleanTriageComment = issueContext.triageComment
    ? stripBase64Images(issueContext.triageComment)
    : null;

  // Step 5: Run QA review (AC3d)
  console.log("[qa-only] Running QA review...");
  await updateWorkflowState(state.workflow_id, { status: "re_verifying" });

  const qaInput: QAInput = {
    bugTitle: issueContext.title,
    bugBody: cleanBody,
    triageClassification: triageContext.classification,
    triageComment: cleanTriageComment,
    diff,
    changedFiles,
    gameRepoPath,
    qaModel: modelSelection.qaModel,
    qaMaxTurns: modelSelection.qaMaxTurns,
    qaProfile,
    attemptNumber: 1,
    images: extractBase64Images(issueContext.body),
  };

  let qaResult: QAResult;
  try {
    qaResult = await runQAReview(qaInput);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[qa-only] QA review threw exception: " + errMsg);
    qaResult = {
      success: false,
      verdict: null,
      metrics: null,
      error: "QA review exception: " + errMsg,
    };
  }

  // Step 6: Run quality gate (AC3e)
  console.log("[qa-only] Running quality gate...");
  const qualityGateResult = runQualityGate(diff, changedFiles);

  if (!qualityGateResult.passed) {
    console.log("[qa-only] Quality gate FAILED:");
    for (const failure of qualityGateResult.failures) {
      console.log("  [" + failure.check + "] " + failure.description);
    }
  } else {
    console.log("[qa-only] Quality gate PASSED");
  }

  // Step 7: Build QA summary for PR body
  let qaSummary: string | null = null;
  if (qaResult.success && qaResult.verdict) {
    const verdictLabel = qaResult.verdict.verdict === "approved" ? "APPROVED" :
      qaResult.verdict.verdict === "needs_revision" ? "NEEDS REVISION" : "REJECTED";

    const parts: string[] = [];
    parts.push("## QA Review (QA-Only Re-Run)");
    parts.push("");
    parts.push("**Verdict:** " + verdictLabel);
    parts.push("**Risk Level:** " + qaResult.verdict.risk_level);
    parts.push("**Profile:** " + qaProfile);
    parts.push("");

    if (qaResult.verdict.findings.length > 0) {
      parts.push("### Findings");
      parts.push("");
      for (const finding of qaResult.verdict.findings) {
        parts.push("- **[" + finding.criterion + "/" + finding.severity + "]** `" + finding.file + "`: " + finding.description);
      }
      parts.push("");
    }

    parts.push("### Summary");
    parts.push("");
    parts.push(qaResult.verdict.summary);

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

    if (!qualityGateResult.passed) {
      parts.push("");
      parts.push("### Quality Gate");
      parts.push("");
      parts.push("**Status:** FAILED");
      for (const failure of qualityGateResult.failures) {
        parts.push("- **[" + failure.check + "]** " + failure.description);
      }
    }

    qaSummary = parts.join("\n");
  } else if (!qaResult.success) {
    qaSummary = "## QA Review (QA-Only Re-Run)\n\n" +
      "> **QA REVIEW INCOMPLETE:** " + (qaResult.error ?? "Unknown QA error") + ". Manual review required.\n\n" +
      "The QA review subagent could not complete its analysis. Please review the changes manually before merging.";
  }

  // Step 8: Determine success/failure
  const qaApproved = qaResult.success && qaResult.verdict?.verdict === "approved";
  const overallSuccess = qaApproved && qualityGateResult.passed;

  if (overallSuccess) {
    console.log("");
    console.log("[qa-only] QA APPROVED + Quality Gate PASSED");

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      error: null,
    });

    console.log("");
    console.log("=== QA-Only Re-Run COMPLETE -- Issue #" + issueNumber + " ===");

    return {
      success: true,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: qaResult.metrics ? {
        model: qaResult.metrics.model,
        inputTokens: qaResult.metrics.inputTokens,
        outputTokens: qaResult.metrics.outputTokens,
        durationMs: qaResult.metrics.durationMs,
        costUsd: qaResult.metrics.costUsd,
        toolsUsed: [],
      } : null,
      error: null,
      qaSummary,
      fixAttemptsUsed: 0,
    };
  } else {
    // QA rejected or needs revision or quality gate failed
    const failureReason = !qaResult.success
      ? "QA review could not complete: " + (qaResult.error ?? "unknown")
      : qaResult.verdict?.verdict === "rejected"
        ? "QA rejected the fix"
        : qaResult.verdict?.verdict === "needs_revision"
          ? "QA requires revision: " + (qaResult.verdict?.summary ?? "")
          : !qualityGateResult.passed
            ? "Quality gate failed: " + qualityGateResult.failures.map(f => f.check).join(", ")
            : "Unknown failure";

    console.log("");
    console.log("[qa-only] FAILED: " + failureReason);

    // Post failure findings on the issue (AC3g)
    postFailureComment(issueNumber, "QA-Only Re-Run: " + failureReason);

    // Add label (AC3g)
    addHandoffLabel(issueNumber);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: failureReason,
    });

    console.log("");
    console.log("=== QA-Only Re-Run FAILED -- Issue #" + issueNumber + " ===");

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: qaResult.metrics ? {
        model: qaResult.metrics.model,
        inputTokens: qaResult.metrics.inputTokens,
        outputTokens: qaResult.metrics.outputTokens,
        durationMs: qaResult.metrics.durationMs,
        costUsd: qaResult.metrics.costUsd,
        toolsUsed: [],
      } : null,
      error: failureReason,
      qaSummary,
      fixAttemptsUsed: 0,
    };
  }
}

// ------------------------------------------------------------------
// Main Workflow
// ------------------------------------------------------------------

/**
 * Run the bug fix workflow with retry loop (PV2-4.2).
 *
 * PV2-4.4: If qaOnly is true, delegates to runQAOnly() which skips
 * fix generation entirely and runs QA on the existing fix branch.
 *
 * 1. Create workflow state
 * 2. Fetch issue body + triage analysis from GitHub
 * 3. Parse triage context for model selection (AC2, AC3)
 * 4. Extract screenshots for multimodal fix subagent (AC4)
 * 5. Delegate to runRetryLoop() for fix -> compile -> QA -> quality gate cycle
 * 6. On success: stage changes with safeGitAdd(), return result for PR creation (AC5)
 * 7. On failure: commit handoff, post comment, label issue (AC6, AC7)
 */
export async function runBugFix(input: BugFixInput): Promise<BugFixResult> {
  const { issueNumber, gameRepoPath, dryRun } = input;

  // PV2-4.4 AC8: QA-only mode bypasses the entire retry loop
  if (input.qaOnly) {
    return runQAOnly(input);
  }

  console.log("=== PV2-4.2: Bug Fix with Retry Loop ===");
  console.log("Issue: #" + issueNumber);
  console.log("Game repo: " + gameRepoPath);
  console.log("Max attempts: " + LIMITS.MAX_FIX_ATTEMPTS);
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
  let issueContext: ReturnType<typeof fetchIssueContext>;
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
      fixAttemptsUsed: 0,
    };
  }

  // --------------------------------------------------
  // Step 3: Parse triage context (AC2, AC3)
  // --------------------------------------------------
  const triageContext = buildTriageContext(issueContext);
  console.log("[bug-fix] Triage context:");
  console.log("  Classification: " + triageContext.classification);
  console.log("  Confidence: " + triageContext.confidence);
  console.log("  Severity: " + triageContext.severity);
  console.log("  File extensions: " + triageContext.fileExtensions.join(", "));
  console.log("");

  logPipelineEvent({
    workflow_id: state.workflow_id,
    issue: issueNumber,
    event: "pipeline_start",
    severity: "info",
    details: triageContext.classification + " / " + triageContext.severity + " / conf=" + triageContext.confidence,
  });

  // --------------------------------------------------
  // Step 4: Extract screenshots (AC4 — multimodal content blocks)
  // --------------------------------------------------
  const screenshots = extractBase64Images(issueContext.body);
  if (screenshots.length > 0) {
    console.log("[bug-fix] Extracted " + screenshots.length + " screenshot(s) from issue body");
  }

  // Strip base64 images from text to avoid sending raw data as prompt noise
  const cleanBody = stripBase64Images(issueContext.body);
  const cleanTriageComment = issueContext.triageComment
    ? stripBase64Images(issueContext.triageComment)
    : null;

  // --------------------------------------------------
  // Step 5: Dry run check
  // --------------------------------------------------
  if (dryRun) {
    console.log("[bug-fix] DRY RUN: Would call runRetryLoop() with:");
    console.log("  Issue: #" + issueNumber);
    console.log("  Max attempts: " + LIMITS.MAX_FIX_ATTEMPTS);
    console.log("  Screenshots: " + screenshots.length);
    console.log("  Triage: " + triageContext.classification + " (confidence=" + triageContext.confidence + ")");
    console.log("  Game repo: " + gameRepoPath);
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
      fixAttemptsUsed: 0,
    };
  }

  // --------------------------------------------------
  // Step 6: Run retry loop (PV2-4.1)
  // --------------------------------------------------
  console.log("[bug-fix] Delegating to retry loop...");
  await updateWorkflowState(state.workflow_id, {
    status: "fixing",
  });

  let retryResult: RetryLoopResult;
  try {
    retryResult = await runRetryLoop({
      issueNumber,
      issueTitle: issueContext.title,
      issueBody: cleanBody,
      triage: triageContext,
      screenshots,
      gameRepoPath,
      triageComment: cleanTriageComment,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bug-fix] FATAL: Retry loop threw exception: " + errMsg);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Retry loop exception: " + errMsg,
    });

    // AC7: Post failure comment on issue (no silent failures)
    postFailureComment(issueNumber, "Retry loop crashed: " + errMsg);

    // AC6, AC7: Label issue on exception path
    addHandoffLabel(issueNumber);

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: "Retry loop exception: " + errMsg,
      qaSummary: null,
      fixAttemptsUsed: 0,
    };
  }

  // --------------------------------------------------
  // Step 7: Aggregate metrics from retry loop
  // --------------------------------------------------
  const metrics = aggregateMetrics(retryResult);

  // Convert retry loop's FixSummary to BugFixSummary for backward compatibility
  const summary: BugFixSummary | null = retryResult.fixSummary
    ? {
        files_modified: retryResult.fixSummary.files_modified,
        fix_summary: retryResult.fixSummary.fix_summary,
        compilation_result: retryResult.fixSummary.compilation_result,
        confidence: retryResult.fixSummary.confidence,
      }
    : null;

  // --------------------------------------------------
  // Step 8: Handle result
  // --------------------------------------------------
  if (retryResult.success) {
    return await handleSuccess(
      state.workflow_id,
      issueNumber,
      gameRepoPath,
      retryResult,
      summary,
      metrics,
    );
  } else {
    return await handleFailure(
      state.workflow_id,
      issueNumber,
      gameRepoPath,
      retryResult,
      summary,
      metrics,
    );
  }
}

// ------------------------------------------------------------------
// Success Handler (AC5)
// ------------------------------------------------------------------

/**
 * Handle a successful retry loop result.
 *
 * AC5: Use safeGitAdd() to stage changes, return result for PR creation.
 * The YAML workflow handles the actual PR creation based on our return value.
 * If retry was needed (attempts > 1), the attempt number is available for
 * the YAML to include in the PR title.
 */
async function handleSuccess(
  workflowId: string,
  issueNumber: number,
  gameRepoPath: string,
  retryResult: RetryLoopResult,
  summary: BugFixSummary | null,
  metrics: BugFixResult["metrics"],
): Promise<BugFixResult> {
  console.log("");
  console.log("[bug-fix] Retry loop SUCCEEDED on attempt " + retryResult.fixAttemptsUsed);

  // AC5: Stage changes with safeGitAdd() (not git add -A)
  console.log("[bug-fix] Staging changes with safeGitAdd()...");
  const stageResult = safeGitAdd(gameRepoPath);
  console.log("[bug-fix] Staged " + stageResult.staged.length + " file(s), excluded " + stageResult.excluded.length);

  if (stageResult.staged.length === 0) {
    console.error("[bug-fix] WARNING: safeGitAdd() staged 0 files despite retry loop success");
    console.error("[bug-fix] Changed files from retry loop: " + retryResult.changedFiles.join(", "));
    console.error("[bug-fix] Excluded files: " + stageResult.excluded.map(e => e.file + " (" + e.reason + ")").join(", "));
    // Still report success -- the YAML will detect no staged changes and skip PR creation
  }

  // Update workflow state
  await updateWorkflowState(workflowId, {
    status: "complete",
    fix_attempts: retryResult.fixAttemptsUsed,
    fix_results: summary ? [summary] : [],
    qa_results: retryResult.qaResults,
    attempt_log: retryResult.attemptLogs,
    models_used: retryResult.modelsUsed,
    error: null,
  });

  console.log("");
  console.log("[bug-fix] Status: complete");
  console.log("[bug-fix] Workflow " + workflowId + " finished");
  console.log("");
  console.log("=== Bug Fix COMPLETE -- Issue #" + issueNumber + " (attempt " + retryResult.fixAttemptsUsed + ") ===");

  logPipelineEvent({
    workflow_id: workflowId,
    issue: issueNumber,
    event: "pipeline_complete",
    severity: "info",
    attempt: retryResult.fixAttemptsUsed,
    details: "Fix applied. Files: " + retryResult.changedFiles.join(", "),
  });

  return {
    success: true,
    workflowId,
    issueNumber,
    summary,
    metrics,
    error: null,
    qaSummary: retryResult.qaSummary,
    fixAttemptsUsed: retryResult.fixAttemptsUsed,
  };
}

// ------------------------------------------------------------------
// Failure Handler (AC6, AC7)
// ------------------------------------------------------------------

/**
 * Handle a failed retry loop result.
 *
 * AC6: Commit handoff to pipeline/handoffs branch, post as issue comment,
 *       add needs-handoff-review label.
 * AC7: All failures produce a visible artifact on the issue (label + comment).
 */
async function handleFailure(
  workflowId: string,
  issueNumber: number,
  gameRepoPath: string,
  retryResult: RetryLoopResult,
  summary: BugFixSummary | null,
  metrics: BugFixResult["metrics"],
): Promise<BugFixResult> {
  console.log("");
  console.log("[bug-fix] Retry loop FAILED after " + retryResult.fixAttemptsUsed + " attempt(s)");
  console.log("[bug-fix] Error: " + (retryResult.error ?? "unknown"));

  // AC6: Commit handoff to pipeline/handoffs branch
  if (retryResult.handoffMarkdown && retryResult.handoffFilePath) {
    console.log("[bug-fix] Committing handoff document...");
    try {
      commitHandoff(
        { markdown: retryResult.handoffMarkdown, filePath: retryResult.handoffFilePath },
        gameRepoPath,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log("[bug-fix] WARNING: Could not commit handoff: " + errMsg);
    }

    // AC6: Post handoff as issue comment
    postHandoffComment(issueNumber, retryResult.handoffMarkdown);
  } else {
    // AC7: Even without a handoff document, post a failure comment
    postFailureComment(issueNumber, retryResult.error ?? "Unknown error");
  }

  // AC6, AC7: Label issue
  addHandoffLabel(issueNumber);

  // Update workflow state
  await updateWorkflowState(workflowId, {
    status: "escalated",
    fix_attempts: retryResult.fixAttemptsUsed,
    fix_results: summary ? [summary] : [],
    qa_results: retryResult.qaResults,
    attempt_log: retryResult.attemptLogs,
    models_used: retryResult.modelsUsed,
    error: retryResult.error ?? "All fix attempts exhausted",
  });

  console.log("");
  console.log("[bug-fix] Status: escalated");
  console.log("[bug-fix] Workflow " + workflowId + " finished");
  console.log("");
  console.log("=== Bug Fix ESCALATED -- Issue #" + issueNumber + " ===");

  logPipelineEvent({
    workflow_id: workflowId,
    issue: issueNumber,
    event: "pipeline_failed",
    severity: "error",
    attempt: retryResult.fixAttemptsUsed,
    error_msg: retryResult.error ?? "All fix attempts exhausted",
  });

  return {
    success: false,
    workflowId,
    issueNumber,
    summary,
    metrics,
    error: retryResult.error ?? "All fix attempts exhausted",
    qaSummary: retryResult.qaSummary,
    fixAttemptsUsed: retryResult.fixAttemptsUsed,
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Aggregate metrics from the retry loop's model usage entries.
 * Sums up tokens and cost across all fix and QA subagent calls.
 */
function aggregateMetrics(retryResult: RetryLoopResult): BugFixResult["metrics"] {
  if (retryResult.modelsUsed.length === 0) {
    return null;
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let latestModel: string | null = null;

  for (const usage of retryResult.modelsUsed) {
    totalInput += usage.input_tokens;
    totalOutput += usage.output_tokens;
    totalCost += usage.cost_estimate;
    // Use the last fix model as the "primary" model
    if (usage.step.startsWith("fix_attempt_")) {
      latestModel = usage.model;
    }
  }

  return {
    model: latestModel,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    durationMs: 0, // Not tracked at aggregate level
    costUsd: totalCost,
    toolsUsed: [], // Not tracked at aggregate level
  };
}

/**
 * Post a generic failure comment on the issue.
 * AC7: No silent failures -- every failure produces a visible artifact.
 */
function postFailureComment(issueNumber: number, error: string): void {
  const repo = ROUTING.PRIVATE_REPO;
  const comment = "## Bug Fix Pipeline Failed\n\n" +
    "The bug fix pipeline could not resolve this issue automatically.\n\n" +
    "**Error:** " + error + "\n\n" +
    "Manual intervention is required.";

  const tmpFile = path.join(tmpdir(), "gh-bugfix-fail-" + issueNumber + "-" + Date.now() + ".md");
  try {
    fs.writeFileSync(tmpFile, comment, "utf-8");
    execSync(
      "gh issue comment " + issueNumber + " --repo " + repo + " --body-file " + tmpFile,
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[bug-fix] Posted failure comment on issue #" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: Could not post failure comment: " + errMsg);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
  }
}
