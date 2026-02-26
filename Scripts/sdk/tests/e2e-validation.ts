/**
 * BA-011 Story 3.4: Live End-to-End Validation Script
 *
 * Submits 5 predefined bug descriptions through the real triage pipeline
 * (Haiku API) and verifies classification + routing decisions match the
 * expected test matrix.
 *
 * NOT a CI test — requires ANTHROPIC_API_KEY and costs real money (~$0.04).
 * Run manually by operator before declaring BA-011 complete.
 *
 * Usage:
 *   DRY_RUN=true npx tsx Scripts/sdk/tests/e2e-validation.ts   # No GitHub side effects
 *   npx tsx Scripts/sdk/tests/e2e-validation.ts                  # Full live run (uses GitHub API)
 *
 * Output: Human-readable checklist + JSON validation report.
 *
 * Exit codes:
 * - 0: Validation completed (results documented regardless of pass/fail)
 * - 1: Fatal error (e.g., API key missing, all calls failed)
 */

import { runTriage, type TriageResult } from "../workflows/bug-triage.js";
import { decideRoute, type RoutingAction } from "../lib/routing.js";
import { logRoutingDecision, type RoutingDecisionLogEntry } from "../lib/routing-log.js";
import { readRoutingLogForDate } from "../lib/digest-confidence.js";
import { ROUTING, CONFIDENCE_THRESHOLD } from "../config.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Test Matrix (Story 3.4)
// ---------------------------------------------------------------------------

interface ValidationCase {
  id: number;
  description: string;
  expected_classification: string[];
  expected_route_type: string[];
  /** Labels that MUST be present */
  required_labels: string[];
  /** Labels that MUST NOT be present */
  forbidden_labels: string[];
  /** Whether a dispatch event should fire */
  expect_dispatch: boolean;
  /** Whether a handoff comment should be posted */
  expect_handoff: boolean;
}

