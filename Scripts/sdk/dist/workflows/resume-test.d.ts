/**
 * Story 4.3: Resume-by-Issue Lookup Test Harness
 *
 * Validates findWorkflowByIssue() — the function that maps a GitHub issue number
 * back to a paused SDK workflow. This is the bridge between the Cloudflare Worker
 * (which knows the issue number) and the SDK state directory (which has workflow files).
 *
 * Pure logic test — NO Anthropic API calls, NO GitHub API calls.
 * Cost: $0.00
 *
 * Tests:
 * - resume-1: Create state with issue_number=42, find it -> returns match
 * - resume-2: Find issue_number=999 (no match) -> returns null
 * - resume-3: Create 2 states for issue_number=42, find -> returns most recent
 * - resume-4: Create state with issue_number=null, find 42 -> returns null
 *
 * Exit codes:
 * - 0: All tests pass
 * - 1: One or more tests fail
 */
/** Run the resume-by-issue test suite */
export declare function runResumeByIssueTest(): Promise<void>;
