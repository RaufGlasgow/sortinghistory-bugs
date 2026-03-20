/**
 * Story PV2-2.1: Smart Model Router
 *
 * Determines the correct Claude model for fix generation and QA review
 * based on bug profile classification and attempt number.
 *
 * Cost optimization: uses the cheapest model that can handle the job,
 * escalating to more capable (and expensive) models only on retry.
 *
 * Model tiers (cheapest to most capable):
 *   Haiku 4.5 < Sonnet 4.5
 *
 * QA model rule: QA model is always <= fix model tier.
 */
import { type WorkflowType } from "../config.js";
/** Bug profile — determines model escalation path */
export type BugProfile = "content_simple" | "content_complex" | "code_simple" | "code_complex";
/** QA profile — determines which QA checks to run */
export type QAProfile = "code" | "content" | "both";
/** Input for determineBugProfile() */
export interface BugProfileInput {
    /** Triage classification (e.g. "content_error", "ui_bug", "gameplay_bug", "translation_error") */
    classification: string;
    /** Triage confidence score, 0-1 */
    confidence: number;
    /** File extensions of files likely to change (e.g. [".json", ".swift"]) */
    fileExtensions: string[];
}
/** Output from selectModels() — everything needed to configure fix + QA subagents */
export interface ModelSelection {
    /** Model ID for the fix generation subagent */
    fixModel: string;
    /** Model ID for the QA review subagent */
    qaModel: string;
    /** Max agentic turns for the fix subagent */
    fixMaxTurns: number;
    /** Max agentic turns for the QA subagent */
    qaMaxTurns: number;
    /** QA profile: determines which checks to run */
    qaProfile: QAProfile;
}
/**
 * Classify a bug into one of 4 profiles based on triage output.
 *
 * Profile rules:
 * - content_error or translation_error with confidence >= 0.8 -> content_simple
 * - content_error or translation_error with confidence < 0.8  -> content_complex
 * - ui_bug, gameplay_bug, or other code bugs with single file -> code_simple
 * - ui_bug, gameplay_bug, or other code bugs with multiple files -> code_complex
 */
export declare function determineBugProfile(input: BugProfileInput): BugProfile;
/**
 * Determine the QA profile based on which file types will be modified.
 *
 * - "code" for .swift/.pbxproj/etc changes only
 * - "content" for .json/.strings changes only
 * - "both" for mixed changes
 */
export declare function determineQAProfile(fileExtensions: string[]): QAProfile;
/**
 * Select models and configuration for fix generation and QA review.
 *
 * @param profile - Bug profile from determineBugProfile()
 * @param attemptNumber - Current attempt (1-based, clamped to MAX_FIX_ATTEMPTS)
 * @param fileExtensions - File extensions to determine QA profile
 * @param options - Optional: backend override for local inference routing (Story 1.3)
 * @returns ModelSelection with fix/QA models, turn limits, and QA profile
 */
export declare function selectModels(profile: BugProfile, attemptNumber: number, fileExtensions: string[], options?: {
    backend?: "local" | "claude";
    workflowType?: WorkflowType;
}): ModelSelection;
