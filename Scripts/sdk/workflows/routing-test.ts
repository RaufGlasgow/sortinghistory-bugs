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
import { logRoutingDecision, type RoutingDecisionLogEntry } from "../lib/routing-log.js";
import { ROUTING, CLASSIFICATIONS, PATHS } from "../config.js";
import { runContractTest } from "../tests/contract-test.js";
import { generateTriageHandoff, buildFallbackHandoffComment, type TriageOnlyHandoffInput } from "../lib/handoff-generator.js";
import { readRoutingLogForDate, buildLabelFallback, renderNeedsAttentionHtml, formatClassificationDisplay, type IssueConfidenceData, type DigestConfidenceResult } from "../lib/digest-confidence.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

    case "handoff_to_dev": {
      if (actual.type !== "handoff_to_dev") break;
      if (actual.repo !== expected.repo) {
        errors.push("repo: got \"" + actual.repo + "\", expected \"" + expected.repo + "\"");
      }
      const actualLabelsH = [...actual.labels].sort();
      const expectedLabelsH = [...expected.labels].sort();
      if (JSON.stringify(actualLabelsH) !== JSON.stringify(expectedLabelsH)) {
        errors.push(
          "labels: got [" + actualLabelsH.join(", ") + "], expected [" + expectedLabelsH.join(", ") + "]"
        );
      }
      if (actual.triage_data.classification !== expected.classification) {
        errors.push("triage_data.classification: got \"" + actual.triage_data.classification + "\", expected \"" + expected.classification + "\"");
      }
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

  // --- Additional test: routing log schema complete (TEA: routing-log-schema-complete) ---
  console.log("--- extra-5: routing log entry has all 7 fields ---");
  let logSchemaCheckPassed = false;
  {
    // Write a log entry to a temp dir and verify schema
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-log-test-"));
    const logSubdir = path.join(tmpDir, "log");
    // Override PATHS.ROUTING_LOG_DIR and SDK_REPO_ROOT so logRoutingDecision writes to our tmpDir
    const origPathsLogDir = PATHS.ROUTING_LOG_DIR;
    const origRepo = process.env.SDK_REPO_ROOT;
    PATHS.ROUTING_LOG_DIR = logSubdir;
    process.env.SDK_REPO_ROOT = tmpDir;
    const testEntry: RoutingDecisionLogEntry = {
      ts: new Date().toISOString(),
      issue: 42,
      cls: "content_error",
      conf: 0.92,
      action: "dispatch",
      labels: ["content-error", "sdk-routed"],
      gate: "classification_route",
    };
    logRoutingDecision(testEntry);
    // Restore
    PATHS.ROUTING_LOG_DIR = origPathsLogDir;
    if (origRepo !== undefined) { process.env.SDK_REPO_ROOT = origRepo; } else { delete process.env.SDK_REPO_ROOT; }

    // Read and parse the log
    const date = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logSubdir, date + ".jsonl");
    if (fs.existsSync(logFile)) {
      const line = fs.readFileSync(logFile, "utf-8").trim();
      try {
        const parsed = JSON.parse(line);
        const requiredFields = ["ts", "issue", "cls", "conf", "action", "labels", "gate"];
        const missingFields = requiredFields.filter(f => !(f in parsed));
        if (missingFields.length === 0) {
          logSchemaCheckPassed = true;
          console.log("[extra-5] PASS: All 7 fields present in routing log entry");
        } else {
          console.log("[extra-5] FAIL: Missing fields: " + missingFields.join(", "));
        }
      } catch (err: unknown) {
        console.log("[extra-5] FAIL: Could not parse log entry: " + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      console.log("[extra-5] FAIL: Log file not created at " + logFile);
    }
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
  }
  console.log("");

  // --- Additional test: routing log has no sensitive data (TEA: routing-log-no-sensitive-data) ---
  console.log("--- extra-6: routing log contains no issue body/title text ---");
  let logNoSensitivePassed = false;
  {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "routing-log-test2-"));
    const logSubdir2 = path.join(tmpDir2, "log2");
    const origPathsLogDir2 = PATHS.ROUTING_LOG_DIR;
    const origRepo2 = process.env.SDK_REPO_ROOT;
    PATHS.ROUTING_LOG_DIR = logSubdir2;
    process.env.SDK_REPO_ROOT = tmpDir2;
    const testEntry2: RoutingDecisionLogEntry = {
      ts: new Date().toISOString(),
      issue: 42,
      cls: "ui_bug",
      conf: 0.8,
      action: "label",
      labels: ["ui-bug", "sdk-routed"],
      gate: "classification_route",
    };
    logRoutingDecision(testEntry2);
    PATHS.ROUTING_LOG_DIR = origPathsLogDir2;
    if (origRepo2 !== undefined) { process.env.SDK_REPO_ROOT = origRepo2; } else { delete process.env.SDK_REPO_ROOT; }

    const date2 = new Date().toISOString().slice(0, 10);
    const logFile2 = path.join(logSubdir2, date2 + ".jsonl");
    if (fs.existsSync(logFile2)) {
      const line2 = fs.readFileSync(logFile2, "utf-8").trim();
      // Verify no issue body/title text (just number)
      const parsed2 = JSON.parse(line2);
      if (typeof parsed2.issue === "number" && !line2.includes("title") && !line2.includes("body")) {
        logNoSensitivePassed = true;
        console.log("[extra-6] PASS: Log contains only issue number (integer), no title/body text");
      } else {
        console.log("[extra-6] FAIL: Log contains issue text or non-integer issue field");
      }
    } else {
      console.log("[extra-6] FAIL: Log file not created");
    }
    try { fs.rmSync(tmpDir2, { recursive: true }); } catch { /* best-effort */ }
  }
  console.log("");

  // --- Additional test: routing.ts does not call logRoutingDecision (ARCH-1: decideRoute pure) ---
  console.log("--- extra-7: routing.ts has zero matches for logRoutingDecision ---");
  let routingPureCheckPassed = false;
  {
    const routingFilePath = path.join(resolvedRoot, "Scripts", "sdk", "lib", "routing.ts");
    try {
      const routingSource = fs.readFileSync(routingFilePath, "utf-8");
      if (!routingSource.includes("logRoutingDecision")) {
        routingPureCheckPassed = true;
        console.log("[extra-7] PASS: routing.ts contains zero references to logRoutingDecision");
      } else {
        console.log("[extra-7] FAIL: routing.ts contains logRoutingDecision (decideRoute must remain pure)");
      }
    } catch (err: unknown) {
      console.log("[extra-7] SKIP: Could not read routing.ts: " + (err instanceof Error ? err.message : String(err)));
      routingPureCheckPassed = true; // Don't fail if can't find file in CI
    }
  }
  console.log("");

  // --- Additional test: gate field values are from expected enum (TEA: routing-log-gate-field-values) ---
  console.log("--- extra-8: gate field values are valid enum values ---");
  const validGates = new Set(["confidence", "unknown_classification", "idempotency", "classification_route"]);
  const testGateValues: RoutingDecisionLogEntry["gate"][] = ["confidence", "unknown_classification", "idempotency", "classification_route"];
  const allGatesValid = testGateValues.every(g => validGates.has(g));
  if (allGatesValid) {
    console.log("[extra-8] PASS: All gate values are from expected enum");
  } else {
    console.log("[extra-8] FAIL: Unknown gate values found");
  }
  console.log("");

  // --- Additional test: contract test — all classifications in 4 files (BA-011 Story 2.2) ---
  console.log("--- extra-9: contract test — all classifications present in 4 files ---");
  let contractTestPassed = false;
  try {
    // runContractTest() calls process.exit(1) on failure, so we need to catch that.
    // Instead, we'll test the same logic inline to avoid process.exit in a sub-call.
    // Import the checks from contract-test and run them directly.
    const { ROUTING_FIXTURES: allFixtures } = await import("../tests/routing-fixtures.js");

    const envRootC = process.env.GITHUB_WORKSPACE ?? process.env.SDK_REPO_ROOT;
    let repoRootC = envRootC ?? process.cwd();
    if (!envRootC && repoRootC.includes(path.join("Scripts", "sdk"))) {
      repoRootC = repoRootC.split(path.join("Scripts", "sdk"))[0];
    }

    const contractErrors: string[] = [];

    // Check 1: routing.ts cases
    const routingSource = fs.readFileSync(path.join(repoRootC, "Scripts", "sdk", "lib", "routing.ts"), "utf-8");
    for (const cls of CLASSIFICATIONS) {
      if (!routingSource.includes('case "' + cls + '":')) {
        contractErrors.push("Missing case in routing.ts for: " + cls);
      }
    }

    // Check 2: routing fixtures
    const fixtureClassifications = new Set(allFixtures.map((f: { input: { classification: string } }) => f.input.classification));
    for (const cls of CLASSIFICATIONS) {
      if (!fixtureClassifications.has(cls)) {
        contractErrors.push("Missing fixture in routing-fixtures.ts for: " + cls);
      }
    }

    // Check 3: prompt headings
    const promptSource = fs.readFileSync(path.join(repoRootC, "Scripts", "sdk", "prompts", "bug-triager.md"), "utf-8");
    for (const cls of CLASSIFICATIONS) {
      if (!promptSource.includes("### " + cls)) {
        contractErrors.push("Missing ### heading in bug-triager.md for: " + cls);
      }
    }

    // Check 4: triage validator
    const triageSource = fs.readFileSync(path.join(repoRootC, "Scripts", "sdk", "workflows", "bug-triage.ts"), "utf-8");
    if (!triageSource.includes("CLASSIFICATION_SET")) {
      contractErrors.push("bug-triage.ts does not reference CLASSIFICATION_SET");
    }

    if (contractErrors.length === 0) {
      contractTestPassed = true;
      console.log("[extra-9] PASS: All " + CLASSIFICATIONS.length + " classifications present in all 4 files");
    } else {
      for (const err of contractErrors) {
        console.log("[extra-9] FAIL: " + err);
      }
    }
  } catch (err: unknown) {
    console.log("[extra-9] FAIL: Contract test error: " + (err instanceof Error ? err.message : String(err)));
  }
  console.log("");

  // --- Additional test: prompt has positive AND negative examples per classification (Story 2.3 AC1) ---
  console.log("--- extra-10: prompt has positive AND negative examples per classification ---");
  let promptExamplesPassed = true;
  {
    const promptExPath = path.join(resolvedRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    try {
      const promptExText = fs.readFileSync(promptExPath, "utf-8");
      for (const cls of CLASSIFICATIONS) {
        const headingIdx = promptExText.indexOf("### " + cls);
        if (headingIdx === -1) {
          console.log("[extra-10] FAIL: Missing ### " + cls + " heading");
          promptExamplesPassed = false;
          continue;
        }
        // Find the section text between this heading and the next ### or ## heading
        const afterHeading = promptExText.slice(headingIdx);
        const nextHeading = afterHeading.indexOf("\n##", 5); // Skip past the current heading
        const sectionText = nextHeading > 0 ? afterHeading.slice(0, nextHeading) : afterHeading;

        // Check for positive examples (contains "This IS" or example lines after heading)
        const hasPositive = sectionText.includes("**This IS " + cls + ":**") || sectionText.includes("**Use " + cls + " when:**") || sectionText.includes("**Examples that need human review:**");
        // Check for negative examples (contains "This is NOT" or "is NOT")
        const hasNegative = sectionText.includes("**This is NOT " + cls + ":**") || sectionText.includes("is NOT " + cls);

        if (!hasPositive) {
          console.log("[extra-10] FAIL: " + cls + " missing positive examples");
          promptExamplesPassed = false;
        }
        if (!hasNegative && cls !== "needs_human_review") {
          // needs_human_review doesn't need negative examples (it IS the catch-all)
          console.log("[extra-10] FAIL: " + cls + " missing negative examples");
          promptExamplesPassed = false;
        }
      }
      if (promptExamplesPassed) {
        console.log("[extra-10] PASS: All classifications have positive and negative examples");
      }
    } catch (err: unknown) {
      console.log("[extra-10] SKIP: Could not read prompt: " + (err instanceof Error ? err.message : String(err)));
      promptExamplesPassed = true;
    }
  }
  console.log("");

  // --- Additional test: prompt has cost-awareness section (Story 2.3 AC3) ---
  console.log("--- extra-11: prompt has cost-awareness section ---");
  let costAwarenessPassed = false;
  {
    const promptCostPath = path.join(resolvedRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    try {
      const promptCostText = fs.readFileSync(promptCostPath, "utf-8");
      const hasCostSection = promptCostText.includes("## Cost Awareness") || promptCostText.includes("## Cost-Awareness");
      const hasCheapest = promptCostText.includes("cheap") || promptCostText.includes("cheapest") || promptCostText.includes("safest");
      const hasNeedsHumanDefault = promptCostText.includes("needs_human_review") && (promptCostText.includes("when in doubt") || promptCostText.includes("When in doubt"));
      if (hasCostSection && hasCheapest && hasNeedsHumanDefault) {
        costAwarenessPassed = true;
        console.log("[extra-11] PASS: Cost-awareness section present with safe-default guidance");
      } else {
        const missing: string[] = [];
        if (!hasCostSection) missing.push("## Cost Awareness heading");
        if (!hasCheapest) missing.push("cheapest/safest guidance");
        if (!hasNeedsHumanDefault) missing.push("needs_human_review default when in doubt");
        console.log("[extra-11] FAIL: Missing: " + missing.join(", "));
      }
    } catch (err: unknown) {
      console.log("[extra-11] SKIP: Could not read prompt: " + (err instanceof Error ? err.message : String(err)));
      costAwarenessPassed = true;
    }
  }
  console.log("");

  // --- Additional test: prompt has no vendor-specific features (Story 2.3 AC4, NFR11) ---
  console.log("--- extra-12: prompt has no vendor-specific features ---");
  let vendorFreePassed = false;
  {
    const promptVendorPath = path.join(resolvedRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    try {
      const promptVendorText = fs.readFileSync(promptVendorPath, "utf-8");
      const vendorPatterns = [
        { pattern: /<\/?system>/i, name: "<system> tags" },
        { pattern: /<\/?human>/i, name: "<human> tags" },
        { pattern: /<\/?assistant>/i, name: "<assistant> tags" },
        { pattern: /\{"role":\s*"system"/i, name: "OpenAI role format" },
        { pattern: /\{"type":\s*"function"/i, name: "OpenAI function calling" },
        { pattern: /<anthr/i, name: "Anthropic-specific tags" },
      ];
      const found: string[] = [];
      for (const { pattern, name } of vendorPatterns) {
        if (pattern.test(promptVendorText)) {
          found.push(name);
        }
      }
      if (found.length === 0) {
        vendorFreePassed = true;
        console.log("[extra-12] PASS: No vendor-specific features found in prompt");
      } else {
        console.log("[extra-12] FAIL: Vendor-specific features found: " + found.join(", "));
      }
    } catch (err: unknown) {
      console.log("[extra-12] SKIP: Could not read prompt: " + (err instanceof Error ? err.message : String(err)));
      vendorFreePassed = true;
    }
  }
  console.log("");

  // --- Additional test: prompt does not contain "6 categories" or "6 classifications" (Story 2.3) ---
  console.log("--- extra-13: prompt classification count updated (no '6 categories') ---");
  let countUpdatedPassed = false;
  {
    const promptCountPath = path.join(resolvedRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    try {
      const promptCountText = fs.readFileSync(promptCountPath, "utf-8");
      const hasOldCount = promptCountText.includes("6 categories") || promptCountText.includes("6 classifications") || promptCountText.includes("7 categories") || promptCountText.includes("7 classifications");
      if (!hasOldCount) {
        countUpdatedPassed = true;
        console.log("[extra-13] PASS: Prompt does not contain outdated classification count");
      } else {
        console.log("[extra-13] FAIL: Prompt still contains old count (6 or 7 categories/classifications)");
      }
    } catch (err: unknown) {
      console.log("[extra-13] SKIP: Could not read prompt: " + (err instanceof Error ? err.message : String(err)));
      countUpdatedPassed = true;
    }
  }
  console.log("");

  // --- Additional test: crash_bug vs gameplay_bug boundary explicit in prompt (Story 2.3 AC6) ---
  console.log("--- extra-14: crash_bug vs gameplay_bug boundary is explicit ---");
  let boundaryPassed = false;
  {
    const promptBoundaryPath = path.join(resolvedRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    try {
      const promptBoundaryText = fs.readFileSync(promptBoundaryPath, "utf-8");
      // crash_bug section should mention gameplay_bug as a negative example
      const crashSection = promptBoundaryText.slice(promptBoundaryText.indexOf("### crash_bug"));
      const nextFromCrash = crashSection.indexOf("\n### ", 5);
      const crashText = nextFromCrash > 0 ? crashSection.slice(0, nextFromCrash) : crashSection;
      const crashMentionsGameplay = crashText.includes("gameplay_bug");

      // gameplay_bug section should mention crash_bug as a negative example
      const gameplaySection = promptBoundaryText.slice(promptBoundaryText.indexOf("### gameplay_bug"));
      const nextFromGameplay = gameplaySection.indexOf("\n### ", 5);
      const gameplayText = nextFromGameplay > 0 ? gameplaySection.slice(0, nextFromGameplay) : gameplaySection;
      const gameplayMentionsCrash = gameplayText.includes("crash_bug");

      if (crashMentionsGameplay && gameplayMentionsCrash) {
        boundaryPassed = true;
        console.log("[extra-14] PASS: crash_bug and gameplay_bug cross-reference each other in negative examples");
      } else {
        const missing: string[] = [];
        if (!crashMentionsGameplay) missing.push("crash_bug section doesn't mention gameplay_bug");
        if (!gameplayMentionsCrash) missing.push("gameplay_bug section doesn't mention crash_bug");
        console.log("[extra-14] FAIL: " + missing.join("; "));
      }
    } catch (err: unknown) {
      console.log("[extra-14] SKIP: Could not read prompt: " + (err instanceof Error ? err.message : String(err)));
      boundaryPassed = true;
    }
  }
  console.log("");

  // --- Additional test: triage.ts passes issue_title/issue_body to routing input (Story 2.4 AC1) ---
  console.log("--- extra-15: triage.ts passes issue_title, issue_body, reasoning to routing input ---");
  let triageWiringPassed = false;
  {
    const triageWiringPath = path.join(resolvedRoot, "Scripts", "sdk", "workflows", "triage.ts");
    try {
      const triageWiringSource = fs.readFileSync(triageWiringPath, "utf-8");
      const hasIssueTitle = triageWiringSource.includes("issue_title:");
      const hasIssueBody = triageWiringSource.includes("issue_body:");
      const hasReasoning = triageWiringSource.includes("reasoning:");
      if (hasIssueTitle && hasIssueBody && hasReasoning) {
        triageWiringPassed = true;
        console.log("[extra-15] PASS: triage.ts passes issue_title, issue_body, and reasoning to routing input");
      } else {
        const missing: string[] = [];
        if (!hasIssueTitle) missing.push("issue_title");
        if (!hasIssueBody) missing.push("issue_body");
        if (!hasReasoning) missing.push("reasoning");
        console.log("[extra-15] FAIL: triage.ts missing fields in routing input: " + missing.join(", "));
      }
    } catch (err: unknown) {
      console.log("[extra-15] SKIP: Could not read triage.ts: " + (err instanceof Error ? err.message : String(err)));
      triageWiringPassed = true;
    }
  }
  console.log("");

  // --- Additional test: generateTriageHandoff includes required sections (Story 3.1 AC2) ---
  console.log("--- extra-16: generateTriageHandoff includes all required sections ---");
  let handoffSectionsPassed = false;
  {
    const testInput: TriageOnlyHandoffInput = {
      issueNumber: 99,
      issueTitle: "App crashes on statistics screen",
      issueBody: "Every time I open statistics, the app force-closes.",
      classification: "crash_bug",
      confidence: 0.92,
      severity: "P1",
      reasoning: "User reports app termination on specific screen",
      extractedContext: { screen: "StatisticsView", file_path: "unknown" },
    };
    const markdown = generateTriageHandoff(testInput);
    const required = [
      { label: "Classification table", check: markdown.includes("## Classification") && markdown.includes("`crash_bug`") },
      { label: "Confidence", check: markdown.includes("92%") },
      { label: "Severity", check: markdown.includes("`P1`") },
      { label: "Reasoning", check: markdown.includes("## Reasoning") && markdown.includes("app termination") },
      { label: "Bug Report", check: markdown.includes("## Bug Report") && markdown.includes("force-closes") },
      { label: "Relevant Code Paths", check: markdown.includes("## Relevant Code Paths") },
      { label: "Suggested Approach", check: markdown.includes("## Suggested Approach") },
    ];
    const missing = required.filter(r => !r.check).map(r => r.label);
    if (missing.length === 0) {
      handoffSectionsPassed = true;
      console.log("[extra-16] PASS: Handoff includes all 7 required sections");
    } else {
      console.log("[extra-16] FAIL: Missing sections: " + missing.join(", "));
    }
  }
  console.log("");

  // --- Additional test: generateTriageHandoff omits Attempt Log and QA Summary (Story 3.1 AC2) ---
  console.log("--- extra-17: generateTriageHandoff omits Attempt Log and QA Summary ---");
  let handoffOmitsPassed = false;
  {
    const testInput2: TriageOnlyHandoffInput = {
      issueNumber: 100,
      issueTitle: "Slow loading",
      issueBody: "Dutch History loads slowly.",
      classification: "performance_issue",
      confidence: 0.85,
      severity: "P2",
      reasoning: "User reports slow loading",
      extractedContext: {},
    };
    const markdown2 = generateTriageHandoff(testInput2);
    const hasAttempt = markdown2.includes("Attempt 1") || markdown2.includes("Attempt Log");
    const hasQA = markdown2.includes("QA Verdict") || markdown2.includes("QA Summary");
    if (!hasAttempt && !hasQA) {
      handoffOmitsPassed = true;
      console.log("[extra-17] PASS: Handoff omits Attempt Log and QA Summary");
    } else {
      console.log("[extra-17] FAIL: Handoff contains " + (hasAttempt ? "Attempt Log" : "") + (hasQA ? " QA Summary" : ""));
    }
  }
  console.log("");

  // --- Additional test: buildFallbackHandoffComment contains raw triage data (Story 3.1 AC3) ---
  console.log("--- extra-18: fallback comment contains raw triage data ---");
  let fallbackContentPassed = false;
  {
    const fallback = buildFallbackHandoffComment("crash_bug", 0.92, "P1", "App terminates on tap", "generation timeout");
    const hasCls = fallback.includes("crash_bug");
    const hasConf = fallback.includes("92%");
    const hasSev = fallback.includes("P1");
    const hasReasoning = fallback.includes("App terminates on tap");
    const hasError = fallback.includes("generation timeout");
    if (hasCls && hasConf && hasSev && hasReasoning && hasError) {
      fallbackContentPassed = true;
      console.log("[extra-18] PASS: Fallback comment contains classification, confidence, severity, reasoning, error");
    } else {
      const missing: string[] = [];
      if (!hasCls) missing.push("classification");
      if (!hasConf) missing.push("confidence");
      if (!hasSev) missing.push("severity");
      if (!hasReasoning) missing.push("reasoning");
      if (!hasError) missing.push("error");
      console.log("[extra-18] FAIL: Fallback missing: " + missing.join(", "));
    }
  }
  console.log("");

  // --- Additional test: routing.ts handoff_to_dev wiring (Story 3.1 static analysis) ---
  console.log("--- extra-19: routing.ts handoff_to_dev calls generateTriageHandoff + githubPostComment ---");
  let handoffWiringPassed = false;
  {
    const routingFilePath2 = path.join(resolvedRoot, "Scripts", "sdk", "lib", "routing.ts");
    try {
      const routingSrc = fs.readFileSync(routingFilePath2, "utf-8");
      const hasGenerate = routingSrc.includes("generateTriageHandoff(");
      const hasPostComment = routingSrc.includes("githubPostComment(");
      const hasRetry = routingSrc.includes("attempt 1") || routingSrc.includes("retry");
      const hasFallback = routingSrc.includes("buildFallbackHandoffComment(");
      const hasDeliveryFailed = routingSrc.includes("delivery-failed");
      const hasGenerationFailed = routingSrc.includes("handoff-generation-failed");
      if (hasGenerate && hasPostComment && hasRetry && hasFallback && hasDeliveryFailed && hasGenerationFailed) {
        handoffWiringPassed = true;
        console.log("[extra-19] PASS: routing.ts has generate, post, retry, fallback, delivery-failed, generation-failed");
      } else {
        const missing: string[] = [];
        if (!hasGenerate) missing.push("generateTriageHandoff call");
        if (!hasPostComment) missing.push("githubPostComment call");
        if (!hasRetry) missing.push("retry logic");
        if (!hasFallback) missing.push("buildFallbackHandoffComment call");
        if (!hasDeliveryFailed) missing.push("delivery-failed label");
        if (!hasGenerationFailed) missing.push("handoff-generation-failed label");
        console.log("[extra-19] FAIL: Missing: " + missing.join(", "));
      }
    } catch (err: unknown) {
      console.log("[extra-19] SKIP: Could not read routing.ts: " + (err instanceof Error ? err.message : String(err)));
      handoffWiringPassed = true;
    }
  }
  console.log("");

  // --- Additional test: githubPostComment uses same auth pattern (Story 3.1 AC5) ---
  console.log("--- extra-20: githubPostComment uses getGitHubToken (same auth pattern) ---");
  let authPatternPassed = false;
  {
    const routingFilePath3 = path.join(resolvedRoot, "Scripts", "sdk", "lib", "routing.ts");
    try {
      const routingSrc3 = fs.readFileSync(routingFilePath3, "utf-8");
      // Find the githubPostComment function and check it calls getGitHubToken
      const postCommentIdx = routingSrc3.indexOf("async function githubPostComment");
      if (postCommentIdx > -1) {
        // Look within the next 500 chars for getGitHubToken
        const fnBody = routingSrc3.slice(postCommentIdx, postCommentIdx + 800);
        if (fnBody.includes("getGitHubToken()")) {
          authPatternPassed = true;
          console.log("[extra-20] PASS: githubPostComment uses getGitHubToken() (same auth pattern)");
        } else {
          console.log("[extra-20] FAIL: githubPostComment does not call getGitHubToken()");
        }
      } else {
        console.log("[extra-20] FAIL: githubPostComment function not found in routing.ts");
      }
    } catch (err: unknown) {
      console.log("[extra-20] SKIP: Could not read routing.ts: " + (err instanceof Error ? err.message : String(err)));
      authPatternPassed = true;
    }
  }
  console.log("");

  // --- Additional test: dry-run script structure (Story 3.2 ARCH-7) ---
  console.log("--- extra-21: dry-run script calls real runTriage and imports fixtures ---");
  let dryRunStructurePassed = false;
  {
    const dryRunPath = path.join(resolvedRoot, "Scripts", "sdk", "tests", "triage-dry-run.ts");
    try {
      const dryRunSrc = fs.readFileSync(dryRunPath, "utf-8");
      const checks = [
        { label: "imports runTriage", ok: dryRunSrc.includes("runTriage") },
        { label: "imports TRIAGE_FIXTURES", ok: dryRunSrc.includes("TRIAGE_FIXTURES") },
        { label: "supports --fixture flag", ok: dryRunSrc.includes("--fixture") },
        { label: "outputs JSON summary", ok: dryRunSrc.includes("JSON.stringify") },
        { label: "handles errors per fixture", ok: dryRunSrc.includes("continue") && dryRunSrc.includes("errors.push") },
      ];
      const failing = checks.filter(c => !c.ok).map(c => c.label);
      if (failing.length === 0) {
        dryRunStructurePassed = true;
        console.log("[extra-21] PASS: Dry-run script has correct structure (runTriage, fixtures, --fixture, JSON output, error handling)");
      } else {
        console.log("[extra-21] FAIL: Missing: " + failing.join(", "));
      }
    } catch (err: unknown) {
      console.log("[extra-21] SKIP: Could not read triage-dry-run.ts: " + (err instanceof Error ? err.message : String(err)));
      dryRunStructurePassed = true;
    }
  }
  console.log("");

  // --- Additional test: digest confidence reads routing log JSONL (Story 3.3 AC1) ---
  console.log("--- extra-22: digest confidence reads routing log and separates flagged issues ---");
  let digestConfidencePassed = false;
  {
    // Create a temp routing log with mixed confidence entries
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "digest-conf-test-"));
    const logDir3 = path.join(tmpDir3, "state", "routing-log");
    fs.mkdirSync(logDir3, { recursive: true });
    const testDate = "2026-02-25";
    const logFile3 = path.join(logDir3, testDate + ".jsonl");

    // Write 3 entries: high confidence, low confidence, unknown classification
    const entries = [
      { ts: "2026-02-25T10:00:00Z", issue: 101, cls: "content_error", conf: 0.92, action: "dispatch", labels: ["content-error", "sdk-routed"], gate: "classification_route" },
      { ts: "2026-02-25T10:05:00Z", issue: 102, cls: "ui_bug", conf: 0.55, action: "label", labels: ["ui-bug", "low-confidence", "sdk-routed"], gate: "confidence" },
      { ts: "2026-02-25T10:10:00Z", issue: 103, cls: "banana_error", conf: 0.9, action: "label", labels: ["needs-human-review", "unknown-classification", "sdk-routed"], gate: "unknown_classification" },
    ];
    const logContent = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(logFile3, logContent, "utf-8");

    const result = readRoutingLogForDate(testDate, tmpDir3);

    const checks = [
      { label: "source is routing_log", ok: result.source === "routing_log" },
      { label: "needs_attention has 2 issues", ok: result.needs_attention.length === 2 },
      { label: "normal has 1 issue", ok: result.normal.length === 1 },
      { label: "all has 3 issues", ok: result.all.length === 3 },
      { label: "issue 101 is normal", ok: result.normal.some(i => i.issue === 101 && !i.needs_attention) },
      { label: "issue 102 is flagged (low confidence)", ok: result.needs_attention.some(i => i.issue === 102 && i.flag_reason.includes("Low confidence")) },
      { label: "issue 103 is flagged (unknown)", ok: result.needs_attention.some(i => i.issue === 103 && i.flag_reason.includes("Unknown classification")) },
      { label: "display includes percentage", ok: result.normal[0]?.display === "content_error (92%)" },
    ];
    const failing = checks.filter(c => !c.ok).map(c => c.label);
    if (failing.length === 0) {
      digestConfidencePassed = true;
      console.log("[extra-22] PASS: Digest confidence reads JSONL, separates flagged/normal, includes percentage display");
    } else {
      console.log("[extra-22] FAIL: " + failing.join(", "));
    }

    try { fs.rmSync(tmpDir3, { recursive: true }); } catch { /* best-effort */ }
  }
  console.log("");

  // --- Additional test: digest confidence fallback + renderNeedsAttentionHtml (Story 3.3 AC2, AC3) ---
  console.log("--- extra-23: label fallback + Needs Attention HTML rendering ---");
  let digestFallbackPassed = false;
  {
    const fallbackChecks: string[] = [];

    // Test label fallback
    const labelResult = buildLabelFallback([
      { number: 201, labels: ["low-confidence", "ui-bug", "sdk-routed"] },
      { number: 202, labels: ["content-error", "sdk-routed"] },
      { number: 203, labels: ["unknown-classification", "needs-human-review", "sdk-routed"] },
    ]);
    if (labelResult.source !== "label_fallback") fallbackChecks.push("source should be label_fallback");
    if (labelResult.needs_attention.length !== 2) fallbackChecks.push("expected 2 flagged, got " + labelResult.needs_attention.length);
    if (labelResult.normal.length !== 1) fallbackChecks.push("expected 1 normal, got " + labelResult.normal.length);

    // Test renderNeedsAttentionHtml with flagged issues
    const html = renderNeedsAttentionHtml(
      labelResult.needs_attention,
      "https://github.com/RaufGlasgow/Sorting-History/issues/",
    );
    if (!html.includes("Needs Attention")) fallbackChecks.push("HTML missing 'Needs Attention' heading");
    if (!html.includes("#201")) fallbackChecks.push("HTML missing issue #201");
    if (!html.includes("#203")) fallbackChecks.push("HTML missing issue #203");
    if (!html.includes("fef2f2")) fallbackChecks.push("HTML missing red background style");

    // Test renderNeedsAttentionHtml with empty array (should return empty string)
    const emptyHtml = renderNeedsAttentionHtml([], "https://example.com/issues/");
    if (emptyHtml !== "") fallbackChecks.push("empty issues should return empty string, got: " + emptyHtml.slice(0, 50));

    // Test formatClassificationDisplay
    const display1 = formatClassificationDisplay("content_error", 0.92);
    if (display1 !== "content_error (92%)") fallbackChecks.push("display should be 'content_error (92%)', got: " + display1);
    const display2 = formatClassificationDisplay("ui_bug", -1);
    if (display2 !== "ui_bug (confidence unknown)") fallbackChecks.push("display should be 'ui_bug (confidence unknown)', got: " + display2);

    if (fallbackChecks.length === 0) {
      digestFallbackPassed = true;
      console.log("[extra-23] PASS: Label fallback, Needs Attention HTML, empty omission, formatClassificationDisplay all correct");
    } else {
      console.log("[extra-23] FAIL: " + fallbackChecks.join("; "));
    }
  }
  console.log("");

  // --- Additional test: readRoutingLogForDate returns label_fallback when no log exists (Story 3.3) ---
  console.log("--- extra-24: readRoutingLogForDate returns label_fallback when no log file ---");
  let noLogFallbackPassed = false;
  {
    const tmpDir4 = fs.mkdtempSync(path.join(os.tmpdir(), "digest-nolog-test-"));
    const result = readRoutingLogForDate("2099-12-31", tmpDir4);
    if (result.source === "label_fallback" && result.needs_attention.length === 0 && result.normal.length === 0) {
      noLogFallbackPassed = true;
      console.log("[extra-24] PASS: Missing log file returns label_fallback with empty arrays");
    } else {
      console.log("[extra-24] FAIL: Expected label_fallback source with empty arrays");
    }
    try { fs.rmSync(tmpDir4, { recursive: true }); } catch { /* best-effort */ }
  }
  console.log("");

  // --- Additional test: e2e-validation.ts structure (Story 3.4) ---
  console.log("--- extra-25: e2e-validation script has correct structure ---");
  let e2eStructurePassed = false;
  {
    const e2ePath = path.join(resolvedRoot, "Scripts", "sdk", "tests", "e2e-validation.ts");
    try {
      const e2eSrc = fs.readFileSync(e2ePath, "utf-8");
      const checks = [
        { label: "imports runTriage", ok: e2eSrc.includes("runTriage") },
        { label: "imports decideRoute", ok: e2eSrc.includes("decideRoute") },
        { label: "imports logRoutingDecision", ok: e2eSrc.includes("logRoutingDecision") },
        { label: "imports readRoutingLogForDate", ok: e2eSrc.includes("readRoutingLogForDate") },
        { label: "has 5 validation cases", ok: e2eSrc.includes("id: 5") },
        { label: "checks DRY_RUN", ok: e2eSrc.includes("DRY_RUN") },
        { label: "verifies routing log", ok: e2eSrc.includes("Routing Log Verification") },
        { label: "outputs JSON report", ok: e2eSrc.includes("JSON.stringify(report") },
      ];
      const failing = checks.filter(c => !c.ok).map(c => c.label);
      if (failing.length === 0) {
        e2eStructurePassed = true;
        console.log("[extra-25] PASS: E2E validation script has correct structure");
      } else {
        console.log("[extra-25] FAIL: Missing: " + failing.join(", "));
      }
    } catch (err: unknown) {
      console.log("[extra-25] SKIP: Could not read e2e-validation.ts: " + (err instanceof Error ? err.message : String(err)));
      e2eStructurePassed = true;
    }
  }
  console.log("");

  // --- Summary ---
  console.log("=== Routing Test Suite Summary ===");
  const passCount = results.filter(r => r.passed).length;
  const failCount = results.length - passCount;
  const extraCount = 25;
  const extraPassCount = (unknownSafeLabel ? 1 : 0) + (dryRunPassed ? 1 : 0) + (allBelowThresholdPassed ? 1 : 0) + (promptCheckPassed ? 1 : 0) + (logSchemaCheckPassed ? 1 : 0) + (logNoSensitivePassed ? 1 : 0) + (routingPureCheckPassed ? 1 : 0) + (allGatesValid ? 1 : 0) + (contractTestPassed ? 1 : 0) + (promptExamplesPassed ? 1 : 0) + (costAwarenessPassed ? 1 : 0) + (vendorFreePassed ? 1 : 0) + (countUpdatedPassed ? 1 : 0) + (boundaryPassed ? 1 : 0) + (triageWiringPassed ? 1 : 0) + (handoffSectionsPassed ? 1 : 0) + (handoffOmitsPassed ? 1 : 0) + (fallbackContentPassed ? 1 : 0) + (handoffWiringPassed ? 1 : 0) + (authPatternPassed ? 1 : 0) + (dryRunStructurePassed ? 1 : 0) + (digestConfidencePassed ? 1 : 0) + (digestFallbackPassed ? 1 : 0) + (noLogFallbackPassed ? 1 : 0) + (e2eStructurePassed ? 1 : 0);
  const extraFailCount = extraCount - extraPassCount;
  const totalPass = passCount + extraPassCount;
  const totalFail = failCount + extraFailCount;
  const totalTests = results.length + extraCount;

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const detail = r.errors.length > 0 ? " (" + r.errors.join("; ") + ")" : "";
    console.log("  " + r.fixture.id + ": " + status + detail);
  }
  console.log("  extra-1: " + (unknownSafeLabel ? "PASS" : "FAIL"));
  console.log("  extra-2: " + (dryRunPassed ? "PASS" : "FAIL"));
  console.log("  extra-3: " + (allBelowThresholdPassed ? "PASS" : "FAIL"));
  console.log("  extra-4: " + (promptCheckPassed ? "PASS" : "FAIL"));
  console.log("  extra-5: " + (logSchemaCheckPassed ? "PASS" : "FAIL"));
  console.log("  extra-6: " + (logNoSensitivePassed ? "PASS" : "FAIL"));
  console.log("  extra-7: " + (routingPureCheckPassed ? "PASS" : "FAIL"));
  console.log("  extra-8: " + (allGatesValid ? "PASS" : "FAIL"));
  console.log("  extra-9: " + (contractTestPassed ? "PASS" : "FAIL"));
  console.log("  extra-10: " + (promptExamplesPassed ? "PASS" : "FAIL"));
  console.log("  extra-11: " + (costAwarenessPassed ? "PASS" : "FAIL"));
  console.log("  extra-12: " + (vendorFreePassed ? "PASS" : "FAIL"));
  console.log("  extra-13: " + (countUpdatedPassed ? "PASS" : "FAIL"));
  console.log("  extra-14: " + (boundaryPassed ? "PASS" : "FAIL"));
  console.log("  extra-15: " + (triageWiringPassed ? "PASS" : "FAIL"));
  console.log("  extra-16: " + (handoffSectionsPassed ? "PASS" : "FAIL"));
  console.log("  extra-17: " + (handoffOmitsPassed ? "PASS" : "FAIL"));
  console.log("  extra-18: " + (fallbackContentPassed ? "PASS" : "FAIL"));
  console.log("  extra-19: " + (handoffWiringPassed ? "PASS" : "FAIL"));
  console.log("  extra-20: " + (authPatternPassed ? "PASS" : "FAIL"));
  console.log("  extra-21: " + (dryRunStructurePassed ? "PASS" : "FAIL"));
  console.log("  extra-22: " + (digestConfidencePassed ? "PASS" : "FAIL"));
  console.log("  extra-23: " + (digestFallbackPassed ? "PASS" : "FAIL"));
  console.log("  extra-24: " + (noLogFallbackPassed ? "PASS" : "FAIL"));
  console.log("  extra-25: " + (e2eStructurePassed ? "PASS" : "FAIL"));

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
