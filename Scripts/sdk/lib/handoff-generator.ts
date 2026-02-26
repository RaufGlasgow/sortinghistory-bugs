/**
 * Story PV2-2.3: Handoff Document Generator
 *
 * Produces structured markdown handoff documents when the pipeline cannot
 * fix a bug automatically. These documents are what a human developer reads
 * to pick up where the pipeline left off.
 *
 * Two tiers:
 * - Tier 3: Automated fix failed — human fix needed. Includes all attempt
 *   logs, QA findings, failed approaches, and suggested next steps.
 * - Tier 4: Human decision needed. Adds a section explaining what the
 *   pipeline couldn't decide on its own.
 *
 * Delivery:
 * - Primary: committed to `pipeline/handoffs` branch in the game repo
 *   at `.bmad/handoffs/pipeline/issue-XX-handoff.md`
 * - Secondary: posted as a GitHub issue comment
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ROUTING } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary of a single fix attempt by the pipeline.
 *  Result values aligned with AttemptLogEntry in state.ts (canonical source of truth). */
export interface AttemptLogSummary {
  attempt_number: number;
  model: string;
  approach: string;
  result: "success" | "compilation_error" | "qa_rejected" | "qa_needs_revision" | "quality_gate_fail" | "timeout" | "error";
  error_summary: string;
}

/** Summary of QA review for a single attempt */
export interface QAResultSummary {
  attempt_number: number;
  verdict: "approved" | "needs_revision" | "rejected";
  findings: string[];
  summary: string;
}

/** All information needed to generate a handoff document */
export interface HandoffInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  triageClassification: string;
  triageSeverity: string;
  triageReasoning: string;
  extractedContext: Record<string, unknown>;
  attemptLogs: AttemptLogSummary[];
  qaResults: QAResultSummary[];
  screenshotCount: number;
  suggestedApproach: string;
  failureReason: string;
  tier: 3 | 4;
  /** Required for Tier 4 — explains what decision the pipeline needs a human for */
  humanQuestion?: string;
}

