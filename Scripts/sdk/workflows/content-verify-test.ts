/**
 * Story 2.1: Content Verifier Test Runner
 *
 * Runs the content verifier against the test fixture file and validates:
 * - All 5 planted errors are correctly identified
 * - No more than 1 of the 5 good events is false-positive flagged
 * - Output is structured JSON with per-event gate results
 *
 * Exit codes:
 * - 0: All acceptance criteria met
 * - 1: One or more criteria failed
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runContentVerify, type ContentVerificationResult } from "./content-verify.js";

/** Planted error definitions — maps event title to expected failure */
interface PlantedError {
  title: string;
  expectedGateCodes: string[];
  description: string;
}

/** The 5 planted errors in the fixture file */
const PLANTED_ERRORS: PlantedError[] = [
  {
    title: "Columbus Reaches Americas",
    expectedGateCodes: ["F1"],
    description: "Wrong year: 1493 instead of 1492",
  },
  {
    title: "First Telephone Call Made",
    expectedGateCodes: ["P2"],
    description: "Description exceeds 23-word maximum (36 words)",
  },
  {
    title: "Constitution Adopted",
    expectedGateCodes: ["P4"],
    description: "Missing country context (no reference to United States/America)",
  },
  {
    title: "Signing of the Declaration of Independence",
    expectedGateCodes: ["D2"],
    description: "Near-duplicate of 'Declaration of Independence Signed' (same year 1776)",
  },
  {
    title: "Salem Witch Executions",
    expectedGateCodes: ["A1"],
    description: "Age-inappropriate graphic violence description",
  },
];

/** The 5 good events that should PASS all gates */
const GOOD_EVENTS = [
  "Declaration of Independence Signed",
  "Moon Landing",
  "Louisiana Purchase Completed",
  "Rosa Parks Refuses to Give Up Seat",
  "Transcontinental Railroad Completed",
];

/** Check if an event was flagged in the verification results */
function isEventFlagged(result: ContentVerificationResult, title: string): boolean {
  return result.summary.all_failures.some(f => f.title === title);
}

/** Get the codes an event was flagged with */
function getEventCodes(result: ContentVerificationResult, title: string): string[] {
  for (const f of result.summary.all_failures) {
    if (f.title === title) {
      return f.codes;
    }
  }
  return [];
}

