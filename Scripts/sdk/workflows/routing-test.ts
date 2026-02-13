/**
 * Story 4.2: Routing Test Harness
 *
 * Validates all 9 routing fixtures by running them through decideRoute()
 * and comparing the returned RoutingAction against expected values.
 *
 * Pure logic test — NO Anthropic API calls, NO GitHub API calls.
 * Cost: $0.00
 *
 * Also validates:
 * - decideRoute() throws on unknown classification (defensive)
 * - DRY_RUN mode logs but does not execute
 *
 * Exit codes:
 * - 0: All tests pass
 * - 1: One or more tests fail
 */

import { ROUTING_FIXTURES, type RoutingFixture, type ExpectedAction } from "../tests/routing-fixtures.js";
import { decideRoute, executeRoute, type RoutingAction } from "../lib/routing.js";

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

  // --- Additional test: unknown classification throws (defensive) ---
  console.log("--- extra-1: unknown classification throws ---");
  let unknownThrew = false;
  try {
    decideRoute({
      classification: "banana_error",
      severity: "P1",
      confidence: 0.9,
      extracted_context: {},
      issue_number: 999,
    });
  } catch {
    unknownThrew = true;
  }
  if (unknownThrew) {
    console.log("[extra-1] PASS: decideRoute threw on unknown classification");
  } else {
    console.log("[extra-1] FAIL: decideRoute did NOT throw on unknown classification");
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

  // --- Summary ---
  console.log("=== Routing Test Suite Summary ===");
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.length - passCount;
  const extraPassCount = (unknownThrew ? 1 : 0) + (dryRunPassed ? 1 : 0);
  const extraFailCount = 2 - extraPassCount;
  const totalPass = passCount + extraPassCount;
  const totalFail = failCount + extraFailCount;
  const totalTests = results.length + 2;

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const detail = r.errors.length > 0 ? " (" + r.errors.join("; ") + ")" : "";
    console.log("  " + r.fixture.id + ": " + status + detail);
  }
  console.log("  extra-1: " + (unknownThrew ? "PASS" : "FAIL"));
  console.log("  extra-2: " + (dryRunPassed ? "PASS" : "FAIL"));

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
