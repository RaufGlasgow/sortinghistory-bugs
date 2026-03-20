/**
 * BA-008.2: Translation End-to-End Orchestration
 *
 * Full translation pipeline: verify -> approval gate -> fix (per language) -> re-verify -> PR
 *
 * State machine:
 *   verifying -> awaiting_approval -> fixing -> re_verifying -> complete | escalated
 *
 * Follows the content pipeline pattern (content-e2e.ts) but adapted for translations:
 *   1. Analyze bug report + scan LocalizationHelper.swift to identify affected keys/languages
 *   2. Save state as awaiting_approval with findings, pause session
 *   3. On resume (with approval): run fixer subagent per language (one language at a time)
 *   4. Run verifier to check T3-T9 gates on the output
 *   5. If verification passes -> create PR. If fails -> retry (up to MAX_FIX_ATTEMPTS)
 *   6. On exhausted retries -> generate handoff, post comment, label issue -> escalated
 *
 * No approval gate bypass -- translation fixes always pause for human approval.
 * French is flagged for extra review (in codebase but not in translation agent docs).
 *
 * Exit codes:
 * - 0: Success (workflow completed -- either PR created or escalated)
 * - 1: Failure (could not run pipeline)
 */
import { type WorkflowStatus } from "../config.js";
/** Input for the translation E2E orchestration */
export interface TranslationE2EInput {
    /** GitHub issue number that triggered this workflow */
    issueNumber: number;
    /** Issue body text (bug report) */
    issueBody: string;
    /** Issue title */
    issueTitle: string;
    /** Path to game repo checkout */
    gameRepoPath: string;
    /** If true, skip PR creation */
    dryRun?: boolean;
    /** Branch name for PR */
    branch?: string;
    /** Base branch for PR */
    baseBranch?: string;
}
/** Result of the translation E2E orchestration */
export interface TranslationE2EResult {
    status: WorkflowStatus;
    workflowId: string;
    /** Number of keys identified as needing translation */
    totalKeys: number;
    /** Number of languages that need fixes */
    languagesAffected: number;
    /** Fix attempts used */
    fixAttempts: number;
    /** PR number if created */
    prNumber: number | null;
    /** PR URL if created */
    prUrl: string | null;
    /** Error message */
    error: string | null;
}
/** Translation finding -- what needs to be fixed */
export interface TranslationFinding {
    key: string;
    englishValue: string;
    /** Languages where this key is missing or wrong */
    missingIn: string[];
    wrongIn: string[];
}
/**
 * Analyze the bug report to determine which keys and languages are affected.
 * Scans LocalizationHelper.swift for the English keys and checks each language section.
 */
export declare function analyzeTranslationBug(issueBody: string, gameRepoPath: string): {
    findings: TranslationFinding[];
    englishKeys: Record<string, string>;
};
/**
 * Run the full translation E2E pipeline.
 *
 * Phase 1 (verifying): Analyze bug report + scan LocalizationHelper.swift
 * Phase 2 (awaiting_approval): Pause for human approval
 * Phase 3 (fixing): Run fixer per language, then verify
 * Phase 4 (complete/escalated): Create PR or escalate
 */
export declare function runTranslationE2E(input: TranslationE2EInput): Promise<TranslationE2EResult>;
/**
 * Resume a paused translation workflow after human approval.
 *
 * Steps:
 * 1. Load workflow state
 * 2. Process approval
 * 3. Run fixer for each language (one at a time)
 * 4. Verify translations
 * 5. Create PR or escalate
 */
export declare function resumeTranslationE2E(workflowId: string, action: "approve" | "reject", options?: {
    gameRepoPath?: string;
    dryRun?: boolean;
    branch?: string;
    baseBranch?: string;
}): Promise<TranslationE2EResult>;
