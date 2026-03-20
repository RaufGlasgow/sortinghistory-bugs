/**
 * Shared GitHub CLI helpers for the bug automation SDK.
 *
 * Story 3.8: Deduplicated from orchestrator.ts, content-e2e.ts,
 * translation-e2e.ts, and bug-fix.ts.
 */
/**
 * Fetch an issue's body and labels in a single GitHub CLI call.
 * Uses ROUTING.PRIVATE_REPO as the target repository.
 */
export declare function fetchIssueData(issueNumber: number): {
    body: string;
    labels: string[];
};
/**
 * Add the needs-handoff-review label to an issue.
 * Non-fatal on failure -- label is important but not worth crashing the pipeline.
 */
export declare function addHandoffLabel(issueNumber: number): void;