/** Result of generating a handoff document */
export interface HandoffResult {
  /** The complete markdown document */
  markdown: string;
  /** Path relative to game repo root, e.g. ".bmad/handoffs/pipeline/issue-87-handoff.md" */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for attempt result codes.
 *  Covers all canonical result values from AttemptLogEntry in state.ts. */
function resultLabel(result: AttemptLogSummary["result"]): string {
  const map: Record<AttemptLogSummary["result"], string> = {
    success: "Fix succeeded",
    compilation_error: "Compilation failed",
    qa_rejected: "QA rejected",
    qa_needs_revision: "QA needs revision",
    quality_gate_fail: "Quality gate failed",
    timeout: "Timed out",
    error: "Unexpected error",
  };
  return map[result] ?? result;
}

/** Format extracted context as a bullet list of key-value pairs */
function formatExtractedContext(ctx: Record<string, unknown>): string {
  const keys = Object.keys(ctx);
  if (keys.length === 0) {
    return "- No structured context extracted";
  }

  const lines: string[] = [];
  for (const key of keys) {
    const value = ctx[key];
    const display = typeof value === "string" ? value : JSON.stringify(value);
    lines.push("- **" + formatContextKey(key) + ":** " + display);
  }
  return lines.join("\n");
}

/** Convert snake_case or camelCase keys to Title Case for display */
function formatContextKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Generate an ISO timestamp string */
function timestamp(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// generateHandoff — pure function, no side effects
// ---------------------------------------------------------------------------

/**
 * Generate a structured handoff markdown document from pipeline data.
 *
 * The output is designed for direct consumption by Claude Code:
 * a developer can read the file and immediately start fixing.
 */
export function generateHandoff(input: HandoffInput): HandoffResult {
  const filePath = ".bmad/handoffs/pipeline/issue-" + input.issueNumber + "-handoff.md";
  const tierLabel =
    input.tier === 3
      ? "3 (Automated fix failed -- human fix needed)"
      : "4 (Human decision needed)";

  const sections: string[] = [];

  // -- Header --
  sections.push("# Pipeline Handoff: Issue #" + input.issueNumber + " -- " + input.issueTitle);
  sections.push("");
  sections.push("**Tier:** " + tierLabel);
  sections.push("**Generated:** " + timestamp());
  sections.push(
    "**Classification:** " + input.triageClassification + " | **Severity:** " + input.triageSeverity,
  );
  if (input.screenshotCount > 0) {
    sections.push("**Screenshots:** " + input.screenshotCount + " attached to original issue");
  }

  // -- Bug Summary --
  sections.push("");
  sections.push("## Bug Summary");
  sections.push("");
  sections.push(input.triageReasoning);

  // -- Extracted Context --
  sections.push("");
  sections.push("## Extracted Context");
  sections.push("");
  sections.push(formatExtractedContext(input.extractedContext));

  // -- Original Report --
  sections.push("");
  sections.push("## Original Report");
  sections.push("");
  sections.push("<details>");
  sections.push("<summary>Click to expand original issue body</summary>");
  sections.push("");
  sections.push(input.issueBody);
  sections.push("");
  sections.push("</details>");

  // -- What Was Tried --
  sections.push("");
  sections.push("## What Was Tried");
  sections.push("");
  if (input.attemptLogs.length === 0) {
    sections.push("No fix attempts were made.");
  } else {
    for (const attempt of input.attemptLogs) {
      sections.push("### Attempt " + attempt.attempt_number + " (" + attempt.model + ")");
      sections.push("");
      sections.push("- **Approach:** " + attempt.approach);
      sections.push("- **Result:** " + resultLabel(attempt.result));
      sections.push("- **Error:** " + attempt.error_summary);

      // Find matching QA result
      const qa = input.qaResults.find((q) => q.attempt_number === attempt.attempt_number);
      if (qa) {
        sections.push("- **QA Verdict:** " + qa.verdict + " -- " + qa.summary);
        if (qa.findings.length > 0) {
          sections.push("- **QA Findings:**");
          for (const finding of qa.findings) {
            sections.push("  - " + finding);
          }
        }
      } else {
        sections.push("- **QA Verdict:** Not reached (failed before QA)");
      }
      sections.push("");
    }
  }

  // -- Failure Reason --
  sections.push("## Why the Pipeline Stopped");
  sections.push("");
  sections.push(input.failureReason);

  // -- Suggested Approach --
  sections.push("");
  sections.push("## Suggested Approach");
  sections.push("");
  sections.push(input.suggestedApproach);

  // -- Tier 4: Human Decision Needed --
  if (input.tier === 4 && input.humanQuestion) {
    sections.push("");
    sections.push("## Human Decision Needed");
    sections.push("");
    sections.push(input.humanQuestion);
  }

  // -- How to Fix --
  sections.push("");
  sections.push("## How to Fix");
  sections.push("");

  const fileHint = typeof input.extractedContext.file_path === "string"
    ? input.extractedContext.file_path
    : typeof input.extractedContext.file === "string"
      ? input.extractedContext.file
      : null;

  sections.push("1. Read this file for full context");
  if (fileHint) {
    sections.push("2. The relevant file is: `" + fileHint + "`");
  } else {
    sections.push("2. Identify the relevant file from the extracted context and original report above");
  }
  sections.push(
    "3. Review the failed approaches above to avoid repeating them",
  );
  sections.push("4. " + getClassificationGuidance(input.triageClassification));
  sections.push("5. Run `npm run build` to verify compilation");
  sections.push("6. Create a PR targeting `main`");

  // -- Footer --
  sections.push("");
  sections.push("---");
  sections.push("*Generated by SDK Pipeline v2 -- Story PV2-2.3*");

  const markdown = sections.join("\n");
  return { markdown, filePath };
}

/** Return specific guidance based on bug classification */
function getClassificationGuidance(classification: string): string {
  const guidance: Record<string, string> = {
    content_error:
      "This is a content error -- check the JSON data file for incorrect facts, dates, or descriptions",
    translation_error:
      "This is a translation error -- check the localized .json file for the affected language",
    ui_bug:
      "This is a UI bug -- check the SwiftUI View file for layout, styling, or rendering issues",
    gameplay_bug:
      "This is a gameplay bug -- check the game logic in the relevant ViewModel or Model file",
    crash:
      "This is a crash -- check the stack trace in the original report and the relevant Swift file",
    performance:
      "This is a performance issue -- profile the relevant code path and check for unnecessary redraws or allocations",
  };
  return guidance[classification] ?? "Apply the suggested approach above to fix the issue";
}

// ---------------------------------------------------------------------------
// commitHandoff — git operations to persist the handoff document
// ---------------------------------------------------------------------------

/**
 * Commit a handoff document to the `pipeline/handoffs` branch in the game repo.
 *
 * Strategy:
 * 1. Save current branch name
 * 2. Check if `pipeline/handoffs` branch exists; create as orphan if not
 * 3. Checkout the branch
 * 4. Write the handoff file
 * 5. Commit and push
 * 6. Checkout back to the original branch
 *
 * Uses execSync for all git operations (matches project convention).
 */
export function commitHandoff(result: HandoffResult, gameRepoPath: string): void {
  const cwd = gameRepoPath;
  const branch = "pipeline/handoffs";
  const commitMsg = "pipeline: handoff for issue " + extractIssueNumber(result.filePath);

  console.log("[handoff] Committing handoff to " + branch + " in " + cwd);

  // Save current branch so we can return to it
  let originalBranch: string;
  try {
    originalBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    originalBranch = "main";
  }

  console.log("[handoff] Current branch: " + originalBranch);

  try {
    // Check if the handoff branch exists (local or remote)
    let branchExists = false;
    try {
      execSync("git rev-parse --verify " + branch, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      });
      branchExists = true;
    } catch {
      // Also check remote
      try {
        execSync("git rev-parse --verify origin/" + branch, {
          cwd,
          encoding: "utf-8",
          stdio: "pipe",
        });
        branchExists = true;
        // Create local tracking branch from remote
        execSync("git branch " + branch + " origin/" + branch, {
          cwd,
          encoding: "utf-8",
          stdio: "pipe",
        });
      } catch {
        branchExists = false;
      }
    }

    if (branchExists) {
      // Checkout existing branch
      execSync("git checkout " + branch, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      });
      console.log("[handoff] Checked out existing branch: " + branch);
    } else {
      // Create orphan branch (no history from main — keeps handoffs isolated)
      execSync("git checkout --orphan " + branch, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      });
      // Remove all files from the index on the orphan branch
      execSync("git rm -rf --cached .", {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      });
      console.log("[handoff] Created orphan branch: " + branch);
    }

