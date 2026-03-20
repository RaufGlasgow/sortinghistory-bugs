/**
 * BA-011 Story 3.3: Morning Digest Confidence Integration
 *
 * Reads routing decision log (JSONL) to extract confidence data for the
 * morning digest email. Falls back to label-based detection when the
 * routing log is unavailable.
 *
 * This module is pure logic — no API calls, no side effects.
 * The GitHub Actions workflow calls the CLI entry point (digest-confidence-cli.ts)
 * which invokes these functions and outputs JSON for the bash steps to consume.
 *
 * Covers: FR22, FR23, FR24
 */
/** Confidence data for a single issue, as consumed by the digest */
export interface IssueConfidenceData {
    /** GitHub issue number */
    issue: number;
    /** Classification string (e.g., "content_error") */
    classification: string;
    /** Confidence as 0.0-1.0 */
    confidence: number;
    /** Which routing gate fired */
    gate: string;
    /** Labels applied */
    labels: string[];
    /** Whether this issue needs attention (low confidence or unknown classification) */
    needs_attention: boolean;
    /** Reason for flagging (empty string if not flagged) */
    flag_reason: string;
    /** Display string: "content_error (92%)" */
    display: string;
}
/** Output from the digest confidence reader */
export interface DigestConfidenceResult {
    /** Date the data covers (YYYY-MM-DD) */
    date: string;
    /** Source of the data: "routing_log" or "label_fallback" */
    source: "routing_log" | "label_fallback";
    /** Issues that need attention (low confidence, unknown classification) */
    needs_attention: IssueConfidenceData[];
    /** Normal-confidence issues */
    normal: IssueConfidenceData[];
    /** All issues combined (needs_attention first, then normal) */
    all: IssueConfidenceData[];
}
/**
 * Read routing decision log for a given date and return confidence data.
 *
 * Primary source: JSONL file at state/routing-log/YYYY-MM-DD.jsonl
 * Fallback: returns empty result with source="label_fallback" so the
 * workflow can fall back to label-based detection.
 *
 * @param date - YYYY-MM-DD string (defaults to today)
 * @param repoRoot - Repository root directory (defaults to env or cwd)
 */
export declare function readRoutingLogForDate(date?: string, repoRoot?: string): DigestConfidenceResult;
/**
 * Build label-based fallback confidence data from GitHub labels.
 *
 * Used when the routing log is unavailable. Detects flagged issues
 * by looking for low-confidence and unknown-classification labels.
 *
 * @param issues - Array of {number, labels} from GitHub API
 */
export declare function buildLabelFallback(issues: Array<{
    number: number;
    labels: string[];
}>): DigestConfidenceResult;
/**
 * Render the "Needs Attention" HTML section for the digest email.
 *
 * Returns empty string when there are no flagged issues (AC: omit section entirely).
 *
 * @param flaggedIssues - Issues from needs_attention array
 * @param issueUrlBase - Base URL for GitHub issues (e.g., "https://github.com/RaufGlasgow/Sorting-History/issues/")
 */
export declare function renderNeedsAttentionHtml(flaggedIssues: IssueConfidenceData[], issueUrlBase: string): string;
/**
 * Format a classification + confidence for inline display in bug cards.
 *
 * Returns: "content_error (92%)" or "content_error (confidence unknown)" for label fallback.
 */
export declare function formatClassificationDisplay(classification: string, confidence: number): string;
