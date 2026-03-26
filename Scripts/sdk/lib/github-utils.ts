/**
 * Shared GitHub CLI helpers for the bug automation SDK.
 *
 * Story 3.8: Deduplicated from orchestrator.ts, content-e2e.ts,
 * translation-e2e.ts, and bug-fix.ts.
 */

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROUTING } from "../config.js";

// ------------------------------------------------------------------
// fetchIssueData — single gh call for body + labels
// ------------------------------------------------------------------

/**
 * Fetch an issue's body and labels in a single GitHub CLI call.
 * Uses ROUTING.PRIVATE_REPO as the target repository.
 */
export function fetchIssueData(issueNumber: number): { body: string; labels: string[] } {
  const raw = execSync(
    "gh issue view " + issueNumber + " --repo " + ROUTING.PRIVATE_REPO + " --json body,labels",
    { encoding: "utf-8", timeout: 30_000 },
  ).trim();
  const parsed = JSON.parse(raw) as { body: string; labels: Array<{ name: string }> };
  return {
    body: parsed.body,
    labels: parsed.labels.map((l) => l.name),
  };
}

// ------------------------------------------------------------------
// addHandoffLabel — add needs-handoff-review label to an issue
// ------------------------------------------------------------------

/**
 * Add the needs-handoff-review label to an issue.
 * Non-fatal on failure -- label is important but not worth crashing the pipeline.
 */
export function addHandoffLabel(issueNumber: number): void {
  const repo = ROUTING.PRIVATE_REPO;
  try {
    execSync(
      "gh issue edit " + issueNumber + " --repo " + repo + " --add-label needs-handoff-review",
      { encoding: "utf-8", timeout: 15_000 },
    );
    console.log("[github-utils] Added needs-handoff-review label to issue #" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[github-utils] WARNING: Could not add needs-handoff-review label: " + errMsg);
  }
}

// ------------------------------------------------------------------
// addDevHandoffLabel — add needs-dev-handoff label to an issue
// ------------------------------------------------------------------

/**
 * Add the needs-dev-handoff label to an issue.
 * Used when the pipeline cannot auto-fix and needs the owner to fix locally.
 * Non-fatal on failure -- label is important but not worth crashing the pipeline.
 */
export function addDevHandoffLabel(issueNumber: number): void {
  const repo = ROUTING.PRIVATE_REPO;
  try {
    execSync(
      "gh issue edit " + issueNumber + " --repo " + repo + " --add-label needs-dev-handoff",
      { encoding: "utf-8", timeout: 15_000 },
    );
    console.log("[github-utils] Added needs-dev-handoff label to issue #" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[github-utils] WARNING: Could not add needs-dev-handoff label: " + errMsg);
  }
}

// ------------------------------------------------------------------
// postFixLocallyComment — post a standardized FIX LOCALLY comment
// ------------------------------------------------------------------

/**
 * Post a standardized "Pipeline Cannot Auto-Fix" comment on an issue.
 * Includes the download-context CLI command for the owner.
 *
 * @param issueNumber - GitHub issue number
 * @param reason - Why the pipeline cannot auto-fix
 * @param attempted - What the pipeline tried to do
 */
export function postFixLocallyComment(
  issueNumber: number,
  reason: string,
  attempted: string,
): void {
  const comment = [
    "## Pipeline Cannot Auto-Fix This Issue",
    "",
    "**Reason:** " + reason,
    "",
    "**What was attempted:** " + attempted,
    "",
    "### Fix Locally",
    "",
    "Run this command to download full context:",
    "",
    "```",
    "npx tsx Scripts/sdk/download-context.ts --issue " + issueNumber,
    "```",
    "",
    "This will create a `context/issue-" + issueNumber + "/` directory with the issue body, device info, triage context, and relevant files.",
  ].join("\n");

  const tmpFile = join(tmpdir(), "gh-fix-locally-" + issueNumber + "-" + Date.now() + ".md");
  try {
    writeFileSync(tmpFile, comment, "utf-8");
    execSync(
      "gh issue comment " + issueNumber + " --repo " + ROUTING.PRIVATE_REPO + " --body-file " + tmpFile,
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[github-utils] Posted FIX LOCALLY comment on issue #" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[github-utils] WARNING: Could not post FIX LOCALLY comment: " + errMsg);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
  }
}
