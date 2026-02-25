/**
 * Story 2.1: Content Verifier Subagent
 *
 * Runs a two-phase content verification pipeline:
 *   Phase 1 (Automated): validate_content.py checks G0, P1-P12, D1-D3
 *   Phase 2 (AI):         Haiku subagent checks Gate 1 (factual) and Gate 2 (age)
 *
 * Only events that PASS automated gates proceed to AI verification.
 * Output is structured JSON combining both phases.
 *
 * Exit codes:
 * - 0: Success (verification completed, results returned)
 * - 1: Failure (could not run verification pipeline)
 */
/** Automated gate failure from validate_content.py or inline fallback */
interface AutomatedFailure {
    title: string;
    codes: string[];
    details: string;
}
/** AI gate failure from Haiku subagent */
interface AiFailure {
    title: string;
    codes: string[];
    details: string;
}
/** Complete verification result combining both phases */
export interface ContentVerificationResult {
    category: string;
    total_events: number;
    automated_gates: {
        passed: number;
        failed: number;
        failures: AutomatedFailure[];
    };
    ai_gates: {
        checked: number;
        passed: number;
        failed: number;
        failures: AiFailure[];
    };
    summary: {
        total_passed: number;
        total_failed: number;
        all_failures: Array<AutomatedFailure | AiFailure>;
    };
}
/** Input for the content verification workflow */
export interface ContentVerifyInput {
    /** Path to the JSON file to verify (absolute or relative to cwd) */
    filePath: string;
    /** Category name (used for logging) */
    category?: string;
}
export declare function runContentVerify(input: ContentVerifyInput): Promise<ContentVerificationResult>;
export {};
