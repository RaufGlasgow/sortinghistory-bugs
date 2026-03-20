/**
 * Story 2.2: Content Fixer Subagent
 *
 * Receives findings from Story 2.1's content verifier and spawns a Sonnet
 * subagent to apply fixes. Each fix:
 *   - Corrects the identified gate failure in the event JSON
 *   - Increments the event's version field
 *   - Appends an entry to corrections-log.json
 *
 * The fixer uses FIXER_TOOLS (read-write) and runs with hooks from
 * buildHooksConfig() to enforce FR40 (JSON validation) and FR45 (no Swift writes).
 *
 * Exit codes:
 * - 0: Success (all fixes applied)
 * - 1: Failure (fixer subagent failed or fixes could not be applied)
 */
/** A single finding from Story 2.1's verifier that needs fixing */
export interface ContentFinding {
    /** Event title that was flagged */
    title: string;
    /** Gate codes that failed (e.g., ["F1"], ["P2"], ["D2"]) */
    codes: string[];
    /** Human-readable details about the failure */
    details: string;
    /** Path to the source JSON file containing the event */
    sourceFile: string;
    /** Suggested correct value (optional — for F1 year fixes, etc.) */
    suggestedFix?: string;
}
/** Input for the content fix workflow */
export interface ContentFixInput {
    /** Findings to fix */
    findings: ContentFinding[];
    /** Path to the corrections log JSON file (absolute) */
    correctionsLogPath: string;
    /** Working directory for the subagent (repo root) */
    repoRoot?: string;
}
/** Result of a single fix attempt */
export interface ContentFixResult {
    /** Event title that was fixed */
    title: string;
    /** Whether the fix was applied successfully */
    fixed: boolean;
    /** Gate codes that were addressed */
    codes: string[];
    /** Description of what was done */
    action: string;
}
/** Complete result of the content fix workflow */
export interface ContentFixOutput {
    /** Total findings received */
    total_findings: number;
    /** Number successfully fixed */
    fixed: number;
    /** Number that could not be fixed */
    failed: number;
    /** Per-finding results */
    results: ContentFixResult[];
    /** Whether corrections log was updated */
    corrections_log_updated: boolean;
}
export declare function runContentFix(input: ContentFixInput): Promise<ContentFixOutput>;