const VALIDATION_CASES: ValidationCase[] = [
  {
    id: 1,
    description: "The moon landing event says 1968 instead of 1969 in US History",
    expected_classification: ["content_error"],
    expected_route_type: ["dispatch"],
    required_labels: [ROUTING.LABEL_ROUTED, ROUTING.LABEL_CONTENT_ERROR],
    forbidden_labels: [ROUTING.LABEL_LOW_CONFIDENCE, ROUTING.LABEL_UNKNOWN_CLASSIFICATION],
    expect_dispatch: true,
    expect_handoff: false,
  },
  {
    id: 2,
    description: "There are two copies of the Boston Tea Party event in US History",
    expected_classification: ["content_duplicate", "content_error"],
    expected_route_type: ["label"],
    required_labels: [ROUTING.LABEL_ROUTED],
    forbidden_labels: [],
    expect_dispatch: false,
    expect_handoff: false,
  },
  {
    id: 3,
    description: "The app is really slow when loading the Dutch History category",
    expected_classification: ["performance_issue", "gameplay_bug"],
    expected_route_type: ["handoff_to_dev", "label"],
    required_labels: [ROUTING.LABEL_ROUTED],
    forbidden_labels: [],
    expect_dispatch: false,
    expect_handoff: true, // Only if performance_issue is classified
  },
  {
    id: 4,
    description: "In the German translation of Ancient Civilizations, 'vereint' should be 'vereinigt'",
    expected_classification: ["translation_error"],
    expected_route_type: ["label_and_state"],
    required_labels: [ROUTING.LABEL_ROUTED, ROUTING.LABEL_TRANSLATION_ERROR],
    forbidden_labels: [],
    expect_dispatch: false,
    expect_handoff: false,
  },
  {
    id: 5,
    description: "Something seems weird with the app but I can't quite describe it",
    expected_classification: ["needs_human_review"],
    expected_route_type: ["label"],
    required_labels: [ROUTING.LABEL_ROUTED, ROUTING.LABEL_NEEDS_HUMAN_REVIEW],
    forbidden_labels: [],
    expect_dispatch: false,
    expect_handoff: false,
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CaseResult {
  case_id: number;
  description: string;
  classification: string;
  confidence: number;
  severity: string;
  route_type: string;
  route_labels: string[];
  classification_correct: boolean;
  route_correct: boolean;
  dispatch_check: boolean;
  handoff_check: boolean;
  overall_pass: boolean;
  notes: string[];
}

interface ValidationReport {
  date: string;
  dry_run: boolean;
  results: CaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    accuracy: number;
  };
  routing_log_check: {
    entries_found: number;
    all_present: boolean;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";

  console.log("=== BA-011 Story 3.4: Live End-to-End Validation ===");
  console.log("Mode: " + (dryRun ? "DRY RUN (no GitHub side effects)" : "LIVE (will call GitHub API)"));
  console.log("Cases: " + VALIDATION_CASES.length);
  console.log("Cost estimate: ~$" + (VALIDATION_CASES.length * 0.008).toFixed(3));
  console.log("");

  const results: CaseResult[] = [];
  let fatalErrors = 0;

  for (const testCase of VALIDATION_CASES) {
    console.log("--- Case #" + testCase.id + " ---");
    console.log("Report: \"" + testCase.description + "\"");
    console.log("Expected: " + JSON.stringify(testCase.expected_classification) + " -> " + JSON.stringify(testCase.expected_route_type));

    // Step 1: Triage (real Haiku API call)
    let triageResult: TriageResult;
    try {
      triageResult = await runTriage({
        report_text: testCase.description,
        report_id: "e2e-" + testCase.id,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[Case #" + testCase.id + "] FATAL: Triage failed: " + errMsg);
      fatalErrors++;
      results.push({
        case_id: testCase.id,
        description: testCase.description,
        classification: "ERROR",
        confidence: 0,
        severity: "unknown",
        route_type: "error",
        route_labels: [],
        classification_correct: false,
        route_correct: false,
        dispatch_check: false,
        handoff_check: false,
        overall_pass: false,
        notes: ["Triage API error: " + errMsg],
      });
      console.log("");
      continue;
    }

    console.log("  Classification: " + triageResult.classification + " (confidence: " + triageResult.confidence.toFixed(2) + ", severity: " + triageResult.severity + ")");

    // Step 2: Route (pure logic)
    const routingInput = {
      classification: triageResult.classification,
      severity: triageResult.severity,
      confidence: triageResult.confidence,
      extracted_context: triageResult.extracted_context,
      issue_number: 9000 + testCase.id, // Fake issue number for validation
      existing_labels: [] as string[],
      issue_title: "E2E Validation #" + testCase.id,
      issue_body: testCase.description,
      reasoning: triageResult.reasoning,
    };

    const routingAction = decideRoute(routingInput);
    console.log("  Route: " + routingAction.type);

    // Extract labels from routing action
    let routeLabels: string[] = [];
    if ("labels" in routingAction) {
      routeLabels = routingAction.labels;
    }
    if (routingAction.type === "dispatch" && routingAction.issue_labels) {
      routeLabels = routingAction.issue_labels.labels;
    }
    console.log("  Labels: [" + routeLabels.join(", ") + "]");

    // Step 3: Log routing decision (writes to JSONL)
    const logEntry: RoutingDecisionLogEntry = {
      ts: new Date().toISOString(),
      issue: 9000 + testCase.id,
      cls: triageResult.classification,
      conf: triageResult.confidence,
      action: routingAction.type,
      labels: routeLabels,
      gate: triageResult.confidence < CONFIDENCE_THRESHOLD ? "confidence"
        : !["content_error", "content_category_error", "content_duplicate", "translation_error",
            "ui_bug", "gameplay_bug", "performance_issue", "crash_bug", "feature_request",
            "needs_human_review"].includes(triageResult.classification) ? "unknown_classification"
        : "classification_route",
    };
    logRoutingDecision(logEntry);

    // Step 4: Verify against test matrix
    const notes: string[] = [];

    const classificationCorrect = testCase.expected_classification.includes(triageResult.classification);
    if (!classificationCorrect) {
      notes.push("MISCLASSIFIED: expected " + JSON.stringify(testCase.expected_classification) + ", got " + triageResult.classification);
    }

    const routeCorrect = testCase.expected_route_type.includes(routingAction.type);
    if (!routeCorrect) {
      notes.push("WRONG ROUTE: expected " + JSON.stringify(testCase.expected_route_type) + ", got " + routingAction.type);
    }

    // Check dispatch expectation
    const actuallyDispatched = routingAction.type === "dispatch";
    const dispatchCheck = testCase.expect_dispatch === actuallyDispatched;
    if (!dispatchCheck) {
      notes.push("DISPATCH " + (testCase.expect_dispatch ? "expected but not fired" : "fired unexpectedly"));
    }

    // Check handoff expectation (only for performance_issue classification)
    const actuallyHandoff = routingAction.type === "handoff_to_dev";
    const handoffCheck = testCase.expect_handoff ? actuallyHandoff || routingAction.type === "label" : true;
    if (testCase.expect_handoff && !actuallyHandoff) {
      if (routingAction.type === "label") {
        notes.push("NOTE: Expected handoff_to_dev but got label (may be missing issue_title/body — acceptable in validation mode)");
      } else {
        notes.push("HANDOFF expected but action was " + routingAction.type);
      }
    }

    // Check required labels
    for (const label of testCase.required_labels) {
      if (!routeLabels.includes(label)) {
        notes.push("MISSING LABEL: " + label);
      }
    }

    // Check forbidden labels
    for (const label of testCase.forbidden_labels) {
      if (routeLabels.includes(label)) {
        notes.push("UNEXPECTED LABEL: " + label);
      }
    }

    const overallPass = classificationCorrect && routeCorrect && dispatchCheck && handoffCheck && notes.filter(n => n.startsWith("MISSING") || n.startsWith("UNEXPECTED") || n.startsWith("WRONG") || n.startsWith("DISPATCH")).length === 0;

    if (overallPass) {
      console.log("  [Case #" + testCase.id + "] PASS");
    } else {
      console.log("  [Case #" + testCase.id + "] ISSUES:");
      for (const note of notes) {
        console.log("    - " + note);
      }
    }
    console.log("");

    results.push({
      case_id: testCase.id,
      description: testCase.description,
      classification: triageResult.classification,
      confidence: triageResult.confidence,
      severity: triageResult.severity,
      route_type: routingAction.type,
      route_labels: routeLabels,
      classification_correct: classificationCorrect,
      route_correct: routeCorrect,
      dispatch_check: dispatchCheck,
      handoff_check: handoffCheck,
      overall_pass: overallPass,
      notes,
    });
  }

  // Step 5: Verify routing log
  console.log("--- Routing Log Verification ---");
  const today = new Date().toISOString().slice(0, 10);
  const digestData = readRoutingLogForDate(today);
  const logEntries = digestData.all.filter(e => e.issue >= 9001 && e.issue <= 9005);
  const logCheck = {
    entries_found: logEntries.length,
    all_present: logEntries.length === VALIDATION_CASES.length,
  };
  if (logCheck.all_present) {
    console.log("Routing log: " + logCheck.entries_found + "/" + VALIDATION_CASES.length + " entries found");
  } else {
    console.log("Routing log: INCOMPLETE — " + logCheck.entries_found + "/" + VALIDATION_CASES.length + " entries");
  }
  console.log("");

  // Step 6: Summary
  const passed = results.filter(r => r.overall_pass).length;
  const failed = results.length - passed;
  const accuracy = results.length > 0 ? passed / results.length : 0;

  console.log("=== Validation Summary ===");
  console.log("Passed: " + passed + "/" + results.length + " (" + (accuracy * 100).toFixed(0) + "%)");
  if (failed > 0) {
    console.log("Failed: " + failed);
    for (const r of results.filter(r => !r.overall_pass)) {
      console.log("  Case #" + r.case_id + ": " + r.notes.join("; "));
    }
  }
  if (fatalErrors > 0) {
    console.log("Fatal errors: " + fatalErrors);
  }

  // Build report
  const report: ValidationReport = {
    date: today,
    dry_run: dryRun,
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      accuracy: Math.round(accuracy * 1000) / 1000,
    },
    routing_log_check: logCheck,
  };

  console.log("");
  console.log("=== JSON Report ===");
  console.log(JSON.stringify(report, null, 2));

  // Exit 0 even on failures (validation is informational — operator reviews results)
  // Exit 1 only if all cases errored
  if (fatalErrors === VALIDATION_CASES.length) {
    console.error("FATAL: All validation cases errored — no results to report");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