    // Ensure the directory exists
    const fullPath = join(cwd, result.filePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write the handoff file
    writeFileSync(fullPath, result.markdown, "utf-8");
    console.log("[handoff] Wrote handoff to: " + result.filePath);

    // Stage and commit
    execSync("git add " + JSON.stringify(result.filePath), {
      cwd,
      encoding: "utf-8",
    });

    execSync("git commit -m " + JSON.stringify(commitMsg), {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });
    console.log("[handoff] Committed: " + commitMsg);

    // Push
    execSync("git push origin " + branch, {
      cwd,
      encoding: "utf-8",
      timeout: 60_000,
      stdio: "pipe",
    });
    console.log("[handoff] Pushed to origin/" + branch);
  } finally {
    // Always return to the original branch
    try {
      execSync("git checkout " + originalBranch, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
      });
      console.log("[handoff] Returned to branch: " + originalBranch);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[handoff] WARNING: Could not return to " + originalBranch + ": " + errMsg);
    }
  }
}

/** Extract issue number from file path like ".bmad/handoffs/pipeline/issue-87-handoff.md" */
function extractIssueNumber(filePath: string): string {
  const match = filePath.match(/issue-(\d+)-handoff/);
  return match ? match[1] : "unknown";
}

// ---------------------------------------------------------------------------
// BA-011 Story 3.1: Triage-Only Handoff (no fix attempts, no QA results)
// ---------------------------------------------------------------------------

/** Input for a triage-only handoff (BA-011 ARCH-3).
 *  Lightweight — no attempt logs, no QA results. Used when the pipeline
 *  routes directly to developer without attempting a fix. */
