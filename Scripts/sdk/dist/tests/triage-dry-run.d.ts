/**
 * Story 3.2: Dry-Run Testing Script (BA-011 FR18, FR19, ARCH-7)
 *
 * Feeds known bug descriptions from triage-fixtures.ts through the real
 * runTriage() function (calls Haiku API) and reports accuracy.
 *
 * NOT a CI test — runs manually by operator before deployment.
 * Requires ANTHROPIC_API_KEY and costs real money (~$0.03-$0.10 per run).
 *
 * Usage:
 *   npx tsx Scripts/sdk/tests/triage-dry-run.ts           # All fixtures
 *   npx tsx Scripts/sdk/tests/triage-dry-run.ts --fixture test-A  # Single fixture
 *
 * Output: Human-readable summary + JSON summary for programmatic comparison.
 *
 * Exit codes:
 * - 0: Dry-run completed (regardless of accuracy)
 * - 1: Fatal error (e.g., no fixtures, all API calls failed)
 */
export {};
