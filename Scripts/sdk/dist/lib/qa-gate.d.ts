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
import type { QAProfile } from "./model-router.js";
import type { ExtractedImage } from "./image-extract.js";
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
/**
 * Convert a QAVerdict to the QAVerdictEntry format used by workflow state.
 *
 * Maps: approved -> "pass", rejected -> "fail", needs_revision -> "partial"
 * Flattens findings to string descriptions for the state log.
 */
export declare function toVerdictEntry(verdict: QAVerdict, attemptNumber: number): {
    attempt_number: number;
    verdict: string;
    findings: string[];
    summary: string;
    timestamp: string;
};
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
export declare function runQAReview(input: QAInput): Promise<QAResult>;
