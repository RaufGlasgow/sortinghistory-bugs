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

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../config.js";
import { createWorkflowState, findWorkflowByIssue } from "../lib/state.js";

interface ResumeTestResult {
  id: string;
  description: string;
  passed: boolean;
  error?: string;
}

/** Run the resume-by-issue test suite */
export async function runResumeByIssueTest(): Promise<void> {
  console.log("=== Story 4.3: Resume-by-Issue Lookup Test Suite ===");
  console.log("Tests: 4");
  console.log("Cost: $0.00 (pure logic test)");
  console.log("");

  // Save original state dir and use a temp directory for isolation
  const originalStateDir = PATHS.STATE_DIR;
  const tempDir = path.join("state", "test-resume-" + Date.now());

  const results: ResumeTestResult[] = [];

  try {
    // Override state dir to temp directory for isolation
    (PATHS as { STATE_DIR: string }).STATE_DIR = tempDir;

    // Ensure temp dir exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // --- resume-1: Create state with issue_number=42, find it ---
    console.log("--- resume-1: Find existing state by issue number ---");
    try {
      const state42 = await createWorkflowState("content_verification", "dispatch", "US History", 42);
      const found = await findWorkflowByIssue(42);

      if (!found) {
        results.push({ id: "resume-1", description: "Find existing state by issue number", passed: false, error: "findWorkflowByIssue(42) returned null, expected match" });
        console.log("[resume-1] FAIL: returned null");
      } else if (found.workflow_id !== state42.workflow_id) {
        results.push({ id: "resume-1", description: "Find existing state by issue number", passed: false, error: `workflow_id mismatch: got ${found.workflow_id}, expected ${state42.workflow_id}` });
        console.log("[resume-1] FAIL: wrong workflow_id");
      } else if (found.issue_number !== 42) {
        results.push({ id: "resume-1", description: "Find existing state by issue number", passed: false, error: `issue_number: got ${found.issue_number}, expected 42` });
        console.log("[resume-1] FAIL: wrong issue_number");
      } else {
        results.push({ id: "resume-1", description: "Find existing state by issue number", passed: true });
        console.log("[resume-1] PASS: found " + found.workflow_id + " with issue_number=42");
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ id: "resume-1", description: "Find existing state by issue number", passed: false, error: "threw: " + errMsg });
      console.log("[resume-1] FAIL: " + errMsg);
    }
    console.log("");

    // --- resume-2: Find issue_number=999 (no match) -> returns null ---
    console.log("--- resume-2: No match returns null ---");
    try {
      const notFound = await findWorkflowByIssue(999);
      if (notFound === null) {
        results.push({ id: "resume-2", description: "No match returns null", passed: true });
        console.log("[resume-2] PASS: returned null for non-existent issue");
      } else {
        results.push({ id: "resume-2", description: "No match returns null", passed: false, error: `Expected null, got workflow ${notFound.workflow_id}` });
        console.log("[resume-2] FAIL: returned " + notFound.workflow_id);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ id: "resume-2", description: "No match returns null", passed: false, error: "threw: " + errMsg });
      console.log("[resume-2] FAIL: " + errMsg);
    }
    console.log("");

    // --- resume-3: Create 2 states for issue_number=42, find -> returns most recent ---
    console.log("--- resume-3: Multiple matches returns most recent ---");
    try {
      // Small delay to ensure created_at timestamps differ
      await new Promise(resolve => setTimeout(resolve, 50));
      const state42b = await createWorkflowState("translation_verification", "dispatch", "Ancient Civilizations", 42);

      const found = await findWorkflowByIssue(42);
      if (!found) {
        results.push({ id: "resume-3", description: "Multiple matches returns most recent", passed: false, error: "returned null, expected most recent state" });
        console.log("[resume-3] FAIL: returned null");
      } else if (found.workflow_id !== state42b.workflow_id) {
        results.push({ id: "resume-3", description: "Multiple matches returns most recent", passed: false, error: `Got ${found.workflow_id}, expected most recent ${state42b.workflow_id}` });
        console.log("[resume-3] FAIL: returned " + found.workflow_id + " (expected most recent: " + state42b.workflow_id + ")");
      } else {
        results.push({ id: "resume-3", description: "Multiple matches returns most recent", passed: true });
        console.log("[resume-3] PASS: returned most recent " + found.workflow_id);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ id: "resume-3", description: "Multiple matches returns most recent", passed: false, error: "threw: " + errMsg });
      console.log("[resume-3] FAIL: " + errMsg);
    }
    console.log("");

    // --- resume-4: Create state with issue_number=null, find 42 -> only matches non-null ---
    // This verifies that null issue_number states don't match any lookup
    console.log("--- resume-4: Null issue_number does not match ---");
    try {
      // Clean temp dir to start fresh for this test
      for (const file of fs.readdirSync(tempDir)) {
        fs.unlinkSync(path.join(tempDir, file));
      }

      // Create a state with null issue_number
      await createWorkflowState("bug_triage", "manual");

      const found = await findWorkflowByIssue(42);
      if (found === null) {
        results.push({ id: "resume-4", description: "Null issue_number does not match", passed: true });
        console.log("[resume-4] PASS: null issue_number correctly excluded from match");
      } else {
        results.push({ id: "resume-4", description: "Null issue_number does not match", passed: false, error: `Expected null, got workflow ${found.workflow_id} with issue_number=${found.issue_number}` });
        console.log("[resume-4] FAIL: returned " + found.workflow_id);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ id: "resume-4", description: "Null issue_number does not match", passed: false, error: "threw: " + errMsg });
      console.log("[resume-4] FAIL: " + errMsg);
    }
    console.log("");

  } finally {
    // Restore original state dir
    (PATHS as { STATE_DIR: string }).STATE_DIR = originalStateDir;

    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      for (const file of fs.readdirSync(tempDir)) {
        fs.unlinkSync(path.join(tempDir, file));
      }
      fs.rmdirSync(tempDir);
    }
  }

  // --- Summary ---
  console.log("=== Resume-by-Issue Test Suite Summary ===");
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.length - passCount;

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const detail = r.error ? " (" + r.error + ")" : "";
    console.log("  " + r.id + ": " + status + detail);
  }

  console.log("");
  console.log("Results: " + passCount + "/" + results.length + " passed, " + failCount + " failed");

  if (failCount > 0) {
    console.error("");
    console.error("=== RESUME-BY-ISSUE TEST SUITE FAILED ===");
    process.exit(1);
  }

  console.log("");
  console.log("=== RESUME-BY-ISSUE TEST SUITE PASSED ===");
}
