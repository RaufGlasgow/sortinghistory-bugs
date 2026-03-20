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
import * as fs from "node:fs";
import * as path from "node:path";
// ---------------------------------------------------------------------------
// Volume test helpers
// ---------------------------------------------------------------------------
/** The 10 pre-defined test bug reports covering all classification types */
export const TEST_BUG_REPORTS = [
    {
        description: "Moon Landing shows 1968, should be 1969",
        category: "content_error",
        deviceInfo: { model: "iPhone 15", osVersion: "18.0", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Boston Tea Party description says 1774 instead of 1773",
        category: "content_error",
        deviceInfo: { model: "iPhone 15", osVersion: "18.0", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Wright Brothers flight listed as Kitty Hawk, NC but says Ohio",
        category: "content_error",
        deviceInfo: { model: "iPad Pro", osVersion: "18.0", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "German translation of 'Daily Challenge' still shows English",
        category: "translation_error",
        deviceInfo: { model: "iPhone 14", osVersion: "17.5", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Dutch 'Renaissance' event has French text instead of Dutch",
        category: "translation_error",
        deviceInfo: { model: "iPhone 13", osVersion: "17.4", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Settings button wrong color in dark mode",
        category: "ui_bug",
        deviceInfo: { model: "iPhone 15 Pro", osVersion: "18.0", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Share card text overlaps with score on small screens",
        category: "ui_bug",
        deviceInfo: { model: "iPhone SE", osVersion: "17.5", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Game crashes on Epic mode with Science History category",
        category: "gameplay_bug",
        deviceInfo: { model: "iPhone 15 Pro Max", osVersion: "18.0", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Timer doesn't pause when app goes to background",
        category: "gameplay_bug",
        deviceInfo: { model: "iPad Air", osVersion: "18.0", appVersion: "1.1.0-alpha.265" },
    },
    {
        description: "Add a speed round mode with timer",
        category: "feature_request",
        deviceInfo: { model: "iPhone 14 Pro", osVersion: "17.5", appVersion: "1.1.0-alpha.265" },
    },
];
/**
 * Submit multiple bug reports to the Worker endpoint and collect responses.
 *
 * @param endpointUrl - The Worker /api/bugs endpoint URL
 * @param reports - Array of bug report payloads
 * @param fetchFn - Fetch function (injectable for testing)
 * @returns Volume test results with per-report status
 */
export async function submitVolumeTest(endpointUrl, reports, fetchFn = fetch) {
    const results = [];
    // Submit all reports in parallel (rapid succession)
    const promises = reports.map(async (report, index) => {
        try {
            const response = await fetchFn(endpointUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(report),
            });
            const status = response.status;
            let issueNumber = null;
            let issueUrl = null;
            if (response.ok) {
                try {
                    const body = await response.json();
                    issueNumber = typeof body.issueNumber === "number" ? body.issueNumber : null;
                    issueUrl = typeof body.issueUrl === "string" ? body.issueUrl : null;
                }
                catch {
                    // Response wasn't JSON — still count as success if status was 2xx
                }
            }
            return {
                index,
                status,
                issueNumber,
                issueUrl,
                error: response.ok ? null : `HTTP ${status}`,
            };
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            return {
                index,
                status: 0,
                issueNumber: null,
                issueUrl: null,
                error: errMsg,
            };
        }
    });
    const settled = await Promise.all(promises);
    results.push(...settled.sort((a, b) => a.index - b.index));
    // Check for duplicate issue numbers
    const issueNumbers = results
        .map((r) => r.issueNumber)
        .filter((n) => n !== null);
    const seen = new Set();
    const duplicates = [];
    for (const num of issueNumbers) {
        if (seen.has(num)) {
            duplicates.push(num);
        }
        seen.add(num);
    }
    return {
        total_submitted: reports.length,
        successful: results.filter((r) => r.status >= 200 && r.status < 300).length,
        failed: results.filter((r) => r.status < 200 || r.status >= 300).length,
        results,
        duplicate_issue_numbers: duplicates,
    };
}
// ---------------------------------------------------------------------------
// Stuck issue detector
// ---------------------------------------------------------------------------
/** Threshold for "stuck" detection: 48 hours in milliseconds */
const STUCK_THRESHOLD_MS = 48 * 60 * 60 * 1000;
/**
 * Detect stuck issues: issues with `in-progress` label (or similar)
 * that have not been updated in over 48 hours.
 *
 * @param issues - Array of issue activity data
 * @param now - Current time (injectable for testing)
 * @returns Array of stuck issue results with classification
 */
export function detectStuckIssues(issues, now = new Date()) {
    return issues.map((issue) => {
        const updatedAt = new Date(issue.updated_at);
        const msSinceUpdate = now.getTime() - updatedAt.getTime();
        const hoursSinceUpdate = Math.round(msSinceUpdate / (60 * 60 * 1000));
        const isStuck = msSinceUpdate > STUCK_THRESHOLD_MS;
        return {
            issue_number: issue.number,
            title: issue.title,
            labels: issue.labels,
            hours_since_update: hoursSinceUpdate,
            html_url: issue.html_url,
            is_stuck: isStuck,
        };
    });
}
// ---------------------------------------------------------------------------
// Digest URL extractor
// ---------------------------------------------------------------------------
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
export function extractDigestActionUrls(html) {
    const buttons = [];
    // Match <a href="URL">LABEL</a> patterns
    // Use a regex that captures href and link text
    const linkRegex = /<a\s+[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
        const url = match[1];
        const label = match[2].trim();
        // Only include pipeline action URLs
        if (!url.includes("/api/pipeline/")) {
            continue;
        }
        // Extract action type from URL path
        const actionMatch = url.match(/\/api\/pipeline\/([a-z-]+)/);
        const actionType = actionMatch ? actionMatch[1] : null;
        // Extract issue or PR number from URL query params
        const issueMatch = url.match(/[?&]issue=(\d+)/);
        const prMatch = url.match(/[?&]pr=(\d+)/);
        const issueOrPr = issueMatch
            ? `issue-${issueMatch[1]}`
            : prMatch
                ? `pr-${prMatch[1]}`
                : null;
        buttons.push({
            url: url.replace(/&amp;/g, "&"), // Decode HTML entities
            label,
            issue_or_pr: issueOrPr,
            action_type: actionType,
        });
    }
    return buttons;
}
// ---------------------------------------------------------------------------
// Concurrent state file validation
// ---------------------------------------------------------------------------
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
export function validateConcurrentStateFiles(stateDir, expectedWorkflows) {
    const files = [];
    const contamination = [];
    for (const expected of expectedWorkflows) {
        const filePath = path.join(stateDir, `${expected.workflow_id}.json`);
        if (!fs.existsSync(filePath)) {
            contamination.push(`Missing state file: ${expected.workflow_id}.json`);
            continue;
        }
        files.push(expected.workflow_id);
        try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const state = JSON.parse(raw);
            // Check issue_number matches
            if (state.issue_number !== expected.issue_number) {
                contamination.push(`${expected.workflow_id}: issue_number is ${state.issue_number}, expected ${expected.issue_number}`);
            }
            // Check workflow_type matches
            if (state.workflow_type !== expected.workflow_type) {
                contamination.push(`${expected.workflow_id}: workflow_type is ${state.workflow_type}, expected ${expected.workflow_type}`);
            }
            // Validate JSON integrity (FR40)
            JSON.stringify(state); // Will throw if circular refs
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            contamination.push(`${expected.workflow_id}: parse error: ${errMsg}`);
        }
    }
    return {
        file_count: files.length,
        files,
        has_cross_contamination: contamination.length > 0,
        contamination_details: contamination,
    };
}
/**
 * Create test state files for concurrent workflow simulation.
 * Used by the automated test to set up the scenario.
 *
 * @param stateDir - Directory to create state files in
 * @param workflows - Array of workflow configurations
 */
export function createTestStateFiles(stateDir, workflows) {
    if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
    }
    for (const wf of workflows) {
        const state = {
            workflow_id: wf.workflow_id,
            workflow_type: wf.workflow_type,
            status: wf.status ?? "verifying",
            session_id: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            trigger: "dispatch",
            category: null,
            findings: [],
            approved_findings: [],
            rejected_findings: [],
            fix_attempts: 0,
            max_fix_attempts: 3,
            fix_results: [],
            pr_number: null,
            error: null,
            issue_number: wf.issue_number,
            attempt_log: [],
            qa_results: [],
            models_used: [],
        };
        const filePath = path.join(stateDir, `${wf.workflow_id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    }
}