export interface TriageOnlyHandoffInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  classification: string;
  confidence: number;
  severity: string;
  reasoning: string;
  extractedContext: Record<string, unknown>;
}

/**
 * Generate a triage-only handoff document (BA-011 AC2).
 *
 * Includes: Classification, Confidence, Severity, Reasoning, Bug Report,
 *           Relevant Code Paths, Suggested Approach.
 * Omits: Attempt Log, QA Summary (no fix attempts were made).
 *
 * Pure function — no side effects.
 */
export function generateTriageHandoff(input: TriageOnlyHandoffInput): string {
  const sections: string[] = [];

  // -- Header --
  sections.push("# Triage Handoff: Issue #" + input.issueNumber + " -- " + input.issueTitle);
  sections.push("");
  sections.push("**Generated:** " + timestamp());

  // -- Classification Summary --
  sections.push("");
  sections.push("## Classification");
  sections.push("");
  sections.push("| Field | Value |");
  sections.push("|-------|-------|");
  sections.push("| Classification | `" + input.classification + "` |");
  sections.push("| Confidence | " + (input.confidence * 100).toFixed(0) + "% |");
  sections.push("| Severity | `" + input.severity + "` |");

  // -- Reasoning --
  sections.push("");
  sections.push("## Reasoning");
  sections.push("");
  sections.push(input.reasoning);

  // -- Extracted Context / Relevant Code Paths --
  sections.push("");
  sections.push("## Relevant Code Paths");
  sections.push("");
  sections.push(formatExtractedContext(input.extractedContext));

  // -- Bug Report --
  sections.push("");
  sections.push("## Bug Report");
  sections.push("");
  sections.push("<details>");
  sections.push("<summary>Click to expand original issue body</summary>");
  sections.push("");
  sections.push(input.issueBody);
  sections.push("");
  sections.push("</details>");

  // -- Suggested Approach --
  sections.push("");
  sections.push("## Suggested Approach");
  sections.push("");
  sections.push(getClassificationGuidance(input.classification));

  // -- Footer --
  sections.push("");
  sections.push("---");
  sections.push("*Generated by SDK Pipeline -- BA-011 Triage Handoff*");

  return sections.join("\n");
}

/**
 * Build a fallback comment when handoff generation fails (BA-011 AC3).
 *
 * Contains raw triage data so the issue is still actionable even if
 * the structured handoff could not be generated.
 */
export function buildFallbackHandoffComment(
  classification: string,
  confidence: number,
  severity: string,
  reasoning: string,
  error: string,
): string {
  return [
    "## Triage Handoff (Fallback)",
    "",
    "Structured handoff generation failed. Raw triage data below.",
    "",
    "| Field | Value |",
    "|-------|-------|",
    "| Classification | `" + classification + "` |",
    "| Confidence | " + (confidence * 100).toFixed(0) + "% |",
    "| Severity | `" + severity + "` |",
    "",
    "**Reasoning:** " + reasoning,
    "",
    "**Error:** " + error,
    "",
    "---",
    "*Fallback generated by SDK Pipeline -- BA-011*",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// postHandoffComment — secondary delivery via GitHub issue comment
// ---------------------------------------------------------------------------

/**
 * Post the handoff markdown as a comment on the GitHub issue.
 *
 * Uses --body-file (NOT --body) to avoid shell backtick command substitution
 * eating markdown code spans. This matches the pattern from triage.ts.
 */
export function postHandoffComment(issueNumber: number, markdown: string): void {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[handoff] Posting handoff comment on " + repo + "#" + issueNumber);

  const tmpFile = join(tmpdir(), "gh-handoff-" + issueNumber + "-" + Date.now() + ".md");
  try {
    writeFileSync(tmpFile, markdown, "utf-8");
    execSync(
      "gh issue comment " + issueNumber + " --repo " + repo + " --body-file " + tmpFile,
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[handoff] Handoff comment posted successfully");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      "[handoff] WARNING: Failed to post handoff comment on issue #" + issueNumber + ": " + errMsg,
    );
    // Non-fatal: the handoff file is the primary delivery mechanism
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* cleanup best-effort */
    }
  }
}
