/**
 * Story 3.3: Launch Readiness Validation Tests (4 tests)
 *
 * Tests the validation tooling used during the manual launch readiness checks.
 * These are automated unit tests -- the actual launch readiness checks are manual.
 *
 * Test 1: Volume test script submits 10 reports and collects responses
 * Test 2: Stuck issue detector identifies issues with no activity > 48 hours
 * Test 3: Digest URL extractor finds all action button links
 * Test 4: Concurrent workflows create separate state files
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { submitVolumeTest, detectStuckIssues, extractDigestActionUrls, validateConcurrentStateFiles, createTestStateFiles, TEST_BUG_REPORTS, } from "../lib/launch-readiness.js";
// ---------------------------------------------------------------------------
// Test 1: Volume test script submits 10 reports and collects responses
// ---------------------------------------------------------------------------
describe("Story 3.3: Launch Readiness", () => {
    it("volume test script submits 10 reports and collects responses", async () => {
        // Mock fetch that returns incrementing issue numbers
        let callCount = 0;
        const mockFetch = async (url, init) => {
            callCount++;
            const currentNum = 200 + callCount;
            return new Response(JSON.stringify({
                issueNumber: currentNum,
                issueUrl: `https://github.com/RaufGlasgow/Sorting-History/issues/${currentNum}`,
                confirmationId: `TEST-${currentNum}`,
            }), {
                status: 201,
                headers: { "Content-Type": "application/json" },
            });
        };
        const result = await submitVolumeTest("https://bug-webhook.emptycupmedia.workers.dev/api/bugs", TEST_BUG_REPORTS, mockFetch);
        // Assert: all 10 submitted
        assert.equal(result.total_submitted, 10, "Should submit exactly 10 reports");
        // Assert: all 10 got 200/201 responses
        assert.equal(result.successful, 10, "All 10 should succeed");
        assert.equal(result.failed, 0, "None should fail");
        // Assert: response bodies contain issue numbers
        for (const r of result.results) {
            assert.ok(r.issueNumber !== null, `Report ${r.index} should have an issue number`);
            assert.ok(r.issueUrl !== null, `Report ${r.index} should have an issue URL`);
        }
        // Assert: no duplicates
        assert.equal(result.duplicate_issue_numbers.length, 0, "Should have no duplicate issue numbers");
    });
    it("volume test detects failures and duplicate issue numbers", async () => {
        // Mock fetch: first 5 succeed, 6th fails, 7-10 succeed but 9 duplicates 7
        let callCount = 0;
        const mockFetch = async (_url, _init) => {
            callCount++;
            if (callCount === 6) {
                return new Response("Internal Server Error", { status: 500 });
            }
            // Issue 9 duplicates issue 7's number (simulating a duplicate bug)
            const issueNum = callCount === 9 ? 207 : 200 + callCount;
            return new Response(JSON.stringify({
                issueNumber: issueNum,
                issueUrl: `https://github.com/test/issues/${issueNum}`,
            }), { status: 201, headers: { "Content-Type": "application/json" } });
        };
        const result = await submitVolumeTest("https://example.com/api/bugs", TEST_BUG_REPORTS, mockFetch);
        assert.equal(result.total_submitted, 10);
        assert.equal(result.successful, 9, "9 should succeed");
        assert.equal(result.failed, 1, "1 should fail");
        assert.equal(result.results[5].status, 500, "Report 6 (index 5) should be 500");
        assert.equal(result.duplicate_issue_numbers.length, 1, "Should detect 1 duplicate");
        assert.equal(result.duplicate_issue_numbers[0], 207, "Duplicate should be issue 207");
    });
    // ---------------------------------------------------------------------------
    // Test 2: Stuck issue detector identifies issues with no activity > 48 hours
    // ---------------------------------------------------------------------------
    it("stuck issue detector identifies issues with no activity > 48 hours", () => {
        const now = new Date("2026-03-09T12:00:00.000Z");
        const issues = [
            {
                // Stuck: updated 72 hours ago (> 48h threshold)
                number: 100,
                title: "Old bug stuck in pipeline",
                labels: ["in-progress", "content-error"],
                updated_at: "2026-03-06T12:00:00.000Z",
                html_url: "https://github.com/test/issues/100",
            },
            {
                // NOT stuck: updated 12 hours ago
                number: 101,
                title: "Recent bug in progress",
                labels: ["in-progress", "ui-bug"],
                updated_at: "2026-03-09T00:00:00.000Z",
                html_url: "https://github.com/test/issues/101",
            },
            {
                // Stuck: updated exactly 49 hours ago (just over threshold)
                number: 102,
                title: "Borderline stuck bug",
                labels: ["in-progress", "gameplay-bug"],
                updated_at: "2026-03-07T11:00:00.000Z",
                html_url: "https://github.com/test/issues/102",
            },
            {
                // NOT stuck: updated exactly 47 hours ago (just under threshold)
                number: 103,
                title: "Almost stuck but not quite",
                labels: ["in-progress", "translation-error"],
                updated_at: "2026-03-07T13:00:00.000Z",
                html_url: "https://github.com/test/issues/103",
            },
            {
                // Stuck: updated 96 hours ago, no in-progress label but still old
                number: 104,
                title: "Very old issue",
                labels: ["fix-failed"],
                updated_at: "2026-03-05T12:00:00.000Z",
                html_url: "https://github.com/test/issues/104",
            },
        ];
        const results = detectStuckIssues(issues, now);
        assert.equal(results.length, 5, "Should return results for all 5 issues");
        // Issue 100: stuck (72h > 48h)
        assert.equal(results[0].is_stuck, true, "Issue 100 should be stuck (72h)");
        assert.equal(results[0].hours_since_update, 72);
        // Issue 101: not stuck (12h < 48h)
        assert.equal(results[1].is_stuck, false, "Issue 101 should NOT be stuck (12h)");
        assert.equal(results[1].hours_since_update, 12);
        // Issue 102: stuck (49h > 48h)
        assert.equal(results[2].is_stuck, true, "Issue 102 should be stuck (49h)");
        assert.equal(results[2].hours_since_update, 49);
        // Issue 103: not stuck (47h < 48h)
        assert.equal(results[3].is_stuck, false, "Issue 103 should NOT be stuck (47h)");
        assert.equal(results[3].hours_since_update, 47);
        // Issue 104: stuck (96h > 48h)
        assert.equal(results[4].is_stuck, true, "Issue 104 should be stuck (96h)");
        assert.equal(results[4].hours_since_update, 96);
        // Verify correct stuck count
        const stuckCount = results.filter((r) => r.is_stuck).length;
        assert.equal(stuckCount, 3, "Should identify exactly 3 stuck issues");
    });
    // ---------------------------------------------------------------------------
    // Test 3: Digest URL extractor finds all action button links
    // ---------------------------------------------------------------------------
    it("digest URL extractor finds all action button links", () => {
        // Sample digest HTML with multiple action buttons
        const sampleDigestHtml = `
    <!DOCTYPE html><html><body>
    <div style="max-width:600px;">
      <!-- Bug card 1 -->
      <div>
        <h3>BUG #150 -- Moon Landing date wrong</h3>
        <a href="https://sortinghistory.com/api/pipeline/approve?issue=150&amp;token=abc123" style="background:#22863a;color:#fff;">Approve Fix</a>
        <a href="https://sortinghistory.com/api/pipeline/reject?issue=150&amp;token=abc123" style="background:#cb2431;color:#fff;">Reject</a>
        <a href="https://sortinghistory.com/api/pipeline/rework?issue=150&amp;token=abc123" style="background:#d97706;color:#fff;">Rework</a>
        <a href="https://sortinghistory.com/api/pipeline/comment?issue=150&amp;token=abc123" style="background:#0366d6;color:#fff;">Need More Info</a>
      </div>

      <!-- Bug card 2 -->
      <div>
        <h3>BUG #151 -- Translation missing</h3>
        <a href="https://sortinghistory.com/api/pipeline/approve?issue=151&amp;token=abc123" style="background:#22863a;color:#fff;">Approve Fix</a>
        <a href="https://sortinghistory.com/api/pipeline/reject?issue=151&amp;token=abc123" style="background:#cb2431;color:#fff;">Reject</a>
        <a href="https://sortinghistory.com/api/pipeline/rework?issue=151&amp;token=abc123" style="background:#d97706;color:#fff;">Rework</a>
        <a href="https://sortinghistory.com/api/pipeline/comment?issue=151&amp;token=abc123" style="background:#0366d6;color:#fff;">Need More Info</a>
      </div>

      <!-- PR card -->
      <div>
        <h3>PR #42 -- Fix moon landing date</h3>
        <a href="https://sortinghistory.com/api/pipeline/merge?pr=42&amp;token=abc123" style="background:#16a34a;color:#fff;">Merge PR</a>
        <a href="https://sortinghistory.com/api/pipeline/reject?issue=150&amp;token=abc123" style="background:#dc2626;color:#fff;">Reject</a>
        <a href="https://sortinghistory.com/api/pipeline/redo?issue=150&amp;token=abc123" style="background:#d97706;color:#fff;">Redo Fix</a>
        <a href="https://sortinghistory.com/api/pipeline/comment?pr=42&amp;token=abc123" style="background:#2563eb;color:#fff;">Ask Question</a>
      </div>

      <!-- Non-pipeline links (should be excluded) -->
      <a href="https://sortinghistory.com" style="color:#8B6914;">Website</a>
      <a href="https://github.com/RaufGlasgow/Sorting-History/issues/150">View on GitHub</a>
      <a href="https://sortinghistory.com/api/pipeline/fix-locally?issue=150&amp;token=abc123" style="background:#6b7280;color:#fff;">Fix Locally</a>
    </div>
    </body></html>`;
        const buttons = extractDigestActionUrls(sampleDigestHtml);
        // Should find: 4 (bug 150) + 4 (bug 151) + 4 (PR 42) + 1 (fix-locally) = 13 pipeline action buttons
        assert.equal(buttons.length, 13, `Should find 13 action buttons, found ${buttons.length}`);
        // Verify action types are extracted
        const actionTypes = buttons.map((b) => b.action_type);
        assert.ok(actionTypes.includes("approve"), "Should find approve buttons");
        assert.ok(actionTypes.includes("reject"), "Should find reject buttons");
        assert.ok(actionTypes.includes("merge"), "Should find merge buttons");
        assert.ok(actionTypes.includes("rework"), "Should find rework buttons");
        assert.ok(actionTypes.includes("redo"), "Should find redo buttons");
        assert.ok(actionTypes.includes("comment"), "Should find comment buttons");
        assert.ok(actionTypes.includes("fix-locally"), "Should find fix-locally buttons");
        // Verify issue/PR numbers are extracted
        const issueRefs = buttons.map((b) => b.issue_or_pr).filter(Boolean);
        assert.ok(issueRefs.includes("issue-150"), "Should extract issue-150");
        assert.ok(issueRefs.includes("issue-151"), "Should extract issue-151");
        assert.ok(issueRefs.includes("pr-42"), "Should extract pr-42");
        // Verify URLs are decoded (no &amp;)
        for (const btn of buttons) {
            assert.ok(!btn.url.includes("&amp;"), `URL should be decoded: ${btn.url}`);
        }
        // Verify non-pipeline links are excluded
        const nonPipelineUrls = buttons.filter((b) => b.url === "https://sortinghistory.com" || b.url.includes("github.com"));
        assert.equal(nonPipelineUrls.length, 0, "Should exclude non-pipeline links");
    });
    // ---------------------------------------------------------------------------
    // Test 4: Concurrent workflows create separate state files
    // ---------------------------------------------------------------------------
    it("concurrent workflows create separate state files", () => {
        // Create a temp directory for this test
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-readiness-test-"));
        const stateDir = path.join(tempDir, "state", "workflows");
        try {
            // Simulate two concurrent workflows
            const workflows = [
                {
                    workflow_id: "cv-2026-03-09-001",
                    issue_number: 160,
                    workflow_type: "content_verification",
                    status: "verifying",
                },
                {
                    workflow_id: "tv-2026-03-09-001",
                    issue_number: 161,
                    workflow_type: "translation_verification",
                    status: "verifying",
                },
            ];
            // Create the state files (simulating concurrent workflow creation)
            createTestStateFiles(stateDir, workflows);
            // Verify files exist
            assert.ok(fs.existsSync(path.join(stateDir, "cv-2026-03-09-001.json")), "Content verification state file should exist");
            assert.ok(fs.existsSync(path.join(stateDir, "tv-2026-03-09-001.json")), "Translation verification state file should exist");
            // Validate: no cross-contamination
            const result = validateConcurrentStateFiles(stateDir, workflows);
            assert.equal(result.file_count, 2, "Should find 2 state files");
            assert.equal(result.has_cross_contamination, false, "Should have no cross-contamination");
            assert.equal(result.contamination_details.length, 0, "Should have no contamination details");
            // Verify each file has correct data
            const cvState = JSON.parse(fs.readFileSync(path.join(stateDir, "cv-2026-03-09-001.json"), "utf-8"));
            assert.equal(cvState.issue_number, 160, "CV state should reference issue 160");
            assert.equal(cvState.workflow_type, "content_verification");
            const tvState = JSON.parse(fs.readFileSync(path.join(stateDir, "tv-2026-03-09-001.json"), "utf-8"));
            assert.equal(tvState.issue_number, 161, "TV state should reference issue 161");
            assert.equal(tvState.workflow_type, "translation_verification");
        }
        finally {
            // Cleanup temp directory
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
    it("concurrent state file validator detects cross-contamination", () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-readiness-contamination-"));
        const stateDir = path.join(tempDir, "state", "workflows");
        fs.mkdirSync(stateDir, { recursive: true });
        try {
            // Create a deliberately contaminated state file
            // cv-001 should have issue_number 160 but we write 161 (wrong issue)
            const contaminatedState = {
                workflow_id: "cv-2026-03-09-001",
                workflow_type: "content_verification",
                status: "verifying",
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
                issue_number: 161, // WRONG -- should be 160
                attempt_log: [],
                qa_results: [],
                models_used: [],
            };
            fs.writeFileSync(path.join(stateDir, "cv-2026-03-09-001.json"), JSON.stringify(contaminatedState, null, 2), "utf-8");
            // Validate -- should detect contamination
            const result = validateConcurrentStateFiles(stateDir, [
                {
                    workflow_id: "cv-2026-03-09-001",
                    issue_number: 160, // Expected 160
                    workflow_type: "content_verification",
                },
            ]);
            assert.equal(result.has_cross_contamination, true, "Should detect cross-contamination");
            assert.ok(result.contamination_details[0].includes("issue_number is 161, expected 160"), "Should explain the contamination");
        }
        finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
