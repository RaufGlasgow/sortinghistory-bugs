import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runT0StructuralCheck,
  runT9DiacriticsCheck,
  runTranslationAutomatedChecks,
  isLikelyUntranslated,
  countDiacritics,
  validatePortugueseDiacritics,
  type TranslatedEvent,
  type EnglishEvent,
} from "../workflows/translation-verify.js";

/**
 * Story 2.4a: Calibrate Translation Verifier
 *
 * Tests 1-3: Pure unit tests validating fixture structure and automated gate detection.
 * Tests 4-7: Integration tests validating AI verifier results from a calibration run.
 * Tests 8-9: PostToolUse hook tests for Portuguese diacritics protection.
 *
 * Tests 4-7 read pre-recorded calibration results from a results file.
 * The calibration run itself is executed separately and results saved before
 * these tests validate them.
 */

// Resolve SDK root: at runtime __dirname is dist/tests/, so go up to dist/ then up to sdk/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_PATH = path.resolve(
  SDK_ROOT, "tests", "fixtures", "calibration-translation", "calibration-test-set.json",
);
const RESULTS_PATH = path.resolve(
  SDK_ROOT, "tests", "fixtures", "calibration-translation", "calibration-results.json",
);

/** Fixture file structure */
interface CalibrationFixture {
  category: string;
  language: string;
  english_events: EnglishEvent[];
  translated_events: TranslatedEvent[];
  portuguese_diacritics_events: TranslatedEvent[];
  false_positive_whitelist: string[];
}

/** Pre-recorded calibration results */
interface CalibrationResults {
  run_date: string;
  prompt_version: string;
  language: string;
  automated_gates: {
    total_events: number;
    t0_failures: Array<{ id: string; title: string; code: string; details: string }>;
    t9_failures: Array<{ id: string; title: string; code: string; details: string }>;
  };
  ai_results: Array<{
    id: string;
    title: string;
    overall_passed: boolean;
    gates: {
      T1_untranslated: { passed: boolean; code: string | null; details: string };
      T3_factual: { passed: boolean; code: string | null; details: string };
      T5_tone: { passed: boolean; code: string | null; details: string };
    };
  }>;
  calibration_summary: {
    total_events: number;
    good_events: number;
    planted_errors: number;
    errors_caught: number;
    false_positives: number;
    detection_rate: string;
    false_positive_rate: string;
    result: string;
  };
  portuguese_diacritics_test: {
    events_tested: number;
    baseline_density: number;
    hook_rejects_stripped: boolean;
    hook_allows_correct: boolean;
  };
}

/** Load the calibration fixture file */
function loadFixture(): CalibrationFixture {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as CalibrationFixture;
}

/** Load pre-recorded calibration results */
function loadCalibrationResults(): CalibrationResults | null {
  if (!fs.existsSync(RESULTS_PATH)) {
    return null;
  }
  const raw = fs.readFileSync(RESULTS_PATH, "utf-8");
  return JSON.parse(raw) as CalibrationResults;
}

// ---------------------------------------------------------------------------
// Test 1: Fixture structure validation (AC1)
// ---------------------------------------------------------------------------

