/**
 * Story 3.5: Tests for smarter triage — signal extraction and enhanced handoff.
 *
 * Tests the signal extraction logic and handoff generation with signals.
 * The actual AI classification tests are validated via triage-dry-run.ts
 * (which calls the Anthropic API against real fixtures).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractTriageSignals } from "../workflows/triage.js";
import { generateTriageHandoff } from "../lib/handoff-generator.js";
import { decideRoute, type RoutingInput, type TriageHandoff } from "../lib/routing.js";

// ---------------------------------------------------------------------------
// Signal extraction tests
// ---------------------------------------------------------------------------

describe("Story 3.5: extractTriageSignals", () => {
  it("finds category name, game mode, and CurrentScreen", () => {
    const body = "I was playing history epic and ancient history card came up\n\nCurrentScreen: BugReportView";
    const signals = extractTriageSignals(body, "Wrong category card");

    assert.ok(
      signals.found.some((s) => s.includes("category_name") && s.includes("ancient history")),
      "Should find 'ancient history' category signal",
    );
    assert.ok(
      signals.found.some((s) => s.includes("game_mode") && s.includes("epic")),
      "Should find 'epic' game mode signal",
    );
    assert.ok(
      signals.found.some((s) => s.includes("current_screen") && s.includes("BugReportView")),
      "Should find CurrentScreen signal",
    );
    assert.ok(signals.suggestedSteps.length > 0, "Should have suggested investigation steps");
  });

  it("finds language/translation signals", () => {
    const body = "The translation looks weird on the daily challenge screen\n\n## Device Info\n- Language: de";
    const signals = extractTriageSignals(body, "Translation issue");

    assert.ok(
      signals.found.some((s) => s.includes("language_signal") && s.includes("translation")),
      "Should find translation language signal",
    );
    assert.ok(
      signals.found.some((s) => s.includes("game_mode") && s.includes("daily challenge")),
      "Should find daily challenge game mode signal",
    );
  });

  it("reports missing signals for truly ambiguous reports", () => {
    const body = "app is broken";
    const signals = extractTriageSignals(body, "App broken");

    // Should have mostly missing signals
    assert.ok(
      signals.missing.some((s) => s.includes("no specific category")),
      "Should report missing category signal",
    );
    assert.ok(
      signals.missing.some((s) => s.includes("no game mode")),
      "Should report missing game mode signal",
    );
    assert.ok(
      signals.missing.some((s) => s.includes("no CurrentScreen")),
      "Should report missing CurrentScreen signal",
    );
  });
});

// ---------------------------------------------------------------------------
// Enhanced handoff generation tests
// ---------------------------------------------------------------------------

describe("Story 3.5: generateTriageHandoff with signals", () => {
  it("includes signals_found and signals_missing in handoff", () => {
    const handoff = generateTriageHandoff({
      issueNumber: 152,
      issueTitle: "Wrong category card",
      issueBody: "I was playing history epic and ancient history card came up",
      classification: "needs_human_review",
      confidence: 0.35,
      severity: "P3",
      reasoning: "Vague report",
      extractedContext: { category: "unknown", file_path: "unknown", event_id: "unknown", expected_behavior: "unknown", actual_behavior: "unknown" },
      signalsFound: ["category_name: ancient history", "game_mode: epic", "current_screen: BugReportView"],
      signalsMissing: ["no specific event title", "no date mentioned", "no error message"],
      suggestedSteps: ["Check if Epic History round includes events from Ancient History category", "Review category assignment for recently added events"],
    });

    // Signals Found section
    assert.ok(handoff.includes("## Signals Found"), "Handoff should have Signals Found section");
    assert.ok(handoff.includes("category_name: ancient history"), "Should include category signal");
    assert.ok(handoff.includes("game_mode: epic"), "Should include game mode signal");

    // Signals Missing section
    assert.ok(handoff.includes("## Signals Missing"), "Handoff should have Signals Missing section");
    assert.ok(handoff.includes("no specific event title"), "Should include missing event title");

    // Suggested Steps section
    assert.ok(handoff.includes("## Suggested Investigation Steps"), "Handoff should have Suggested Steps section");
    assert.ok(handoff.includes("Check if Epic History round"), "Should include investigation step");
  });

  it("omits signals sections when not provided (backward compatible)", () => {
    const handoff = generateTriageHandoff({
      issueNumber: 100,
      issueTitle: "Old style handoff",
      issueBody: "Some bug",
      classification: "needs_human_review",
      confidence: 0.30,
      severity: "P3",
      reasoning: "Unknown",
      extractedContext: { category: "unknown" },
    });

    // Should NOT have signals sections
    assert.ok(!handoff.includes("## Signals Found"), "Should not have Signals Found when not provided");
    assert.ok(!handoff.includes("## Signals Missing"), "Should not have Signals Missing when not provided");
    assert.ok(!handoff.includes("## Suggested Investigation Steps"), "Should not have Suggested Steps when not provided");

    // Should still have basic handoff structure
    assert.ok(handoff.includes("## Classification"), "Should still have Classification section");
    assert.ok(handoff.includes("## Reasoning"), "Should still have Reasoning section");
  });
});

// ---------------------------------------------------------------------------
// Fixture validation tests (static — no API calls)
// ---------------------------------------------------------------------------

describe("Story 3.5: triage fixtures validation", () => {
  it("new fixtures have correct structure", async () => {
    // Dynamic import to handle ESM
    const { TRIAGE_FIXTURES } = await import("./triage-fixtures.js");

    const newFixtures = TRIAGE_FIXTURES.filter((f) =>
      ["test-K", "test-L", "test-M"].includes(f.id),
    );

    assert.equal(newFixtures.length, 3, "Should have 3 new Story 3.5 fixtures");

    for (const fixture of newFixtures) {
      assert.ok(fixture.id, `Fixture should have an id`);
      assert.ok(fixture.report, `Fixture ${fixture.id} should have a report`);
      assert.ok(
        fixture.expected_classification,
        `Fixture ${fixture.id} should have expected_classification`,
      );
      assert.ok(
        fixture.expected_severity_range.length > 0,
        `Fixture ${fixture.id} should have expected_severity_range`,
      );
    }

    // test-K: category + game mode context
    const testK = newFixtures.find((f) => f.id === "test-K")!;
    assert.ok(
      testK.report.includes("ancient history"),
      "test-K should mention ancient history category",
    );
    assert.ok(
      testK.report.includes("CurrentScreen"),
      "test-K should include CurrentScreen field",
    );

    // test-L: sharing context
    const testL = newFixtures.find((f) => f.id === "test-L")!;
    assert.ok(
      testL.report.includes("ShareCardView"),
      "test-L should mention ShareCardView",
    );

    // test-M: translation + language context
    const testM = newFixtures.find((f) => f.id === "test-M")!;
    assert.ok(
      testM.report.includes("translation"),
      "test-M should mention translation",
    );
    assert.ok(
      testM.report.includes("de"),
      "test-M should mention German language code",
    );
  });

  it("all existing fixtures still have valid structure", async () => {
    const { TRIAGE_FIXTURES } = await import("./triage-fixtures.js");

    assert.ok(TRIAGE_FIXTURES.length >= 14, `Should have at least 14 fixtures, got ${TRIAGE_FIXTURES.length}`);

    for (const fixture of TRIAGE_FIXTURES) {
      assert.ok(fixture.id, `Fixture should have an id`);
      assert.ok(fixture.report.length > 0, `Fixture ${fixture.id} should have a non-empty report`);

      const classifications = Array.isArray(fixture.expected_classification)
        ? fixture.expected_classification
        : [fixture.expected_classification];
      assert.ok(classifications.length > 0, `Fixture ${fixture.id} should have at least one expected classification`);

      assert.ok(
        fixture.expected_severity_range.length > 0,
        `Fixture ${fixture.id} should have at least one expected severity`,
      );
    }
  });

  it("test-N fixture is truly ambiguous (no context signals)", async () => {
    const { TRIAGE_FIXTURES } = await import("./triage-fixtures.js");
    const testN = TRIAGE_FIXTURES.find((f) => f.id === "test-N");
    assert.ok(testN, "test-N fixture should exist");
    assert.equal(testN!.expected_classification, "needs_human_review", "test-N should expect needs_human_review");
    assert.ok(!testN!.report.includes("CurrentScreen"), "test-N should NOT have CurrentScreen");
    // Verify no category names in report
    const categories = ["us history", "world history", "european history", "ancient history", "sports history"];
    for (const cat of categories) {
      assert.ok(!testN!.report.toLowerCase().includes(cat), `test-N should not mention ${cat}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Story 3.5: Routing-level triage_handoff tests
// ---------------------------------------------------------------------------

describe("Story 3.5: routing triage_handoff", () => {
  it("needs_human_review at high confidence carries triage_handoff", () => {
    const handoff: TriageHandoff = {
      best_guess_classification: "content_category_error",
      reasoning: "Mentions ancient history in epic mode but vague",
      signals_found: ["category_name: ancient history", "game_mode: epic"],
      signals_missing: ["no specific event title"],
      suggested_steps: ["Check Epic mode category filters"],
      relevant_files: ["Data/Events/AncientHistory.json"],
    };

    const input: RoutingInput = {
      classification: "needs_human_review",
      severity: "P3",
      confidence: 0.75,
      extracted_context: {},
      issue_number: 200,
      triage_handoff: handoff,
    };

    const action = decideRoute(input);
    assert.equal(action.type, "label", "Should route to label action");
    if (action.type === "label") {
      assert.ok(action.labels.includes("needs-human-review"), "Should have needs-human-review label");
      assert.ok(action.triage_handoff, "Should carry triage_handoff");
      assert.equal(action.triage_handoff!.best_guess_classification, "content_category_error");
      assert.equal(action.triage_handoff!.signals_found.length, 2);
      assert.equal(action.triage_handoff!.signals_missing.length, 1);
      assert.equal(action.triage_handoff!.suggested_steps.length, 1);
      assert.equal(action.triage_handoff!.relevant_files.length, 1);
    }
  });

  it("low confidence gate carries triage_handoff through", () => {
    const handoff: TriageHandoff = {
      best_guess_classification: "translation_error",
      reasoning: "Mentions German but very vague",
      signals_found: ["language_signal: german"],
      signals_missing: ["no category", "no screen"],
      suggested_steps: ["Check German translation files"],
      relevant_files: ["Data/Events/*_de.json"],
    };

    const input: RoutingInput = {
      classification: "translation_error",
      severity: "P3",
      confidence: 0.45, // Below 0.70 threshold
      extracted_context: {},
      issue_number: 201,
      triage_handoff: handoff,
    };

    const action = decideRoute(input);
    assert.equal(action.type, "label", "Should route to label (low confidence gate)");
    if (action.type === "label") {
      assert.ok(action.labels.includes("low-confidence"), "Should have low-confidence label");
      assert.ok(action.triage_handoff, "Should carry triage_handoff even through Gate 1");
      assert.equal(action.triage_handoff!.best_guess_classification, "translation_error");
      assert.equal(action.triage_handoff!.signals_found.length, 1);
    }
  });

  it("triage_handoff has all required fields", () => {
    const handoff: TriageHandoff = {
      best_guess_classification: "ui_bug",
      reasoning: "Some reasoning",
      signals_found: [],
      signals_missing: ["no category", "no game mode", "no CurrentScreen"],
      suggested_steps: ["Ask reporter for details"],
      relevant_files: [],
    };

    // Verify the type has all required fields
    assert.equal(typeof handoff.best_guess_classification, "string");
    assert.equal(typeof handoff.reasoning, "string");
    assert.ok(Array.isArray(handoff.signals_found));
    assert.ok(Array.isArray(handoff.signals_missing));
    assert.ok(Array.isArray(handoff.suggested_steps));
    assert.ok(Array.isArray(handoff.relevant_files));
  });

  it("routing without triage_handoff still works (backward compatible)", () => {
    const input: RoutingInput = {
      classification: "needs_human_review",
      severity: "P3",
      confidence: 0.75,
      extracted_context: {},
      issue_number: 202,
      // No triage_handoff
    };

    const action = decideRoute(input);
    assert.equal(action.type, "label");
    if (action.type === "label") {
      assert.ok(action.labels.includes("needs-human-review"));
      assert.equal(action.triage_handoff, undefined, "Should be undefined when not provided");
    }
  });
});
