/**
 * Story SDK-BF.1: Bug Fix Subagent Workflow
 * Story PV2-3.3: QA Gate Integration
 * Story PV2-4.2: Retry Loop Integration
 *
 * Thin wrapper around runRetryLoop() (PV2-4.1) that:
 *   1. Fetches issue context from GitHub
 *   2. Parses triage classification from the triage comment (AC2, AC3)
 *   3. Delegates fix -> compile -> QA -> quality gate cycle to runRetryLoop()
 *   4. On success: returns result for PR creation; YAML handles git staging (AC5)
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
import type { TriageData } from "../lib/types.js";
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
/**
 * PV2-6.1 AC3, AC8: Extract triage data from the machine-readable JSON block.
 *
 * Iterates comments in REVERSE order (most recent first) so re-triage
 * uses the latest classification, not stale data from the original triage.
 */
export declare function extractTriageFromComments(comments: Array<{
    body: string;
}>): TriageData | null;
/**
 * Story 3.13 AC3: Extract owner reclassification from issue comments.
 * Checks newest comments first. Returns the reclassified type or null.
 * Owner reclassification is authoritative — overrides AI triage.
 */
export declare function extractOwnerReclassification(comments: Array<{
    body: string;
}>): string | null;
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
 * 6. On success: return result for PR creation; YAML handles git staging (AC5)
 * 7. On failure: commit handoff, post comment, label issue (AC6, AC7)
 */
export declare function runBugFix(input: BugFixInput): Promise<BugFixResult>;
