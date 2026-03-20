/**
 * Story 2.4a: Real Triage Command
 *
 * Fetches a real GitHub issue from the private repo, classifies it using Haiku,
 * and feeds the result to routing for automatic dispatch or labeling.
 *
 * Signal path: webhook fires `analyze` -> CI triages -> routes to pipeline
 *
 * This reuses the core classification logic from bug-triage.ts but operates
 * against real GitHub issues instead of test fixtures.
 *
 * Exit codes:
 * - 0: Success (triage + routing completed)
 * - 1: Failure (API error, invalid issue, classification failure)
 */
import { type TriageResult } from "./bug-triage.js";
/**
 * Extract contextual signals from a bug report for the triage handoff.
 * Story 3.5 AC2: Identifies what signals ARE present and what's missing.
 */
export declare function extractTriageSignals(body: string, title: string): {
    found: string[];
    missing: string[];
    suggestedSteps: string[];
};
/** Input for the real triage command */
export interface RealTriageInput {
    /** GitHub issue number on the private repo */
    issueNumber: number;
    /** Story 3.11: Owner correction notes from dispatch payload (optional) */
    correctionNotes?: string;
}
/** Result from the real triage command */
export interface RealTriageResult {
    /** Issue number that was triaged */
    issueNumber: number;
    /** Triage classification result */
    triage: TriageResult;
    /** Whether routing was executed */
    routed: boolean;
    /** Error message if something went wrong */
    error: string | null;
}
/**
 * Story 3.11 AC3: Extract owner feedback comments from issue comments.
 * Filters for comments containing ## Owner Correction or ## Owner Reclassification headers.
 * Returns matching comments in newest-first order.
 */
export declare function extractOwnerComments(comments: {
    body: string;
}[]): string[];
/**
 * Run real triage on a GitHub issue.
 *
 * 1. Fetches issue from private repo
 * 2. Classifies with Haiku (reuses bug-triage.ts)
 * 3. Posts classification comment on issue
 * 4. Feeds result to routing (dispatch or label)
 * 5. Posts routing comment on issue
 */
export declare function runRealTriage(input: RealTriageInput): Promise<RealTriageResult>;
/** Build the classification result comment (AC4, PV2-6.1) */
export declare function buildClassificationComment(triage: TriageResult): string;
