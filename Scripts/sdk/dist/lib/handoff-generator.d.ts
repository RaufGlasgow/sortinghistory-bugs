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
/**
 * Generate a structured handoff markdown document from pipeline data.
 *
 * The output is designed for direct consumption by Claude Code:
 * a developer can read the file and immediately start fixing.
 */
export declare function generateHandoff(input: HandoffInput): HandoffResult;
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
export declare function commitHandoff(result: HandoffResult, gameRepoPath: string): void;
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
    /** Story 3.5: Contextual signals found in the report */
    signalsFound?: string[];
    /** Story 3.5: Contextual signals NOT found (what was missing) */
    signalsMissing?: string[];
    /** Story 3.5: Suggested investigation steps for the owner */
    suggestedSteps?: string[];
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
export declare function generateTriageHandoff(input: TriageOnlyHandoffInput): string;
/**
 * Build a fallback comment when handoff generation fails (BA-011 AC3).
 *
 * Contains raw triage data so the issue is still actionable even if
 * the structured handoff could not be generated.
 */
export declare function buildFallbackHandoffComment(classification: string, confidence: number, severity: string, reasoning: string, error: string): string;
/**
 * Post the handoff markdown as a comment on the GitHub issue.
 *
 * Uses --body-file (NOT --body) to avoid shell backtick command substitution
 * eating markdown code spans. This matches the pattern from triage.ts.
 */
export declare function postHandoffComment(issueNumber: number, markdown: string): void;
