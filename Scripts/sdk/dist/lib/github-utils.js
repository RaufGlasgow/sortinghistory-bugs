/**
 * Shared GitHub CLI helpers for the bug automation SDK.
 *
 * Story 3.8: Deduplicated from orchestrator.ts, content-e2e.ts,
 * translation-e2e.ts, and bug-fix.ts.
 */
import { execSync } from "node:child_process";
import { ROUTING } from "../config.js";
// ------------------------------------------------------------------
// fetchIssueData — single gh call for body + labels
// ------------------------------------------------------------------
/**
 * Fetch an issue's body and labels in a single GitHub CLI call.
 * Uses ROUTING.PRIVATE_REPO as the target repository.
 */
export function fetchIssueData(issueNumber) {
    const raw = execSync("gh issue view " + issueNumber + " --repo " + ROUTING.PRIVATE_REPO + " --json body,labels", { encoding: "utf-8", timeout: 30_000 }).trim();
    const parsed = JSON.parse(raw);
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
export function addHandoffLabel(issueNumber) {
    const repo = ROUTING.PRIVATE_REPO;
    try {
        execSync("gh issue edit " + issueNumber + " --repo " + repo + " --add-label needs-handoff-review", { encoding: "utf-8", timeout: 15_000 });
        console.log("[github-utils] Added needs-handoff-review label to issue #" + issueNumber);
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log("[github-utils] WARNING: Could not add needs-handoff-review label: " + errMsg);
    }
}
