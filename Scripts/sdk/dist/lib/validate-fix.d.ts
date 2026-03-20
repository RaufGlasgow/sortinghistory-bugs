/**
 * validate-fix.ts — Pre-PR validation gate for pipeline-generated fixes.
 *
 * Pure computation: reads issue data + diff file, returns a structured result.
 * NO state-mutating GitHub API calls (AC13). Read-only API calls are OK.
 *
 * Architecture ref: Section 5.3, lines 362-399
 * Story: 2.0b
 */
/** Structured validation result (AC7) */
export interface ValidationResult {
    valid: boolean;
    reason?: string;
    details?: string;
}
/** Issue data needed for validation (fetched by caller or passed directly) */
export interface IssueData {
    number: number;
    body: string;
    labels: string[];
}
/** Parsed diff information */
export interface DiffInfo {
    files: string[];
    raw: string;
}
/**
 * Parse a unified diff file and extract the list of changed file paths.
 * Supports standard `diff --git a/path b/path` format and `--- a/path` / `+++ b/path`.
 */
export declare function parseDiffFiles(diffContent: string): string[];
/**
 * Extract the language code from issue labels.
 * Looks for labels matching `lang:XX` pattern (e.g., `lang:de`, `lang:es-419`).
 */
export declare function extractLangLabel(labels: string[]): string | null;
/**
 * Determine bug type from issue labels.
 * Returns "content-error", "translation-error", or null if neither.
 */
export declare function extractBugType(labels: string[]): "content-error" | "translation-error" | null;
/**
 * Validate a fix diff against the original issue before PR creation.
 *
 * AC1: Exported from Scripts/sdk/lib/validate-fix.ts
 * AC2: Accepts issueData (containing number, body, labels) and diffPath
 * AC13: Pure computation — no state-mutating GitHub API calls
 *
 * @param issueData - Issue details (number, body, labels). Caller fetches this.
 * @param diffPath - Local file path to the generated diff.
 * @returns Structured validation result.
 */
export declare function validateFix(issueData: IssueData, diffPath: string): ValidationResult;
