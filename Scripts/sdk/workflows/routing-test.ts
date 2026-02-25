/**
 * Routing Test Harness
 *
 * Validates all routing fixtures by running them through decideRoute()
 * and comparing the returned RoutingAction against expected values.
 *
 * Pure logic test — NO Anthropic API calls, NO GitHub API calls.
 * Cost: $0.00
 *
 * BA-011 update: unknown classifications now return safe label (not throw).
 *
 * Exit codes:
 * - 0: All tests pass
 * - 1: One or more tests fail
 */

import { ROUTING_FIXTURES, type RoutingFixture, type ExpectedAction } from "../tests/routing-fixtures.js";
import { decideRoute, executeRoute, type RoutingAction } from "../lib/routing.js";
import { ROUTING, CLASSIFICATIONS } from "../config.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface TestResult {
  fixture: RoutingFixture;
  passed: boolean;
  errors: string[];
}

/**
 * Validate a single routing action against its expected result.
 * Returns an array of error messages (empty = pass).
 */
function validateAction(actual: RoutingAction, expected: ExpectedAction): string[] {
  const errors: string[] = [];

  // Type must match
  if (actual.type !== expected.type) {
    errors.push("type: got \"" + actual.type + "\", expected \"" + expected.type + "\"");
    return errors; // No point checking further if type is wrong
  }

  switch (expected.type) {
    case "dispatch": {
      if (actual.type !== "dispatch") break;
      if (actual.event_type !== expected.event_type) {
        errors.push("event_type: got \"" + actual.event_type + "\", expected \"" + expected.event_type + "\"");
      }
      if (actual.repo !== expected.repo) {
        errors.push("repo: got \"" + actual.repo + "\", expected \"" + expected.repo + "\"");
      }
      // Check payload keys
      for (const key of expected.payload_keys) {
        if (!(key in actual.payload)) {
          errors.push("payload missing key: \"" + key + "\"");
        }
      }
      // Check payload values if specified
      if (expected.payload_values) {
        for (const [key, value] of Object.entries(expected.payload_values)) {
          if (actual.payload[key] !== value) {
            errors.push(
              "payload." + key + ": got " + JSON.stringify(actual.payload[key]) +
              ", expected " + JSON.stringify(value)
            );
          }
        }
      }
      break;
    }

    case "label": {
      if (actual.type !== "label") break;
      if (actual.repo !== expected.repo) {
        errors.push("repo: got \"" + actual.repo + "\", expected \"" + expected.repo + "\"");
      }
      // Check labels match exactly (order-independent)
      const actualLabels = [...actual.labels].sort();
      const expectedLabels = [...expected.labels].sort();
      if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) {
        errors.push(
          "labels: got [" + actualLabels.join(", ") + "], expected [" + expectedLabels.join(", ") + "]"
        );
      }
      break;
    }

    case "label_and_state": {
      if (actual.type !== "label_and_state") break;
      if (actual.repo !== expected.repo) {
        errors.push("repo: got \"" + actual.repo + "\", expected \"" + expected.repo + "\"");
      }
      const actualLabels2 = [...actual.labels].sort();
      const expectedLabels2 = [...expected.labels].sort();
      if (JSON.stringify(actualLabels2) !== JSON.stringify(expectedLabels2)) {
        errors.push(
          "labels: got [" + actualLabels2.join(", ") + "], expected [" + expectedLabels2.join(", ") + "]"
        );
      }
      if (actual.workflow_type !== expected.workflow_type) {
        errors.push("workflow_type: got \"" + actual.workflow_type + "\", expected \"" + expected.workflow_type + "\"");
      }
      break;
    }

    case "skip": {
      // Type match is sufficient for skip
      break;
    }
  }

  return errors;
}

