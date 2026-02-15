/**
 * Story 2.2: Content Fixer Test Runner
 *
 * Tests the content fixer subagent by:
 *   1. Copying fixture data to a temp directory (never modifies real game data)
 *   2. Creating 3 test findings (from Story 2.1's planted errors)
 *   3. Running the fixer on the temp copy
 *   4. Running Story 2.1's verifier on the fixed output to confirm zero new failures
 *   5. Validating version increments and corrections log entries
 *
 * Exit codes:
 * - 0: All acceptance criteria met
 * - 1: One or more criteria failed
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runContentFix, type ContentFinding, type ContentFixOutput } from "./content-fix.js";
import { runContentVerify, type ContentVerificationResult } from "./content-verify.js";

// ------------------------------------------------------------------
// Test Fixtures: 3 findings matching Story 2.1's planted errors
// ------------------------------------------------------------------

/** The 3 findings the fixer must resolve. These correspond to planted errors in
 *  content-verify-fixtures.json that the fixer can deterministically fix. */
function buildTestFindings(fixturesPath: string): ContentFinding[] {
  return [
    {
      title: "Columbus Reaches Americas",
      codes: ["F1"],
      details: "Wrong year: 1493 instead of 1492. Wikipedia confirms Columbus arrived October 12, 1492.",
      sourceFile: fixturesPath,
      suggestedFix: "Change year from 1493 to 1492",
    },
    {
      title: "First Telephone Call Made",
      codes: ["P2"],
      details: "Description has 36 words (maximum 23). Rewrite to be concise while keeping historical accuracy.",
      sourceFile: fixturesPath,
      suggestedFix: "Shorten description to 10-23 words while preserving key facts about Bell's telephone call",
    },
    {
      title: "Salem Witch Executions",
      codes: ["A1"],
      details: "Age-inappropriate graphic violence description with disturbing execution details (strangling, convulsing).",
      sourceFile: fixturesPath,
      suggestedFix: "Rewrite to focus on historical significance of the Salem witch trials without graphic violence",
    },
  ];
}

/** Create a temp directory with copies of the fixture data and a fresh corrections log */
function setupTempEnvironment(): {
  tempDir: string;
  fixturesPath: string;
  correctionsLogPath: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "content-fix-test-"));
  console.log("[test] Temp directory: " + tempDir);

  // Resolve the source fixtures path
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  const sourceFixtures = path.join(repoRoot, "Scripts", "sdk", "test-data", "content-verify-fixtures.json");

  // Copy fixtures to temp dir, maintaining the same relative path structure
  // so the fixer can read/write them
  const tempDataDir = path.join(tempDir, "Data", "Events");
  fs.mkdirSync(tempDataDir, { recursive: true });

  const fixturesPath = path.join(tempDataDir, "content-verify-fixtures.json");
  fs.copyFileSync(sourceFixtures, fixturesPath);
  console.log("[test] Copied fixtures to " + fixturesPath);

  // Create a fresh corrections log in temp dir
  const tempCorrectionsDir = path.join(tempDir, "Data", "corrections");
  fs.mkdirSync(tempCorrectionsDir, { recursive: true });

  const correctionsLogPath = path.join(tempCorrectionsDir, "corrections-log.json");
  const emptyLog = {
    schema_version: "1.1",
    description: "Test corrections log for content-fix-test",
    corrections: [],
    category_moves: [],
    translation_errors: [],
    backfill_events: [],
  };
  fs.writeFileSync(correctionsLogPath, JSON.stringify(emptyLog, null, 2), "utf-8");
  console.log("[test] Created corrections log at " + correctionsLogPath);

  // Copy the prompts directory so the fixer can load its system prompt
  const sourcePromptsDir = path.join(repoRoot, "Scripts", "sdk", "prompts");
  const tempPromptsDir = path.join(tempDir, "Scripts", "sdk", "prompts");
  fs.mkdirSync(tempPromptsDir, { recursive: true });

  for (const file of fs.readdirSync(sourcePromptsDir)) {
    fs.copyFileSync(path.join(sourcePromptsDir, file), path.join(tempPromptsDir, file));
  }
  console.log("[test] Copied prompts directory");

  return { tempDir, fixturesPath, correctionsLogPath };
}

