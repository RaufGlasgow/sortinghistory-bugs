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
 *   - On QA verdict "rejected": retry with escalated model (like needs_revision); only hard-stop on final attempt
 *   - On QA infrastructure failure: retry QA only (same diff, no new fix),
 *     with its own counter (max 2 retries, 5s delay), independent of fix attempts
 *   - On all attempts exhausted: generates a handoff document
 *   - Each attempt is logged to AttemptLogEntry
 *
 * This module is standalone -- it does NOT modify bug-fix.ts (that is PV2-4.2).
 * It imports and calls: model-router, qa-gate, quality-gate, handoff-generator, state.
 */
import type { AttemptLogEntry, QAVerdictEntry, ModelUsageEntry } from "./state.js";
import type { ExtractedImage } from "./image-extract.js";
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
    /** Workflow state ID for audit-trail persistence (Story 3.6 AC2).
     *  When provided, attempt logs and model usage are persisted to the
     *  workflow state file via logSubagentAttempt() and logModelUsage(). */
    workflowId?: string;
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
/**
 * Check whether a QA error is retryable based on the error message string.
 * AC10d: Only specific patterns trigger QA infra retry. Unrecognized errors
 * (missing prompt file, invalid config) fall through immediately.
 */
export declare function isRetryableQAError(errorMessage: string): boolean;
/**
 * Check whether an error is a billing/quota error.
 * Billing errors must NEVER be retried — they waste runner time.
 */
export declare function isBillingError(errorMessage: string): boolean;
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
export declare function runRetryLoop(input: RetryLoopInput): Promise<RetryLoopResult>;
export {};
