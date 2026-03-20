/**
 * Story 2.3: Content E2E Test Runner
 *
 * Two tests:
 *   1. Happy Path: Plant 1 error (Columbus wrong year), run full E2E with
 *      simulated approval, verify state transitions and PR creation (dry-run).
 *   2. Escalation: Simulate a fix that always fails re-verification (by making
 *      the fixer receive an impossible finding), verify escalation after 2 attempts.
 *
 * Both tests use temp copies of fixture data -- never modifies real game data.
 *
 * Exit codes:
 * - 0: All tests pass
 * - 1: One or more tests fail
 */
export declare function runContentE2ETest(): Promise<void>;