/** Clean up temp directory */
function cleanupTemp(tempDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log("[test] Cleaned up temp directory");
  } catch (err: unknown) {
    console.warn("[test] WARNING: Could not clean up temp dir: " + (err instanceof Error ? err.message : String(err)));
  }
}

// ------------------------------------------------------------------
// Test Runner
// ------------------------------------------------------------------

export async function runContentFixTest(): Promise<void> {
  console.log("=== Story 2.2: Content Fixer Test Suite ===");
  console.log("");

  // Step 1: Set up temp environment
  console.log("--- Step 1: Setup Temp Environment ---");
  const { tempDir, fixturesPath, correctionsLogPath } = setupTempEnvironment();
  console.log("");

  let allPassed = true;

  try {
    // Step 2: Run the fixer on 3 findings
    console.log("--- Step 2: Run Content Fixer ---");
    const findings = buildTestFindings(fixturesPath);
    console.log("Test findings: " + findings.length);
    for (const f of findings) {
      console.log("  [" + f.codes.join(", ") + "] " + f.title);
    }
    console.log("");

    const fixOutput: ContentFixOutput = await runContentFix({
      findings,
      correctionsLogPath,
      repoRoot: tempDir,
    });

    console.log("");

    // Step 3: Validate fix results
    console.log("--- Step 3: Validate Fix Results ---");
    console.log("");

    // AC1: All 3 fixes resolve the original gate failure
    console.log("--- AC1: Fix Resolution (3/3 required) ---");
    let fixesResolved = 0;

    for (const r of fixOutput.results) {
      if (r.fixed) {
        console.log("  PASS: '" + r.title + "' [" + r.codes.join(", ") + "] — " + r.action);
        fixesResolved++;
      } else {
        console.log("  FAIL: '" + r.title + "' [" + r.codes.join(", ") + "] — " + r.action);
        allPassed = false;
      }
    }

    console.log("");
    console.log("Fixes resolved: " + fixesResolved + "/3");
    if (fixesResolved < 3) {
      allPassed = false;
    }
    console.log("");

    // AC2: Version Increment — check each fixed event has version >= 2
    console.log("--- AC2: Version Increment (FR14) ---");
    try {
      const raw = fs.readFileSync(fixturesPath, "utf-8");
      const data = JSON.parse(raw) as {
        events: Array<{ title: string; version?: number }>;
      };

      // Check Columbus (should have version >= 2 after year fix)
      const columbus = data.events.find(e => e.title === "Columbus Reaches Americas");
      if (columbus) {
        const v = columbus.version ?? 0;
        if (v >= 2) {
          console.log("  PASS: 'Columbus Reaches Americas' version=" + v + " (incremented)");
        } else {
          console.log("  FAIL: 'Columbus Reaches Americas' version=" + v + " (expected >= 2)");
          allPassed = false;
        }
      } else {
        console.log("  WARN: 'Columbus Reaches Americas' not found (may have been renamed)");
      }

      // Check Telephone (should have version >= 2 after description rewrite)
      const telephone = data.events.find(e => e.title === "First Telephone Call Made");
      if (telephone) {
        const v = telephone.version ?? 0;
        if (v >= 2) {
          console.log("  PASS: 'First Telephone Call Made' version=" + v + " (incremented)");
        } else {
          console.log("  FAIL: 'First Telephone Call Made' version=" + v + " (expected >= 2)");
          allPassed = false;
        }
      } else {
        console.log("  WARN: 'First Telephone Call Made' not found (may have been renamed)");
      }

      // Check Salem (should have version >= 2 after description rewrite)
      const salem = data.events.find(e => e.title === "Salem Witch Executions");
      if (salem) {
        const v = salem.version ?? 0;
        if (v >= 2) {
          console.log("  PASS: 'Salem Witch Executions' version=" + v + " (incremented)");
        } else {
          console.log("  FAIL: 'Salem Witch Executions' version=" + v + " (expected >= 2)");
          allPassed = false;
        }
      } else {
        console.log("  WARN: 'Salem Witch Executions' not found (may have been renamed)");
      }
    } catch (err: unknown) {
      console.log("  FAIL: Could not read fixtures file: " + (err instanceof Error ? err.message : String(err)));
      allPassed = false;
    }
    console.log("");

    // AC3: Corrections Log — check that entries were added
    console.log("--- AC3: Corrections Log (FR41) ---");
    try {
      const logRaw = fs.readFileSync(correctionsLogPath, "utf-8");
      const log = JSON.parse(logRaw) as {
        corrections: Array<{
          id: string;
          status: string;
          event_title: string;
          correction_type: string;
        }>;
      };

      const corrEntries = log.corrections;
      console.log("  Correction entries found: " + corrEntries.length);

      if (corrEntries.length >= 3) {
        console.log("  PASS: At least 3 correction entries added");

        // Verify each entry has required fields
        let entriesValid = true;
        for (const entry of corrEntries) {
          if (!entry.id || !entry.status || !entry.event_title || !entry.correction_type) {
            console.log("  FAIL: Entry missing required fields: " + JSON.stringify(entry));
            entriesValid = false;
          }
        }

        if (entriesValid) {
          console.log("  PASS: All entries have required fields (id, status, event_title, correction_type)");
        } else {
          allPassed = false;
        }
      } else {
        console.log("  FAIL: Expected at least 3 correction entries, found " + corrEntries.length);
        allPassed = false;
      }
    } catch (err: unknown) {
      console.log("  FAIL: Could not read corrections log: " + (err instanceof Error ? err.message : String(err)));
      allPassed = false;
    }
    console.log("");

    // AC5: JSON Validation — verify all output files are valid JSON
    console.log("--- AC5: JSON Validation (FR40) ---");
    try {
      const fixRaw = fs.readFileSync(fixturesPath, "utf-8");
      JSON.parse(fixRaw);
      console.log("  PASS: Fixtures file is valid JSON");
    } catch {
      console.log("  FAIL: Fixtures file is invalid JSON");
      allPassed = false;
    }

    try {
      const logRaw = fs.readFileSync(correctionsLogPath, "utf-8");
      JSON.parse(logRaw);
      console.log("  PASS: Corrections log is valid JSON");
    } catch {
      console.log("  FAIL: Corrections log is invalid JSON");
      allPassed = false;
    }
    console.log("");

    // Step 4: Re-verify with Story 2.1's verifier to confirm zero NEW failures
    // on the 3 fixed events (the other planted errors like D2, P4 are not fixed
    // in this test — we only check the 3 we attempted to fix)
    console.log("--- Step 4: Re-Verification (Story 2.1 Verifier) ---");
    console.log("Running content verifier on fixed output...");
    console.log("");

    const reVerifyResult: ContentVerificationResult = await runContentVerify({
      filePath: fixturesPath,
      category: "US History",
    });

    console.log("");
    console.log("--- Re-Verification Results ---");

    // Check that the 3 fixed events are no longer flagged
    const fixedTitles = ["Columbus Reaches Americas", "First Telephone Call Made", "Salem Witch Executions"];
    let refixFailures = 0;

    for (const title of fixedTitles) {
      const stillFlagged = reVerifyResult.summary.all_failures.some(f => f.title === title);
      if (stillFlagged) {
        const codes = reVerifyResult.summary.all_failures
          .filter(f => f.title === title)
          .flatMap(f => f.codes);
        console.log("  FAIL: '" + title + "' still flagged after fix with [" + codes.join(", ") + "]");
        refixFailures++;
      } else {
        console.log("  PASS: '" + title + "' no longer flagged (fix resolved the issue)");
      }
    }

    console.log("");
    console.log("Re-fix failures: " + refixFailures + "/3 (0 expected)");
    if (refixFailures > 0) {
      allPassed = false;
    }

    // Note: Other planted errors (D2 near-duplicate, P4 missing context) are
    // expected to still be flagged since we only fixed 3 of the 5.
    const unfixedErrors = reVerifyResult.summary.all_failures.filter(
      f => !fixedTitles.includes(f.title),
    );
    if (unfixedErrors.length > 0) {
      console.log("");
      console.log("Expected remaining flags (not fixed in this test):");
      for (const f of unfixedErrors) {
        console.log("  [" + f.codes.join(", ") + "] " + f.title + " — " + f.details);
      }
    }

  } finally {
    // Clean up temp directory
    console.log("");
    cleanupTemp(tempDir);
  }

  // Final verdict
  console.log("");
  console.log("=== Content Fixer Test Results ===");

  if (allPassed) {
    console.log("=== CONTENT FIXER TEST PASSED ===");
  } else {
    console.error("=== CONTENT FIXER TEST FAILED ===");
    process.exit(1);
  }
}
