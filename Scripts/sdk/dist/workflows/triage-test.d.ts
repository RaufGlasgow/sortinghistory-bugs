/**
 * Story 4.1: Triage Test Harness
 *
 * Runs all triage fixtures through the bug triager subagent and validates:
 * - classification matches expected_classification (string or one of string[])
 * - severity is within expected_severity_range
 *
 * Logs per-fixture PASS/FAIL with details.
 * Exits 0 if all pass, exits 1 if any fail.
 *
 * Expected total cost: ~$0.21 (7 fixtures x ~$0.03 each)
 */
/** Run the triage test suite */
export declare function runTriageTest(): Promise<void>;
