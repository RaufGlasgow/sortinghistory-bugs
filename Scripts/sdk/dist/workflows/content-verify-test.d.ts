/**
 * Story 2.1: Content Verifier Test Runner
 *
 * Runs the content verifier against the test fixture file and validates:
 * - All 5 planted errors are correctly identified
 * - No more than 1 of the 5 good events is false-positive flagged
 * - Output is structured JSON with per-event gate results
 *
 * Exit codes:
 * - 0: All acceptance criteria met
 * - 1: One or more criteria failed
 */
/** Run the content verifier test suite */
export declare function runContentVerifyTest(): Promise<void>;
