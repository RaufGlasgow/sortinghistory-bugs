/**
 * Story 3.3: Launch Readiness Validation
 *
 * Helper functions for the 6 launch readiness checks:
 * - Volume test: submit 10 bug reports and collect responses
 * - Stuck issue detector: identify issues with no activity > 48 hours
 * - Digest URL extractor: find all action button links in digest HTML
 * - Concurrent state file validation: verify no cross-contamination
 *
 * These are pure computation / utility functions used by the automated tests
 * and by the manual validation scripts.
 *
 * Covers: FR33, FR34, FR35, FR39, FR40, FR44, FR45, FR49
 */
/** A test bug report payload for the volume test */
export interface TestBugReport {
    description: string;
    category: string;
    email?: string;
    deviceInfo?: {
        model?: string;
        osVersion?: string;
        appVersion?: string;
    };
}
/** Response from a single bug report submission */
export interface SubmissionResult {
    index: number;
    status: number;
    issueNumber: number | null;
    issueUrl: string | null;
    error: string | null;
}
/** Result of the volume test */
export interface VolumeTestResult {
    total_submitted: number;
    successful: number;
    failed: number;
    results: SubmissionResult[];
    duplicate_issue_numbers: number[];
}
/** An issue with its last update timestamp for stuck detection */
export interface IssueActivity {
    number: number;
    title: string;
    labels: string[];
    updated_at: string;
    html_url: string;
}
/** Stuck issue detection result */
export interface StuckIssueResult {
    issue_number: number;
    title: string;
    labels: string[];
    hours_since_update: number;
    html_url: string;
    is_stuck: boolean;
}
/** Extracted action button from digest HTML */
export interface DigestActionButton {
    url: string;
    label: string;
    issue_or_pr: string | null;
    action_type: string | null;
}
/** Concurrent state file validation result */
export interface ConcurrentStateResult {
    file_count: number;
    files: string[];
    has_cross_contamination: boolean;
    contamination_details: string[];
}
/** The 10 pre-defined test bug reports covering all classification types */
export declare const TEST_BUG_REPORTS: TestBugReport[];
/**
 * Submit multiple bug reports to the Worker endpoint and collect responses.
 *
 * @param endpointUrl - The Worker /api/bugs endpoint URL
 * @param reports - Array of bug report payloads
 * @param fetchFn - Fetch function (injectable for testing)
 * @returns Volume test results with per-report status
 */
export declare function submitVolumeTest(endpointUrl: string, reports: TestBugReport[], fetchFn?: typeof fetch): Promise<VolumeTestResult>;
/**
 * Detect stuck issues: issues with `in-progress` label (or similar)
 * that have not been updated in over 48 hours.
 *
 * @param issues - Array of issue activity data
 * @param now - Current time (injectable for testing)
 * @returns Array of stuck issue results with classification
 */
export declare function detectStuckIssues(issues: IssueActivity[], now?: Date): StuckIssueResult[];
/**
 * Extract all action button URLs from digest HTML.
 *
 * Looks for <a> tags with pipeline action URLs:
 * - /api/pipeline/approve
 * - /api/pipeline/reject
 * - /api/pipeline/merge
 * - /api/pipeline/rework
 * - /api/pipeline/redo
 * - /api/pipeline/comment
 * - /api/pipeline/fix-locally
 *
 * @param html - The full digest email HTML
 * @returns Array of extracted action buttons with metadata
 */
export declare function extractDigestActionUrls(html: string): DigestActionButton[];
/**
 * Validate that concurrent workflows create separate, non-contaminated state files.
 *
 * Checks:
 * 1. Each workflow has its own state file
 * 2. No state file references the wrong issue_number
 * 3. No state file has mixed workflow_type data
 *
 * @param stateDir - Directory containing workflow state files
 * @param expectedWorkflows - Array of { workflowId, issueNumber, workflowType }
 * @returns Validation result with contamination details
 */
export declare function validateConcurrentStateFiles(stateDir: string, expectedWorkflows: Array<{
    workflow_id: string;
    issue_number: number;
    workflow_type: string;
}>): ConcurrentStateResult;
/**
 * Create test state files for concurrent workflow simulation.
 * Used by the automated test to set up the scenario.
 *
 * @param stateDir - Directory to create state files in
 * @param workflows - Array of workflow configurations
 */
export declare function createTestStateFiles(stateDir: string, workflows: Array<{
    workflow_id: string;
    issue_number: number;
    workflow_type: string;
    status?: string;
}>): void;