describe("Story 2.4a: Calibration Translation Verifier", () => {
  it("calibration test set has 10 German events: 5 good, 5 with planted errors", () => {
    const fixture = loadFixture();

    // Must have exactly 10 translated events
    assert.equal(fixture.translated_events.length, 10, "fixture must have exactly 10 translated events");

    // Must have a valid category and language
    assert.equal(fixture.category, "German History", "fixture must use German History category");
    assert.equal(fixture.language, "de", "fixture must target German (de)");

    // Count good vs planted-error events
    const goodEvents = fixture.translated_events.filter(e => !e._planted_error);
    const errorEvents = fixture.translated_events.filter(e => !!e._planted_error);

    assert.equal(goodEvents.length, 5, "must have exactly 5 good translated events");
    assert.equal(errorEvents.length, 5, "must have exactly 5 planted-error translated events");

    // Verify all translated events have required fields
    for (const event of fixture.translated_events) {
      assert.ok(event.title, "event must have title");
      assert.ok(typeof event.year === "number", "event must have numeric year");
      assert.ok(event.description, "event must have description");
      assert.ok(event.category, "event must have category");
      assert.ok(typeof event.difficulty === "number", "event must have numeric difficulty");
      assert.ok(typeof event.baseEnVersion === "number", "translated event must have numeric baseEnVersion");
    }

    // Verify all 10 English source events exist
    assert.equal(fixture.english_events.length, 10, "must have 10 English source events");

    // Verify the 5 planted errors cover the required types (AC1)
    const errorDescriptions = errorEvents.map(e => String(e._planted_error));
    const hasUntranslated = errorDescriptions.some(d => d.includes("UNTRANSLATED"));
    const hasWrongYear = errorDescriptions.some(d => d.includes("WRONG YEAR"));
    const hasStrippedDiacritics = errorDescriptions.some(d => d.includes("STRIPPED DIACRITICS"));
    const hasStaleVersion = errorDescriptions.some(d => d.includes("STALE BASE_EN_VERSION"));
    const hasToneMismatch = errorDescriptions.some(d => d.includes("TONE MISMATCH"));

    assert.ok(hasUntranslated, "must have an untranslated string planted error (T1-T8)");
    assert.ok(hasWrongYear, "must have a wrong year in translation planted error (T1-T8)");
    assert.ok(hasStrippedDiacritics, "must have a stripped diacritics planted error (T9)");
    assert.ok(hasStaleVersion, "must have a stale baseEnVersion planted error (T0)");
    assert.ok(hasToneMismatch, "must have a tone/formality mismatch planted error (T1-T8)");

    // Verify Portuguese diacritics test events exist (AC4)
    assert.ok(
      fixture.portuguese_diacritics_events.length >= 3,
      "must have at least 3 Portuguese diacritics test events (got " +
        fixture.portuguese_diacritics_events.length + ")",
    );
  });

  // ---------------------------------------------------------------------------
  // Test 2: Translation verifier catches untranslated string (AC1)
  // ---------------------------------------------------------------------------

  it("translation verifier catches untranslated string in German event", () => {
    const results = loadCalibrationResults();
    if (!results) {
      assert.fail("Calibration results file not found at " + RESULTS_PATH);
    }

    const untranslatedEvent = results.ai_results.find(
      r => r.id === "cal_trans_error_1",
    );
    assert.ok(untranslatedEvent, "cal_trans_error_1 (untranslated) must be in AI results");
    assert.equal(
      untranslatedEvent.overall_passed, false,
      "Untranslated event must FAIL. Details: " + untranslatedEvent.gates.T1_untranslated.details,
    );
    assert.equal(
      untranslatedEvent.gates.T1_untranslated.passed, false,
      "Untranslated event must fail T1 gate. Details: " + untranslatedEvent.gates.T1_untranslated.details,
    );
    assert.ok(
      untranslatedEvent.gates.T1_untranslated.code === "T1_UNTRANSLATED",
      "Must use code T1_UNTRANSLATED. Got: " + untranslatedEvent.gates.T1_untranslated.code,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 3: Translation verifier catches wrong year (AC1)
  // ---------------------------------------------------------------------------

  it("translation verifier catches wrong year in translation", () => {
    const results = loadCalibrationResults();
    if (!results) {
      assert.fail("Calibration results file not found at " + RESULTS_PATH);
    }

    const wrongYearEvent = results.ai_results.find(
      r => r.id === "cal_trans_error_2",
    );
    assert.ok(wrongYearEvent, "cal_trans_error_2 (wrong year) must be in AI results");
    assert.equal(
      wrongYearEvent.overall_passed, false,
      "Wrong year event must FAIL. Details: " + wrongYearEvent.gates.T3_factual.details,
    );
    assert.equal(
      wrongYearEvent.gates.T3_factual.passed, false,
      "Wrong year event must fail T3 gate. Details: " + wrongYearEvent.gates.T3_factual.details,
    );
    assert.ok(
      wrongYearEvent.gates.T3_factual.code === "T3_WRONG_YEAR",
      "Must use code T3_WRONG_YEAR. Got: " + wrongYearEvent.gates.T3_factual.code,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 4: Translation verifier catches stripped diacritics (AC1)
  // ---------------------------------------------------------------------------

  it("translation verifier catches stripped diacritics in German event", () => {
    const fixture = loadFixture();
    const strippedEvent = fixture.translated_events.find(
      e => e.id === "cal_trans_error_3",
    );
    assert.ok(strippedEvent, "cal_trans_error_3 must exist in fixture");

    // Run T9 automated check
    const t9Result = runT9DiacriticsCheck(strippedEvent!, "German");
    assert.equal(
      t9Result.passed, false,
      "Stripped diacritics event must FAIL T9 gate. Details: " + t9Result.details,
    );
    assert.ok(
      t9Result.code === "T9_STRIPPED",
      "Must use code T9_STRIPPED. Got: " + t9Result.code,
    );

    // Also verify the calibration results recorded it
    const results = loadCalibrationResults();
    if (results) {
      const t9Failure = results.automated_gates.t9_failures.find(
        f => f.id === "cal_trans_error_3",
      );
      assert.ok(t9Failure, "cal_trans_error_3 must appear in t9_failures");
    }
  });

  // ---------------------------------------------------------------------------
  // Test 5: Translation verifier catches stale baseEnVersion (AC1)
  // ---------------------------------------------------------------------------

  it("translation verifier catches stale baseEnVersion", () => {
    const fixture = loadFixture();
    const staleEvent = fixture.translated_events.find(
      e => e.id === "cal_trans_error_4",
    );
    assert.ok(staleEvent, "cal_trans_error_4 must exist in fixture");

    // Find matching English event
    const englishEvent = fixture.english_events.find(
      e => e.id === "de-hist-b2f3604d",
    );
    assert.ok(englishEvent, "Matching English event must exist");

    // Run T0 automated check
    const t0Result = runT0StructuralCheck(staleEvent!, englishEvent!);
    assert.equal(
      t0Result.passed, false,
      "Stale baseEnVersion event must FAIL T0 gate. Details: " + t0Result.details,
    );
    assert.ok(
      t0Result.code === "T0_STALE",
      "Must use code T0_STALE. Got: " + t0Result.code,
    );

    // Verify baseEnVersion < English version
    assert.ok(
      staleEvent!.baseEnVersion < englishEvent!.version,
      "baseEnVersion (" + staleEvent!.baseEnVersion + ") must be less than English version (" + englishEvent!.version + ")",
    );
  });

  // ---------------------------------------------------------------------------
  // Test 6: Translation verifier catches tone/formality mismatch (AC1)
  // ---------------------------------------------------------------------------

  it("translation verifier catches tone/formality mismatch", () => {
    const results = loadCalibrationResults();
    if (!results) {
      assert.fail("Calibration results file not found at " + RESULTS_PATH);
    }

    const toneEvent = results.ai_results.find(
      r => r.id === "cal_trans_error_5",
    );
    assert.ok(toneEvent, "cal_trans_error_5 (tone mismatch) must be in AI results");
    assert.equal(
      toneEvent.overall_passed, false,
      "Tone mismatch event must FAIL. Details: " + toneEvent.gates.T5_tone.details,
    );
    assert.equal(
      toneEvent.gates.T5_tone.passed, false,
      "Tone mismatch event must fail T5 gate. Details: " + toneEvent.gates.T5_tone.details,
    );
    assert.ok(
      toneEvent.gates.T5_tone.code === "T5_TONE",
      "Must use code T5_TONE. Got: " + toneEvent.gates.T5_tone.code,
    );
  });

  // ---------------------------------------------------------------------------
  // Test 7: Translation verifier does not flag identical-across-languages words (AC2)
  // ---------------------------------------------------------------------------

  it("translation verifier does not flag identical-across-languages words", () => {
    const results = loadCalibrationResults();
    if (!results) {
      assert.fail("Calibration results file not found at " + RESULTS_PATH);
    }

    // Check that good events with proper nouns like "Martin Luther" are not flagged
    const lutherEvent = results.ai_results.find(
      r => r.id === "cal_trans_good_5",
    );
    assert.ok(lutherEvent, "cal_trans_good_5 (Martin Luther) must be in AI results");
    assert.equal(
      lutherEvent.overall_passed, true,
      "Event with 'Martin Luther' in title must PASS (proper noun, not untranslated). " +
        "T1: " + lutherEvent.gates.T1_untranslated.details,
    );

    // Verify all 5 good events passed (AC2: max 1 false positive)
    const goodEventIds = [
      "cal_trans_good_1", "cal_trans_good_2", "cal_trans_good_3",
      "cal_trans_good_4", "cal_trans_good_5",
    ];
    let falsePositives = 0;
    const falsePositiveDetails: string[] = [];

    for (const id of goodEventIds) {
      const eventResult = results.ai_results.find(r => r.id === id);
      if (eventResult && !eventResult.overall_passed) {
        falsePositives++;
        falsePositiveDetails.push(
          "'" + eventResult.title + "' (id=" + id + ") falsely flagged",
        );
      }
    }

    assert.ok(
      falsePositives <= 1,
      "False positive rate must be < 20% (max 1 of 5 good events flagged). " +
        "Got " + falsePositives + " false positives: " + falsePositiveDetails.join(". "),
    );

    // Also test the isLikelyUntranslated function with whitelisted terms
    const fixture = loadFixture();
    const whitelist = new Set(fixture.false_positive_whitelist);

    // Event with "Martin Luther" in title - proper noun, should NOT be flagged
    const goodLutherTranslated = fixture.translated_events.find(e => e.id === "cal_trans_good_5");
    const goodLutherEnglish = fixture.english_events.find(e => e.id === "de-hist-86b2bb05");
    assert.ok(goodLutherTranslated && goodLutherEnglish);

    // Title is different (German vs English), so isLikelyUntranslated should be false
    const isUntranslated = isLikelyUntranslated(goodLutherTranslated!, goodLutherEnglish!, whitelist);
    assert.equal(
      isUntranslated, false,
      "Good German event with 'Martin Luther' should NOT be flagged as untranslated",
    );
  });

  // ---------------------------------------------------------------------------
  // Test 8: PostToolUse hook rejects write that strips Portuguese diacritics (AC4)
  // ---------------------------------------------------------------------------

  it("PostToolUse hook rejects write that strips Portuguese diacritics", () => {
    const fixture = loadFixture();

    // Get Portuguese events with proper diacritics
    const ptEvents = fixture.portuguese_diacritics_events;
    assert.ok(ptEvents.length >= 3, "Need at least 3 Portuguese events");

    // Concatenate all Portuguese text to get baseline
    const correctText = ptEvents.map(e => e.title + " " + e.description).join(" ");
    const baselineResult = validatePortugueseDiacritics(correctText);
    assert.ok(
      baselineResult.passed,
      "Correct Portuguese text must pass diacritics validation. " + baselineResult.details,
    );
    assert.ok(
      baselineResult.density > 0.02,
      "Portuguese text should have > 2% diacritics density. Got: " +
        (baselineResult.density * 100).toFixed(2) + "%",
    );

    // Simulate stripped diacritics (replace accented chars with ASCII)
    const strippedText = correctText
      .replace(/\u00e3/g, "a")  // a-tilde -> a
      .replace(/\u00e7/g, "c")  // c-cedilla -> c
      .replace(/\u00e9/g, "e")  // e-acute -> e
      .replace(/\u00ed/g, "i")  // i-acute -> i
      .replace(/\u00f3/g, "o")  // o-acute -> o
      .replace(/\u00ea/g, "e")  // e-circumflex -> e
      .replace(/\u00e1/g, "a")  // a-acute -> a
      .replace(/\u00f4/g, "o")  // o-circumflex -> o
      .replace(/\u00fa/g, "u")  // u-acute -> u
      .replace(/\u00e2/g, "a")  // a-circumflex -> a
      .replace(/\u00f5/g, "o")  // o-tilde -> o
      .replace(/\u00ee/g, "i"); // i-circumflex -> i

    const strippedResult = validatePortugueseDiacritics(
      strippedText,
      baselineResult.density,
    );
    assert.equal(
      strippedResult.passed, false,
      "Stripped Portuguese text must FAIL diacritics validation. " + strippedResult.details,
    );

    // Verify the density actually decreased significantly
    assert.ok(
      strippedResult.density < baselineResult.density * 0.5,
      "Stripped density (" + (strippedResult.density * 100).toFixed(2) +
        "%) should be less than 50% of baseline (" +
        (baselineResult.density * 100).toFixed(2) + "%)",
    );
  });

  // ---------------------------------------------------------------------------
  // Test 9: PostToolUse hook allows write that preserves Portuguese diacritics (AC4)
  // ---------------------------------------------------------------------------

  it("PostToolUse hook allows write that preserves Portuguese diacritics", () => {
    const fixture = loadFixture();
    const ptEvents = fixture.portuguese_diacritics_events;

    // Correct Portuguese text (unchanged)
    const correctText = ptEvents.map(e => e.title + " " + e.description).join(" ");
    const result = validatePortugueseDiacritics(correctText);

    assert.equal(
      result.passed, true,
      "Correct Portuguese text must PASS diacritics validation. " + result.details,
    );

    // Also test with slightly modified but still correct text (minor edits that preserve diacritics)
    const slightlyModified = correctText.replace("Medieval", "No per\u00edodo medieval");
    const modifiedResult = validatePortugueseDiacritics(slightlyModified);

    assert.equal(
      modifiedResult.passed, true,
      "Slightly modified Portuguese text with preserved diacritics must PASS. " + modifiedResult.details,
    );

    // Verify diacritics count is reasonable
    assert.ok(
      result.diacriticsCount > 10,
      "Portuguese test text should have significant diacritics (got " + result.diacriticsCount + ")",
    );
  });
});
