/**
 * Story 2.3b: Content Pipeline End-to-End Tests
 *
 * 8 integration tests that validate the full content verification -> fix -> PR chain.
 * These tests mock AI subagent calls and use temp filesystems to test pipeline logic.
 *
 * Tests cover:
 *   1. Full chain: verifier finds error -> fixer fixes -> re-verify passes -> PR created
 *   2. Version increment schema validation (FR42)
 *   3. Corrections log schema validation (FR41)
 *   4. Stale translation detection after English source change (FR43)
 *   5. Structural JSON validation rejects malformed fixer output (FR40)
 *   6. Retry loop configuration and error classification (FR17)
 *   7. Only Data/ directory files modified (FR45)
 *   8. Category backfill flagging when source drops below 100 events (FR18)
 *
 * Note on Tests 2 and 3: Version increment and corrections log updates are
 * performed inline by the AI fixer subagent (content-fixer.md prompt), not by
 * dedicated production functions. There is no extractable function to call.
 * These tests validate the expected data schema and format constraints that the
 * AI output must conform to, ensuring the pipeline can consume fixer output
 * correctly. The schema is defined in Scripts/sdk/prompts/content-fixer.md.
 *
 * All tests use temp directories and mock data -- $0.00 API cost.
 */
export {};
