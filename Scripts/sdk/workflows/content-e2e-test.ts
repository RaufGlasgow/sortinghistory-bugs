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

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { PATHS, LIMITS } from "../config.js";
import { loadWorkflowState, type WorkflowState } from "../lib/state.js";
import {
  runContentE2E,
  type ContentE2EInput,
  type ContentE2EResult,
  type ApprovalResponse,
} from "./content-e2e.js";

// ------------------------------------------------------------------
// Test Environment Setup
// ------------------------------------------------------------------

interface TestEnvironment {
  tempDir: string;
  fixturesPath: string;
  correctionsLogPath: string;
  stateDir: string;
  sessionRegistry: string;
  originalStateDir: string;
  originalSessionRegistry: string;
}

/** Resolve repo root using import.meta.url (not process.cwd()) */
function resolveRepoRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return (
    process.env.GITHUB_WORKSPACE ??
    process.env.SDK_REPO_ROOT ??
    path.resolve(__dirname, "..", "..", "..", "..")
  );
}

/**
 * Create an isolated temp environment for a test.
 *
 * Overrides PATHS.STATE_DIR and PATHS.SESSION_REGISTRY to use temp directories
 * so tests do not pollute real state.
 */
function setupTestEnvironment(testName: string): TestEnvironment {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "content-e2e-" + testName + "-"),
  );
  console.log("[test:" + testName + "] Temp directory: " + tempDir);

  const repoRoot = resolveRepoRoot();

  // Copy fixture data
  const sourceFixtures = path.join(
    repoRoot,
    "Scripts",
    "sdk",
    "test-data",
    "content-verify-fixtures.json",
  );
  const tempDataDir = path.join(tempDir, "Data", "Events");
  fs.mkdirSync(tempDataDir, { recursive: true });

  const fixturesPath = path.join(tempDataDir, "content-verify-fixtures.json");
  fs.copyFileSync(sourceFixtures, fixturesPath);

  // Create corrections log
  const tempCorrectionsDir = path.join(tempDir, "Data", "corrections");
  fs.mkdirSync(tempCorrectionsDir, { recursive: true });

  const correctionsLogPath = path.join(
    tempCorrectionsDir,
    "corrections-log.json",
  );
  const emptyLog = {
    schema_version: "1.1",
    description: "Test corrections log for content-e2e-test",
    corrections: [],
    category_moves: [],
    translation_errors: [],
    backfill_events: [],
  };
  fs.writeFileSync(
    correctionsLogPath,
    JSON.stringify(emptyLog, null, 2),
    "utf-8",
  );

  // Copy prompts directory
  const sourcePromptsDir = path.join(
    repoRoot,
    "Scripts",
    "sdk",
    "prompts",
  );
  const tempPromptsDir = path.join(tempDir, "Scripts", "sdk", "prompts");
  fs.mkdirSync(tempPromptsDir, { recursive: true });

  for (const file of fs.readdirSync(sourcePromptsDir)) {
    fs.copyFileSync(
      path.join(sourcePromptsDir, file),
      path.join(tempPromptsDir, file),
    );
  }

  // Create isolated state directory and session registry
  const stateDir = path.join(tempDir, "state", "workflows");
  fs.mkdirSync(stateDir, { recursive: true });

  const sessionRegistry = path.join(tempDir, "state", "sessions.json");

  // Save original PATHS values and override
  const originalStateDir = PATHS.STATE_DIR;
  const originalSessionRegistry = PATHS.SESSION_REGISTRY;

  (PATHS as { STATE_DIR: string }).STATE_DIR = stateDir;
  (PATHS as { SESSION_REGISTRY: string }).SESSION_REGISTRY = sessionRegistry;

  return {
    tempDir,
    fixturesPath,
    correctionsLogPath,
    stateDir,
    sessionRegistry,
    originalStateDir,
    originalSessionRegistry,
  };
}