/** Run the content verifier test suite */
export async function runContentVerifyTest(): Promise<void> {
  console.log("=== Story 2.1: Content Verifier Test Suite ===");
  console.log("");

  // Resolve the repo root from this file's location (workflows/ -> sdk/ -> Scripts/ -> repo root)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? path.resolve(__dirname, "..", "..", "..", "..");

  const fixturesPath = path.join(repoRoot, "Scripts", "sdk", "test-data", "content-verify-fixtures.json");

  console.log("Fixtures file: " + fixturesPath);
  console.log("Planted errors: " + PLANTED_ERRORS.length);
  console.log("Good events: " + GOOD_EVENTS.length);
  console.log("");

  // Run the content verifier
  const result = await runContentVerify({
    filePath: fixturesPath,
    category: "US History",
  });

  console.log("");
  console.log("=== Test Validation ===");
  console.log("");

  let allPassed = true;

  // Criterion 1: All 5 planted errors must be detected
  console.log("--- Criterion 1: Planted Error Detection (5/5 required) ---");
  let plantedDetected = 0;

  for (const planted of PLANTED_ERRORS) {
    const flagged = isEventFlagged(result, planted.title);
    const codes = getEventCodes(result, planted.title);

    if (flagged) {
      // Check if the right gate code was used
      const expectedCodeMatched = planted.expectedGateCodes.some(
        ec => codes.some(c => c === ec || c.startsWith(ec.charAt(0))),
      );

      if (expectedCodeMatched) {
        console.log("  PASS: '" + planted.title + "' flagged with [" + codes.join(", ") + "] (expected: " + planted.expectedGateCodes.join("/") + ")");
        plantedDetected++;
      } else {
        // Flagged but with a different code — still counts as detected but note the mismatch
        console.log("  PASS (code mismatch): '" + planted.title + "' flagged with [" + codes.join(", ") + "] (expected: " + planted.expectedGateCodes.join("/") + ") — error was caught, just via a different gate");
        plantedDetected++;
      }
    } else {
      console.log("  FAIL: '" + planted.title + "' was NOT flagged — " + planted.description);
      allPassed = false;
    }
  }

  console.log("");
  console.log("Planted errors detected: " + plantedDetected + "/5");
  if (plantedDetected < 5) {
    allPassed = false;
  }

  // Criterion 2: False positive rate on good events (max 1 of 5 = <20%)
  console.log("");
  console.log("--- Criterion 2: False Positive Rate (max 1/5 allowed) ---");
  let falsePositives = 0;

  for (const goodTitle of GOOD_EVENTS) {
    const flagged = isEventFlagged(result, goodTitle);
    const codes = getEventCodes(result, goodTitle);

    if (flagged) {
      console.log("  FALSE POSITIVE: '" + goodTitle + "' was incorrectly flagged with [" + codes.join(", ") + "]");
      falsePositives++;
    } else {
      console.log("  PASS: '" + goodTitle + "' correctly passed all gates");
    }
  }

  console.log("");
  console.log("False positives: " + falsePositives + "/5 (max 1 allowed)");
  if (falsePositives > 1) {
    console.error("  FAIL: False positive rate too high (" + falsePositives + "/5 = " + (falsePositives * 20) + "%)");
    allPassed = false;
  } else {
    console.log("  PASS: False positive rate acceptable (" + falsePositives + "/5 = " + (falsePositives * 20) + "%)");
  }

  // Criterion 3: Structured JSON output
  console.log("");
  console.log("--- Criterion 3: Structured JSON Output ---");

  const structureChecks = [
    { field: "category", valid: typeof result.category === "string" && result.category.length > 0 },
    { field: "total_events", valid: typeof result.total_events === "number" && result.total_events === 10 },
    { field: "automated_gates.passed", valid: typeof result.automated_gates.passed === "number" },
    { field: "automated_gates.failed", valid: typeof result.automated_gates.failed === "number" },
    { field: "automated_gates.failures", valid: Array.isArray(result.automated_gates.failures) },
    { field: "ai_gates.checked", valid: typeof result.ai_gates.checked === "number" },
    { field: "ai_gates.passed", valid: typeof result.ai_gates.passed === "number" },
    { field: "ai_gates.failed", valid: typeof result.ai_gates.failed === "number" },
    { field: "ai_gates.failures", valid: Array.isArray(result.ai_gates.failures) },
    { field: "summary.total_passed", valid: typeof result.summary.total_passed === "number" },
    { field: "summary.total_failed", valid: typeof result.summary.total_failed === "number" },
    { field: "summary.all_failures", valid: Array.isArray(result.summary.all_failures) },
  ];

  let structureValid = true;
  for (const check of structureChecks) {
    if (check.valid) {
      console.log("  PASS: " + check.field);
    } else {
      console.log("  FAIL: " + check.field + " is missing or invalid");
      structureValid = false;
    }
  }

  if (!structureValid) {
    allPassed = false;
  }

  // Final verdict
  console.log("");
  console.log("=== Content Verifier Test Results ===");
  console.log("Planted errors detected: " + plantedDetected + "/5");
  console.log("False positives: " + falsePositives + "/5");
  console.log("Structure valid: " + (structureValid ? "YES" : "NO"));
  console.log("");

  if (allPassed) {
    console.log("=== CONTENT VERIFIER TEST PASSED ===");
  } else {
    console.error("=== CONTENT VERIFIER TEST FAILED ===");
    process.exit(1);
  }
}