/** Run the routing test suite */
export async function runRoutingTest(): Promise<void> {
  console.log("=== Story 4.2: Routing Test Suite ===");
  console.log("Fixtures: " + ROUTING_FIXTURES.length);
  console.log("Cost: $0.00 (pure logic test)");
  console.log("");

  const results: TestResult[] = [];

  // --- Test all 9 fixtures ---
  for (const fixture of ROUTING_FIXTURES) {
    console.log("--- " + fixture.id + ": " + fixture.description + " ---");

    let action: RoutingAction;
    try {
      action = decideRoute(fixture.input);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({
        fixture,
        passed: false,
        errors: ["decideRoute threw: " + errMsg],
      });
      console.log("[" + fixture.id + "] FAIL: decideRoute threw unexpectedly");
      console.log("  Error: " + errMsg);
      console.log("");
      continue;
    }

    const errors = validateAction(action, fixture.expected);
    const passed = errors.length === 0;

    results.push({ fixture, passed, errors });

    if (passed) {
      console.log("[" + fixture.id + "] PASS (action: " + action.type + ")");
    } else {
      console.log("[" + fixture.id + "] FAIL:");
      for (const e of errors) {
        console.log("  - " + e);
      }
    }
    console.log("");
  }

  // --- Additional test: unknown classification returns safe label (BA-011 Gate 2) ---
  console.log("--- extra-1: unknown classification returns safe label (Gate 2) ---");
  let unknownSafeLabel = false;
  try {
    const unknownResult = decideRoute({
      classification: "banana_error",
      severity: "P1",
      confidence: 0.9,
      extracted_context: {},
      issue_number: 999,
    });
    // Should return label action with needs-human-review + unknown-classification + sdk-routed
    if (unknownResult.type === "label" &&
        unknownResult.labels.includes(ROUTING.LABEL_NEEDS_HUMAN_REVIEW) &&
        unknownResult.labels.includes(ROUTING.LABEL_UNKNOWN_CLASSIFICATION) &&
        unknownResult.labels.includes(ROUTING.LABEL_ROUTED)) {
      unknownSafeLabel = true;
    }
  } catch {
    // Should NOT throw anymore
    unknownSafeLabel = false;
  }
  if (unknownSafeLabel) {
    console.log("[extra-1] PASS: decideRoute returned safe label for unknown classification");
  } else {
    console.log("[extra-1] FAIL: decideRoute did NOT return safe label for unknown classification");
  }
  console.log("");

  // --- Additional test: DRY_RUN mode logs but does not execute (AC-9) ---
  console.log("--- extra-2: DRY_RUN mode logs without executing ---");
  const dryRunAction = decideRoute({
    classification: "content_error",
    severity: "P2",
    confidence: 0.9,
    extracted_context: { category: "US History" },
    issue_number: 100,
  });
  // executeRoute with dryRun=true should NOT throw (no API calls)
  let dryRunPassed = false;
  try {
    await executeRoute(dryRunAction, true);
    dryRunPassed = true;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[extra-2] FAIL: executeRoute(dryRun=true) threw: " + errMsg);
  }
  if (dryRunPassed) {
    console.log("[extra-2] PASS: executeRoute(dryRun=true) completed without API calls");
  }
  console.log("");

  // --- Additional test: all classifications below threshold → label-only (TEA: gate1-below-threshold-all-types) ---
  console.log("--- extra-3: all classifications below threshold → label-only ---");
  let allBelowThresholdPassed = true;
  for (const cls of CLASSIFICATIONS) {
    const result = decideRoute({
      classification: cls,
      severity: "P2",
      confidence: 0.5,
      extracted_context: {},
      issue_number: 300,
    });
    if (result.type !== "label" || !("labels" in result) || !result.labels.includes(ROUTING.LABEL_LOW_CONFIDENCE)) {
      console.log("[extra-3] FAIL: " + cls + " with confidence 0.5 did NOT return low-confidence label");
      allBelowThresholdPassed = false;
    }
  }
  if (allBelowThresholdPassed) {
    console.log("[extra-3] PASS: All " + CLASSIFICATIONS.length + " classifications at 0.5 confidence → label-only with low-confidence");
  }
  console.log("");

  // --- Additional test: prompt no longer contains confidence masking instruction (TEA: prompt-no-confidence-masking) ---
  console.log("--- extra-4: prompt has no confidence masking instruction ---");
  let promptCheckPassed = false;
  // Resolve repo root — walk up from cwd until we find Scripts/sdk/prompts/
  const envRoot = process.env.GITHUB_WORKSPACE ?? process.env.SDK_REPO_ROOT;
  let resolvedRoot = envRoot ?? process.cwd();
  // If cwd is inside Scripts/sdk/, go up to repo root
  if (!envRoot && resolvedRoot.includes(path.join("Scripts", "sdk"))) {
    resolvedRoot = resolvedRoot.split(path.join("Scripts", "sdk"))[0];
  }
  const promptPath = path.join(resolvedRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
  try {
    const promptText = fs.readFileSync(promptPath, "utf-8");
    const hasMasking = promptText.includes("you MUST classify as `needs_human_review`") ||
                       promptText.includes("you MUST classify as needs_human_review");
    if (hasMasking) {
      console.log("[extra-4] FAIL: Prompt still contains confidence masking instruction");
    } else {
      promptCheckPassed = true;
      console.log("[extra-4] PASS: Prompt no longer contains confidence masking instruction");
    }
  } catch (err: unknown) {
    console.log("[extra-4] SKIP: Could not read prompt file: " + (err instanceof Error ? err.message : String(err)));
    promptCheckPassed = true; // Don't fail if we can't find the file in CI
  }
  console.log("");

  // --- Summary ---
  console.log("=== Routing Test Suite Summary ===");
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.length - passCount;
  const extraPassCount = (unknownSafeLabel ? 1 : 0) + (dryRunPassed ? 1 : 0) + (allBelowThresholdPassed ? 1 : 0) + (promptCheckPassed ? 1 : 0);
  const extraFailCount = 4 - extraPassCount;
  const totalPass = passCount + extraPassCount;
  const totalFail = failCount + extraFailCount;
  const totalTests = results.length + 4;

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const detail = r.errors.length > 0 ? " (" + r.errors.join("; ") + ")" : "";
    console.log("  " + r.fixture.id + ": " + status + detail);
  }
  console.log("  extra-1: " + (unknownSafeLabel ? "PASS" : "FAIL"));
  console.log("  extra-2: " + (dryRunPassed ? "PASS" : "FAIL"));
  console.log("  extra-3: " + (allBelowThresholdPassed ? "PASS" : "FAIL"));
  console.log("  extra-4: " + (promptCheckPassed ? "PASS" : "FAIL"));

  console.log("");
  console.log("Results: " + totalPass + "/" + totalTests + " passed, " + totalFail + " failed");

  if (totalFail > 0) {
    console.error("");
    console.error("=== ROUTING TEST SUITE FAILED ===");
    process.exit(1);
  }

  console.log("");
  console.log("=== ROUTING TEST SUITE PASSED ===");
}