/** Restore PATHS and clean up temp directory */
function teardownTestEnvironment(env: TestEnvironment): void {
  // Restore PATHS
  (PATHS as { STATE_DIR: string }).STATE_DIR = env.originalStateDir;
  (PATHS as { SESSION_REGISTRY: string }).SESSION_REGISTRY =
    env.originalSessionRegistry;

  // Clean up
  try {
    fs.rmSync(env.tempDir, { recursive: true, force: true });
    console.log("[test] Cleaned up: " + env.tempDir);
  } catch (err: unknown) {
    console.warn(
      "[test] WARNING: Could not clean up: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Collect state transitions by reading the state file after the E2E run */
async function getStateHistory(
  workflowId: string,
): Promise<WorkflowState | null> {
  return loadWorkflowState(workflowId);
}

// ------------------------------------------------------------------
// Test 1: Happy Path
// ------------------------------------------------------------------

async function testHappyPath(): Promise<boolean> {
  console.log("=== E2E Test 1: Happy Path ===");
  console.log("");

  const env = setupTestEnvironment("happy");
  let passed = true;

  try {
    // Run the full E2E with simulated approval (approve all findings)
    const approval: ApprovalResponse = {
      action: "approve",
    };

    const result: ContentE2EResult = await runContentE2E(
      {
        filePath: env.fixturesPath,
        category: "US History",
        correctionsLogPath: env.correctionsLogPath,
        repoRoot: env.tempDir,
        dryRun: true, // Do not create real PR
      },
      approval,
    );

    console.log("");
    console.log("--- Happy Path Validation ---");
    console.log("");

    // Check 1: Status should be complete
    console.log("Check 1: Final status");
    if (result.status === "complete") {
      console.log("  PASS: status = complete");
    } else {
      console.log("  FAIL: status = " + result.status + " (expected complete)");
      passed = false;
    }

    // Check 2: Findings were detected
    console.log("Check 2: Findings detected");
    if (result.totalFindings > 0) {
      console.log("  PASS: " + result.totalFindings + " findings detected");
    } else {
      console.log("  FAIL: no findings detected (expected > 0)");
      passed = false;
    }

    // Check 3: Findings were approved
    console.log("Check 3: Findings approved");
    if (result.approvedFindings > 0) {
      console.log("  PASS: " + result.approvedFindings + " findings approved");
    } else {
      console.log("  FAIL: no findings approved");
      passed = false;
    }

    // Check 4: At least 1 fix attempt
    console.log("Check 4: Fix attempts");
    if (result.fixAttempts >= 1) {
      console.log("  PASS: " + result.fixAttempts + " fix attempt(s)");
    } else {
      console.log("  FAIL: " + result.fixAttempts + " fix attempts (expected >= 1)");
      passed = false;
    }

    // Check 5: No error
    console.log("Check 5: No error");
    if (!result.error) {
      console.log("  PASS: no error");
    } else {
      console.log("  FAIL: error = " + result.error);
      passed = false;
    }

    // Check 6: State file reflects transitions
    console.log("Check 6: State file integrity");
    const finalState = await getStateHistory(result.workflowId);
    if (finalState) {
      console.log("  Workflow ID: " + finalState.workflow_id);
      console.log("  Final status: " + finalState.status);
      console.log("  Fix attempts: " + finalState.fix_attempts);
      console.log("  Findings count: " + finalState.findings.length);
      console.log("  Approved count: " + finalState.approved_findings.length);

      if (finalState.status === "complete") {
        console.log("  PASS: state file shows complete");
      } else {
        console.log(
          "  FAIL: state file shows " +
            finalState.status +
            " (expected complete)",
        );
        passed = false;
      }

      if (finalState.findings.length > 0) {
        console.log("  PASS: findings persisted in state");
      } else {
        console.log("  FAIL: no findings in state file");
        passed = false;
      }

      if (finalState.approved_findings.length > 0) {
        console.log("  PASS: approved findings persisted in state");
      } else {
        console.log("  FAIL: no approved findings in state file");
        passed = false;
      }
    } else {
      console.log("  FAIL: state file not found for " + result.workflowId);
      passed = false;
    }

    // Check 7: Corrections log was updated
    console.log("Check 7: Corrections log");
    try {
      const logRaw = fs.readFileSync(env.correctionsLogPath, "utf-8");
      const log = JSON.parse(logRaw) as {
        corrections: Array<{ id: string }>;
      };
      if (log.corrections.length > 0) {
        console.log(
          "  PASS: " + log.corrections.length + " correction(s) in log",
        );
      } else {
        console.log("  FAIL: corrections log is empty");
        passed = false;
      }
    } catch (err: unknown) {
      console.log(
        "  FAIL: could not read corrections log: " +
          (err instanceof Error ? err.message : String(err)),
      );
      passed = false;
    }

    // Check 8: Dry-run means no actual PR number
    console.log("Check 8: Dry-run PR (no real PR created)");
    if (result.prNumber === null) {
      console.log("  PASS: prNumber is null (dry-run)");
    } else {
      console.log(
        "  FAIL: prNumber = " + result.prNumber + " (expected null for dry-run)",
      );
      passed = false;
    }
  } finally {
    teardownTestEnvironment(env);
  }

  console.log("");
  if (passed) {
    console.log("=== E2E Test 1: Happy Path PASSED ===");
  } else {
    console.log("=== E2E Test 1: Happy Path FAILED ===");
  }

  return passed;
}

// ------------------------------------------------------------------
// Test 2: Escalation (fix always fails re-verification)
// ------------------------------------------------------------------

/**
 * For the escalation test, we create a fixture with an impossible finding:
 * an event with a "planted error" that the fixer cannot actually resolve
 * because we mark it as having a gate code that doesn't match any fixable
 * pattern. The verifier will always re-flag it.
 *
 * Strategy: Create a fixture with ONLY an event that has a subtle factual
 * error that Haiku will consistently flag (wrong year). Then make the fixer
 * receive a finding that tells it to fix a different problem than what
 * Haiku will flag -- causing re-verification to always fail.
 */
async function testEscalation(): Promise<boolean> {
  console.log("");
  console.log("=== E2E Test 2: Escalation (always-failing fix) ===");
  console.log("");

  const env = setupTestEnvironment("escalation");
  let passed = true;

  try {
    // Create a custom fixture that will trigger escalation.
    // The trick: we write a file where the fixer's fix will NOT resolve
    // the issue that the verifier will find.
    //
    // We use the Columbus event with wrong year (1493 instead of 1492).
    // But we also ensure the description violates P2 (too long) in a way
    // that the fixer will try to fix P2 but won't fix the year -- so
    // re-verification will still flag F1.
    //
    // Actually, simpler approach: create a fixture where the event fails
    // a gate (P2 - description too long) and then sabotage the fixer by
    // giving it a "fix" instruction that won't actually fix P2 -- the
    // fixer will try but the description will remain too long because
    // the "suggested fix" is misleading.
    //
    // Simplest approach: Use the standard fixture but with ALL its errors.
    // The fixer will fix SOME but not all. Specifically, the D2 near-duplicate
    // requires removing an event, and the P4 (missing country context) requires
    // a more complex rewrite. Between re-verification runs, the unfixed errors
    // will persist, causing re-verification to keep failing.
    //
    // For a reliable escalation test, create a minimal fixture with ONE event
    // that has a persistent unfixable characteristic: a word count that is
    // exactly at the limit, so any "fix" attempt will still be flagged.

    // Create a minimal escalation-inducing fixture
    const escalationFixture = {
      category: "US History",
      events: [
        {
          title: "Escalation Test Event",
          version: 1,
          description:
            "This American historical event description is intentionally written to be extremely long with many extra unnecessary redundant superfluous words well beyond the maximum limit.",
          year: 1776,
          month: 7,
          day: 4,
          category: "US History",
          difficulty: 1,
          imageURL: null,
          _planted_error: "P2: Intentionally too long at 26 words",
        },
      ],
    };

    // Write the escalation fixture
    fs.writeFileSync(
      env.fixturesPath,
      JSON.stringify(escalationFixture, null, 2),
      "utf-8",
    );

    // For escalation, we use a sabotaged system prompt approach:
    // Override the fixer prompt to instruct it to NOT actually fix the issue.
    // The simplest way is to give a finding with a suggestedFix that is wrong.
    //
    // Actually, the cleanest approach for a deterministic escalation test:
    // We use the normal E2E flow but with a hook that corrupts the fixer output.
    //
    // Simplest reliable approach: The description has 26 words (over P2 max of 23).
    // The fixer will try to shorten it, but if we use a description that the fixer
    // *cannot* meaningfully shorten to <= 23 words while keeping all required content,
    // it will fail re-verification.
    //
    // Even simpler: We write a fixture where the fixer prompt can't find the event
    // (by using a title that doesn't exist in the file), so the fix silently "fails"
    // but reports success (the fixer can't find what to fix).
    //
    // Let's use a fixture with mismatched information: the finding says to fix
    // event "Nonexistent Event" but the file only contains "Escalation Test Event".
    // The fixer will report it couldn't find the event, and re-verification will
    // still flag the P2 violation.

    // But the E2E orchestrator gets findings from the VERIFIER, not from us.
    // So the verifier will find "Escalation Test Event" with P2, and the fixer
    // will try to fix it. If the fixer succeeds, the test won't trigger escalation.
    //
    // True escalation test: Create a fixture where the verifier finds an issue
    // but the fixer fundamentally cannot resolve it. One reliable way:
    // - Use a description that contains a year (P5 date spoiler)
    // - The fixer will try to remove the year but the historical context REQUIRES it
    // - Or: the fixer rewrites but accidentally introduces a new issue
    //
    // Most reliable: Override the fixer prompts in the temp dir to instruct
    // the fixer to do nothing (or do the wrong thing).

    // Sabotage the fixer's system prompt so it DOESN'T actually fix anything
    const sabotagedPrompt = [
      "You are a content fixer agent that has been DISABLED for testing.",
      "When asked to fix events, respond with a JSON summary claiming all fixes were applied,",
      "but DO NOT actually modify any files.",
      "",
      "Output the following JSON (replace placeholders with actual data from findings):",
      '{',
      '  "total_findings": <N>,',
      '  "fixed": <N>,',
      '  "failed": 0,',
      '  "results": [{"title": "<title>", "fixed": true, "codes": ["<codes>"], "action": "Applied fix"}],',
      '  "corrections_log_updated": false',
      '}',
    ].join("\n");

    const tempFixerPrompt = path.join(
      env.tempDir,
      "Scripts",
      "sdk",
      "prompts",
      "content-fixer.md",
    );
    fs.writeFileSync(tempFixerPrompt, sabotagedPrompt, "utf-8");

    // Run E2E -- fixer won't actually fix, so re-verification will keep failing
    const approval: ApprovalResponse = {
      action: "approve",
    };

    const result: ContentE2EResult = await runContentE2E(
      {
        filePath: env.fixturesPath,
        category: "US History",
        correctionsLogPath: env.correctionsLogPath,
        repoRoot: env.tempDir,
        dryRun: true,
      },
      approval,
    );

    console.log("");
    console.log("--- Escalation Validation ---");
    console.log("");

    // Check 1: Status should be escalated
    console.log("Check 1: Final status");
    if (result.status === "escalated") {
      console.log("  PASS: status = escalated");
    } else {
      console.log(
        "  FAIL: status = " + result.status + " (expected escalated)",
      );
      passed = false;
    }

    // Check 2: Fix attempts should equal MAX_FIX_ATTEMPTS
    console.log("Check 2: Fix attempts = " + LIMITS.MAX_FIX_ATTEMPTS);
    if (result.fixAttempts === LIMITS.MAX_FIX_ATTEMPTS) {
      console.log(
        "  PASS: fixAttempts = " + result.fixAttempts,
      );
    } else {
      console.log(
        "  FAIL: fixAttempts = " +
          result.fixAttempts +
          " (expected " +
          LIMITS.MAX_FIX_ATTEMPTS +
          ")",
      );
      passed = false;
    }

    // Check 3: No PR created
    console.log("Check 3: No PR created");
    if (result.prNumber === null) {
      console.log("  PASS: prNumber is null (no PR for failed fix)");
    } else {
      console.log(
        "  FAIL: prNumber = " + result.prNumber + " (expected null)",
      );
      passed = false;
    }

    // Check 4: State file shows escalated
    console.log("Check 4: State file integrity");
    const finalState = await getStateHistory(result.workflowId);
    if (finalState) {
      if (finalState.status === "escalated") {
        console.log("  PASS: state file shows escalated");
      } else {
        console.log(
          "  FAIL: state file shows " +
            finalState.status +
            " (expected escalated)",
        );
        passed = false;
      }

      if (finalState.fix_attempts === LIMITS.MAX_FIX_ATTEMPTS) {
        console.log(
          "  PASS: state file fix_attempts = " + finalState.fix_attempts,
        );
      } else {
        console.log(
          "  FAIL: state file fix_attempts = " +
            finalState.fix_attempts +
            " (expected " +
            LIMITS.MAX_FIX_ATTEMPTS +
            ")",
        );
        passed = false;
      }

      if (finalState.error) {
        console.log("  PASS: error message present: " + finalState.error);
      } else {
        console.log("  FAIL: no error message in state file");
        passed = false;
      }
    } else {
      console.log("  FAIL: state file not found for " + result.workflowId);
      passed = false;
    }

    // Check 5: Error message present in result
    console.log("Check 5: Error message in result");
    if (result.error) {
      console.log("  PASS: error = " + result.error);
    } else {
      console.log("  FAIL: no error message in result");
      passed = false;
    }
  } finally {
    teardownTestEnvironment(env);
  }

  console.log("");
  if (passed) {
    console.log("=== E2E Test 2: Escalation PASSED ===");
  } else {
    console.log("=== E2E Test 2: Escalation FAILED ===");
  }

  return passed;
}

// ------------------------------------------------------------------
// Main Test Runner
// ------------------------------------------------------------------

export async function runContentE2ETest(): Promise<void> {
  console.log("=== Story 2.3: Content E2E Test Suite ===");
  console.log("Tests: 2 (Happy Path + Escalation)");
  console.log(
    "Note: These tests spawn real AI subagents and will consume API credits.",
  );
  console.log("");

  const results: Array<{ name: string; passed: boolean }> = [];

  // Test 1: Happy Path
  const happyPassed = await testHappyPath();
  results.push({ name: "Happy Path", passed: happyPassed });
  console.log("");

  // Test 2: Escalation
  const escalationPassed = await testEscalation();
  results.push({ name: "Escalation", passed: escalationPassed });
  console.log("");

  // Summary
  console.log("=== Content E2E Test Suite Summary ===");
  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    console.log("  " + r.name + ": " + status);
  }

  console.log("");
  console.log(
    "Results: " +
      passCount +
      "/" +
      results.length +
      " passed, " +
      failCount +
      " failed",
  );

  if (failCount > 0) {
    console.error("");
    console.error("=== CONTENT E2E TEST SUITE FAILED ===");
    process.exit(1);
  }

  console.log("");
  console.log("=== CONTENT E2E TEST SUITE PASSED ===");
}
