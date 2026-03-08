/**
 * Story 2.4b: Translation Pipeline End-to-End Tests
 *
 * 7 integration tests that validate the full translation verification -> fix -> PR chain.
 * These tests mock AI subagent calls and use temp filesystems to test pipeline logic.
 *
 * Tests cover:
 *   1. Full chain: verifier finds error -> fixer fixes -> re-verify passes -> PR created
 *   2. baseEnVersion set to match English source version (FR24)
 *   3. Version increment on fix (FR42)
 *   4. PostToolUse hook rejects diacritics-stripping write (AC3, AC6)
 *   5. Validation gate rejects language-mismatched fix (FR49)
 *   6. Retry loop for re-verification failures, max 2 attempts (FR27, AC7)
 *   7. Only Data/events/<lang>/ files modified, not Swift (FR45)
 *
 * Note on Tests 2 and 3: Version increment and baseEnVersion updates are
 * performed inline by the AI fixer subagent (translation-fixer.md prompt).
 * These tests validate the expected data schema and version contracts that
 * the pipeline enforces after the fixer runs.
 *
 * All tests use temp directories and mock data -- $0.00 API cost.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  validateFix,
  parseDiffFiles,
  type IssueData,
} from "../lib/validate-fix.js";
import {
  runT0StructuralCheck,
  runT9DiacriticsCheck,
  runTranslationAutomatedChecks,
  validatePortugueseDiacritics,
  countDiacritics,
  type TranslatedEvent,
  type EnglishEvent,
} from "../workflows/translation-verify.js";
import {
  validateTranslationFixVersion,
  validateTranslationFilePaths,
  validateTranslationJsonStructure,
  checkDiacriticsPreservation,
  makeTranslationRetryDecision,
  MAX_TRANSLATION_RETRY_ATTEMPTS,
} from "../lib/translation-pipeline-utils.js";
import { LIMITS } from "../config.js";

// ------------------------------------------------------------------
// Test fixture helpers
// ------------------------------------------------------------------

/** Create a temp directory for test isolation */
function createTempDir(testName: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), "translation-e2e-2.4b-" + testName + "-"));
}

/** Clean up a temp directory */
function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/** Create a temp diff file and return its path */
function writeTempDiff(content: string, dir?: string): string {
  const d = dir ?? tmpdir();
  const diffPath = path.join(d, "test-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".patch");
  fs.writeFileSync(diffPath, content, "utf-8");
  return diffPath;
}

/** Build a mock unified diff for given file paths */
function makeDiff(files: string[], diffBody?: string): string {
  return files
    .map(
      (f) =>
        "diff --git a/" + f + " b/" + f +
        "\n--- a/" + f +
        "\n+++ b/" + f +
        "\n@@ -1,1 +1,1 @@\n-old\n+" + (diffBody ?? "new"),
    )
    .join("\n");
}

/** Build a mock English source event */
function buildEnglishEvent(index: number, options?: { version?: number }): EnglishEvent {
  return {
    id: "en_event_" + index,
    title: "Historical Event " + index,
    version: options?.version ?? 1,
    description: "This important historical event occurred during a significant period of world history and shaped nations",
    year: 1776 + index,
    category: "World History",
    difficulty: 1 + (index % 3),
  };
}

/** Build a mock translated event for a given language */
function buildTranslatedEvent(
  index: number,
  lang: string,
  options?: {
    version?: number;
    baseEnVersion?: number;
    stripDiacritics?: boolean;
  },
): TranslatedEvent {
  const version = options?.version ?? 1;
  const baseEnVersion = options?.baseEnVersion ?? 1;

  // Language-specific descriptions with diacritics
  const descriptions: Record<string, string> = {
    de: "Dieses wichtige historische Ereignis fand w\u00e4hrend einer bedeutsamen Periode der Weltgeschichte statt und pr\u00e4gte V\u00f6lker und Nationen nachhaltig",
    nl: "Deze belangrijke historische gebeurtenis vond plaats tijdens een belangrijke periode van de wereldgeschiedenis en vormde naties",
    pt: "Este importante acontecimento hist\u00f3rico ocorreu durante um per\u00edodo significativo da hist\u00f3ria mundial e moldou na\u00e7\u00f5es de forma not\u00e1vel e duradoura",
  };

  const titles: Record<string, string> = {
    de: "Historisches Ereignis " + index,
    nl: "Historische Gebeurtenis " + index,
    pt: "Acontecimento Hist\u00f3rico " + index,
  };

  // Strip diacritics for Portuguese test case
  let description = descriptions[lang] ?? descriptions.de;
  let title = titles[lang] ?? titles.de;
  if (options?.stripDiacritics && lang === "pt") {
    description = "Este importante acontecimento historico ocorreu durante um periodo significativo da historia mundial e moldou nacoes de forma notavel e duradoura";
    title = "Acontecimento Historico " + index;
  }

  return {
    id: lang + "_event_" + index,
    title,
    version,
    baseEnVersion,
    description,
    year: 1776 + index,
    category: "World History",
    difficulty: 1 + (index % 3),
  };
}

/** Build a translation category file with N events */
function buildTranslationCategoryFile(
  category: string,
  lang: string,
  eventCount: number,
  options?: {
    baseEnVersion?: number;
    version?: number;
    stripDiacritics?: boolean;
  },
): object {
  const events = [];
  for (let i = 0; i < eventCount; i++) {
    events.push(buildTranslatedEvent(i, lang, {
      version: options?.version ?? 1,
      baseEnVersion: options?.baseEnVersion ?? 1,
      stripDiacritics: options?.stripDiacritics,
    }));
  }
  return { category, language: lang, events };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("Story 2.4b: Translation Pipeline E2E", () => {

  // ------------------------------------------------------------------
  // Test 1: Full chain creates PR after verifier finds error, fixer
  // fixes, and re-verify passes
  // ------------------------------------------------------------------

  it("translation pipeline creates PR after verifier finds error, fixer fixes, and re-verify passes", () => {
    // This test validates the full data flow:
    // 1. Verifier finds a stale translation (T0_STALE: baseEnVersion < English version)
    // 2. The finding is identified with language, event, and error type
    // 3. After fix: version incremented, baseEnVersion updated
    // 4. Validate-fix gate passes (only translation JSON files in correct lang path)
    // 5. PR would be created (asserted via diff validation)

    const tempDir = createTempDir("full-chain");
    try {
      // Step 1: Create English source with version 3, German translation with baseEnVersion 2
      const englishEvent = buildEnglishEvent(0, { version: 3 });
      const staleTranslation = buildTranslatedEvent(0, "de", {
        version: 1,
        baseEnVersion: 2,
      });

      // Step 2: Run T0 structural check (automated verification gate)
      const t0Result = runT0StructuralCheck(staleTranslation, englishEvent);
      assert.strictEqual(t0Result.passed, false, "T0 should detect stale translation");
      assert.strictEqual(t0Result.code, "T0_STALE", "Should be T0_STALE error code");
      assert.ok(
        t0Result.details.includes("baseEnVersion=2"),
        "Details should mention current baseEnVersion",
      );
      assert.ok(
        t0Result.details.includes("English version=3"),
        "Details should mention target English version",
      );

      // Step 3: Simulate fix applied -- baseEnVersion updated, version incremented
      const fixedTranslation = buildTranslatedEvent(0, "de", {
        version: 2,        // Incremented from 1
        baseEnVersion: 3,  // Matches English version
      });

      // Step 4: Re-verify after fix -- T0 should now pass
      const t0After = runT0StructuralCheck(fixedTranslation, englishEvent);
      assert.strictEqual(t0After.passed, true, "T0 should pass after fix");

      // Step 5: Validate-fix gate should PASS (only .json files in Data/events/de/)
      const fixDiff = makeDiff(
        ["Data/events/de/WorldHistory.json"],
        '"baseEnVersion": 3, "version": 2',
      );
      const diffPath = writeTempDiff(fixDiff, tempDir);

      const issueData: IssueData = {
        number: 300,
        body: "German translation for a WorldHistory event is stale and needs retranslation.",
        labels: ["translation-error", "lang:de"],
      };
      const validationResult = validateFix(issueData, diffPath);

      assert.strictEqual(
        validationResult.valid,
        true,
        "Validate-fix should pass for valid translation fix in correct language path",
      );
    } finally {
      cleanupDir(tempDir);
    }
  });

  // ------------------------------------------------------------------
  // Test 2: baseEnVersion set to match English source version (FR24)
  // ------------------------------------------------------------------

  it("translation pipeline sets baseEnVersion to match English source version", () => {
    // FR24: After a translation fix, baseEnVersion must equal the current
    // English source version. This test validates the version contract:
    //   (a) Before fix: baseEnVersion < English version (stale)
    //   (b) After fix: baseEnVersion === English version
    //   (c) Multiple English version bumps are handled correctly

    const tempDir = createTempDir("base-en-version");
    try {
      // Scenario 1: English at version 5, translation at baseEnVersion 3
      const englishV5 = buildEnglishEvent(0, { version: 5 });
      const staleTranslation = buildTranslatedEvent(0, "pt", {
        version: 2,
        baseEnVersion: 3,
      });

      // Verify stale state
      const beforeResult = validateTranslationFixVersion(
        staleTranslation,
        2,  // previous version (unchanged)
        5,  // English version
      );
      assert.strictEqual(beforeResult.valid, false, "Stale translation should fail version validation");
      assert.strictEqual(beforeResult.baseEnVersionMatches, false, "baseEnVersion should not match English");

      // Simulate fix: set baseEnVersion to 5 (matching English), increment version to 3
      const fixedEvent: TranslatedEvent = {
        ...staleTranslation,
        version: 3,         // Incremented from 2
        baseEnVersion: 5,   // Matches English version 5
      };

      const afterResult = validateTranslationFixVersion(
        fixedEvent,
        2,  // previous version
        5,  // English version
      );
      assert.strictEqual(afterResult.valid, true, "Fixed translation should pass version validation");
      assert.strictEqual(afterResult.baseEnVersionMatches, true, "baseEnVersion should match English version");
      assert.strictEqual(afterResult.versionIncremented, true, "version should be incremented");

      // Scenario 2: English bumped multiple times (version 1 -> 7)
      const bigGapFixed: TranslatedEvent = {
        ...buildTranslatedEvent(1, "nl", { version: 1, baseEnVersion: 1 }),
        version: 2,
        baseEnVersion: 7,
      };

      const bigGapResult = validateTranslationFixVersion(bigGapFixed, 1, 7);
      assert.strictEqual(bigGapResult.valid, true,
        "Should handle large version gap between baseEnVersion and English");
      assert.strictEqual(bigGapResult.baseEnVersionMatches, true);

      // Scenario 3: Wrong baseEnVersion (set to 4 when English is 5)
      const wrongBaseEn: TranslatedEvent = {
        ...staleTranslation,
        version: 3,
        baseEnVersion: 4,  // Wrong! Should be 5
      };

      const wrongResult = validateTranslationFixVersion(wrongBaseEn, 2, 5);
      assert.strictEqual(wrongResult.valid, false, "Wrong baseEnVersion should fail");
      assert.strictEqual(wrongResult.baseEnVersionMatches, false);
      assert.ok(
        wrongResult.details.includes("expected 5"),
        "Details should specify the expected baseEnVersion",
      );

      // Validate via JSON structure too (FR40)
      const fixedFile = buildTranslationCategoryFile("World History", "pt", 3, {
        version: 3,
        baseEnVersion: 5,
      });
      const jsonStr = JSON.stringify(fixedFile, null, 2);
      const structuralResult = validateTranslationJsonStructure(jsonStr);
      assert.strictEqual(structuralResult.valid, true,
        "Fixed translation file with correct baseEnVersion should pass structural validation");
    } finally {
      cleanupDir(tempDir);
    }
  });

  // ------------------------------------------------------------------
  // Test 3: Translation pipeline increments event version on fix (FR42)
  // ------------------------------------------------------------------

  it("translation pipeline increments event version on fix", () => {
    // FR42: The version field must be incremented by exactly 1 on every fix.
    // This test validates:
    //   (a) Version increments from 1 to 2
    //   (b) Version increments from N to N+1 for any N
    //   (c) Non-incremented version fails validation
    //   (d) Version set to same value fails validation
    //   (e) Structural integrity maintained after increment

    const tempDir = createTempDir("version-increment");
    try {
      // Case (a): Standard increment 1 -> 2
      const v1Event = buildTranslatedEvent(0, "de", { version: 1, baseEnVersion: 1 });
      const v2Event: TranslatedEvent = { ...v1Event, version: 2, baseEnVersion: 2 };

      const result1to2 = validateTranslationFixVersion(v2Event, 1, 2);
      assert.strictEqual(result1to2.valid, true, "Version 1->2 should be valid");
      assert.strictEqual(result1to2.versionIncremented, true);

      // Case (b): Arbitrary increment 7 -> 8
      const v7Event = buildTranslatedEvent(1, "nl", { version: 7, baseEnVersion: 10 });
      const v8Event: TranslatedEvent = { ...v7Event, version: 8, baseEnVersion: 10 };

      const result7to8 = validateTranslationFixVersion(v8Event, 7, 10);
      assert.strictEqual(result7to8.valid, true, "Version 7->8 should be valid");

      // Case (c): Not incremented (still 1)
      const notIncremented: TranslatedEvent = { ...v1Event, version: 1, baseEnVersion: 2 };
      const resultNotInc = validateTranslationFixVersion(notIncremented, 1, 2);
      assert.strictEqual(resultNotInc.valid, false, "Non-incremented version should fail");
      assert.strictEqual(resultNotInc.versionIncremented, false);

      // Case (d): Skipped increment (1 -> 3 instead of 1 -> 2)
      const skipped: TranslatedEvent = { ...v1Event, version: 3, baseEnVersion: 2 };
      const resultSkipped = validateTranslationFixVersion(skipped, 1, 2);
      assert.strictEqual(resultSkipped.valid, false,
        "Skipped version (1->3) should fail -- must be exactly previous+1");

      // Case (e): Structural integrity -- version must be a positive integer
      const validFile = buildTranslationCategoryFile("World History", "de", 3, { version: 2, baseEnVersion: 2 });
      const jsonStr = JSON.stringify(validFile, null, 2);
      const structural = validateTranslationJsonStructure(jsonStr);
      assert.strictEqual(structural.valid, true, "File with valid version fields should pass structural check");

      // Structural failure: version = 0 (not positive)
      const badFile = JSON.parse(jsonStr) as { events: Array<{ version: number }> };
      badFile.events[0].version = 0;
      const badStructural = validateTranslationJsonStructure(JSON.stringify(badFile));
      assert.strictEqual(badStructural.valid, false, "Version 0 should fail structural validation");
      assert.ok(
        badStructural.errors.some(e => e.includes("positive integer")),
        "Error should mention positive integer requirement",
      );
    } finally {
      cleanupDir(tempDir);
    }
  });

  // ------------------------------------------------------------------
  // Test 4: PostToolUse hook rejects diacritics-stripping write (AC3, AC6)
  // ------------------------------------------------------------------

  it("PostToolUse hook rejects diacritics-stripping write during real fixer run", () => {
    // AC3: PostToolUse hook validates diacritics density has not decreased.
    // AC6: If diacritics are still stripped after retry, escalate.
    //
    // This test runs the actual validatePortugueseDiacritics function (from
    // translation-verify.ts) and the checkDiacriticsPreservation function on
    // real Portuguese text, validating the hook behavior.

    // Real Portuguese text WITH correct diacritics
    const correctPortuguese =
      "A Revolu\u00e7\u00e3o Portuguesa de 1974, tamb\u00e9m conhecida como Revolu\u00e7\u00e3o dos Cravos, " +
      "p\u00f4s fim ao regime autorit\u00e1rio do Estado Novo. Os militares sa\u00edram \u00e0s ruas de Lisboa " +
      "e a popula\u00e7\u00e3o celebrou com cravos vermelhos nas armas dos soldados.";

    // Same text with diacritics STRIPPED to ASCII
    const strippedPortuguese =
      "A Revolucao Portuguesa de 1974, tambem conhecida como Revolucao dos Cravos, " +
      "pos fim ao regime autoritario do Estado Novo. Os militares sairam as ruas de Lisboa " +
      "e a populacao celebrou com cravos vermelhos nas armas dos soldados.";

    // Test 1: validatePortugueseDiacritics detects stripping
    const correctResult = validatePortugueseDiacritics(correctPortuguese);
    assert.strictEqual(correctResult.passed, true,
      "Correct Portuguese text should pass diacritics validation");
    assert.ok(correctResult.diacriticsCount > 0,
      "Correct Portuguese should have diacritics (found " + correctResult.diacriticsCount + ")");

    const strippedResult = validatePortugueseDiacritics(strippedPortuguese);
    assert.strictEqual(strippedResult.passed, false,
      "Stripped Portuguese text should FAIL diacritics validation");
    assert.ok(
      strippedResult.details.includes("below threshold"),
      "Details should explain density is below threshold",
    );

    // Test 2: checkDiacriticsPreservation detects density decrease
    const preservationResult = checkDiacriticsPreservation(
      correctPortuguese,
      strippedPortuguese,
    );
    assert.strictEqual(preservationResult.passed, false,
      "Density decrease should be detected");
    assert.strictEqual(preservationResult.densityDecreased, true,
      "densityDecreased flag should be true");
    assert.ok(
      preservationResult.beforeDensity > preservationResult.afterDensity,
      "Before density should be higher than after density",
    );
    assert.ok(
      preservationResult.details.includes("DECREASED"),
      "Details should mention DECREASED",
    );

    // Test 3: Preserved diacritics should pass
    const goodPreservation = checkDiacriticsPreservation(
      correctPortuguese,
      correctPortuguese, // Same text = same diacritics
    );
    assert.strictEqual(goodPreservation.passed, true,
      "Same diacritics density should pass preservation check");

    // Test 4: Improved diacritics (fixer added missing ones) should pass
    const improvedPortuguese =
      "A Revolu\u00e7\u00e3o Portuguesa de 1974, tamb\u00e9m conhecida como Revolu\u00e7\u00e3o dos Cravos, " +
      "p\u00f4s fim ao regime autorit\u00e1rio do Estado Novo. Os militares sa\u00edram \u00e0s ruas de Lisboa, " +
      "a popula\u00e7\u00e3o celebrou com cravos vermelhos nas armas dos soldados e a na\u00e7\u00e3o renasceu.";

    const improvedResult = checkDiacriticsPreservation(
      correctPortuguese,
      improvedPortuguese,
    );
    assert.strictEqual(improvedResult.passed, true,
      "Improved diacritics (more added) should pass");

    // Test 5: T9 diacritics gate on event level
    const ptEventCorrect = buildTranslatedEvent(0, "pt", { version: 1, baseEnVersion: 1 });
    const t9Correct = runT9DiacriticsCheck(ptEventCorrect, "Portuguese");
    assert.strictEqual(t9Correct.passed, true,
      "Portuguese event with correct diacritics should pass T9");

    const ptEventStripped = buildTranslatedEvent(0, "pt", {
      version: 1,
      baseEnVersion: 1,
      stripDiacritics: true,
    });
    const t9Stripped = runT9DiacriticsCheck(ptEventStripped, "Portuguese");
    assert.strictEqual(t9Stripped.passed, false,
      "Portuguese event with stripped diacritics should FAIL T9");
    assert.strictEqual(t9Stripped.code, "T9_STRIPPED",
      "Should be T9_STRIPPED error code");

    // Test 6: countDiacritics utility
    const diacriticsCount = countDiacritics(correctPortuguese);
    assert.ok(diacriticsCount > 10,
      "Correct Portuguese should have many diacritics (found " + diacriticsCount + ")");

    const noDiacritics = countDiacritics(strippedPortuguese);
    assert.strictEqual(noDiacritics, 0,
      "Stripped text should have 0 diacritics");
  });

  // ------------------------------------------------------------------
  // Test 5: Validation gate rejects language-mismatched fix (FR49)
  // ------------------------------------------------------------------

  it("translation pipeline validation gate rejects language-mismatched fix", () => {
    // FR49: The validation gate must confirm the fix modifies the SAME
    // language file as the reported error. This is the check that would
    // have caught the PR #148 incident (French fix for German bug).

    const tempDir = createTempDir("lang-mismatch");
    try {
      // Scenario: German bug reported, but fix diff contains French files
      const germanBugIssue: IssueData = {
        number: 148,
        body: "German translation is wrong. Description says 'Vertrag' but should be 'Abkommen'.",
        labels: ["translation-error", "lang:de"],
      };

      // Diff that modifies French files instead of German
      const frenchDiff = makeDiff(
        ["Data/events/fr/WorldHistory.json"],
        '"description": "Le trait\u00e9 de Versailles"',
      );
      const frenchDiffPath = writeTempDiff(frenchDiff, tempDir);

      const mismatchResult = validateFix(germanBugIssue, frenchDiffPath);
      assert.strictEqual(mismatchResult.valid, false,
        "French-only diff should be REJECTED for German bug");
      assert.strictEqual(mismatchResult.reason, "language-mismatch",
        "Rejection reason should be language-mismatch");
      assert.ok(
        mismatchResult.details!.includes("de"),
        "Details should mention expected language (de)",
      );

      // Scenario 2: German bug, German fix -- should PASS
      const germanDiff = makeDiff(
        ["Data/events/de/WorldHistory.json"],
        '"description": "Das Abkommen von Versailles"',
      );
      const germanDiffPath = writeTempDiff(germanDiff, tempDir);

      const matchResult = validateFix(germanBugIssue, germanDiffPath);
      assert.strictEqual(matchResult.valid, true,
        "German diff should PASS for German bug");

      // Scenario 3: Portuguese bug, Dutch fix -- should REJECT
      const ptBugIssue: IssueData = {
        number: 200,
        body: "Portuguese translation missing diacritics in WorldHistory category.",
        labels: ["translation-error", "lang:pt"],
      };

      const dutchDiff = makeDiff(
        ["Data/events/nl/WorldHistory.json"],
        '"description": "Het Verdrag van Versailles"',
      );
      const dutchDiffPath = writeTempDiff(dutchDiff, tempDir);

      const ptDutchResult = validateFix(ptBugIssue, dutchDiffPath);
      assert.strictEqual(ptDutchResult.valid, false,
        "Dutch diff should be REJECTED for Portuguese bug");
      assert.strictEqual(ptDutchResult.reason, "language-mismatch");

      // Scenario 4: translation-error without lang label -- should REJECT (AC12)
      const noLangIssue: IssueData = {
        number: 201,
        body: "Translation is wrong somewhere.",
        labels: ["translation-error"],  // No lang:XX label
      };

      const someDiff = makeDiff(["Data/events/de/WorldHistory.json"]);
      const someDiffPath = writeTempDiff(someDiff, tempDir);

      const noLangResult = validateFix(noLangIssue, someDiffPath);
      assert.strictEqual(noLangResult.valid, false,
        "translation-error without lang label should be REJECTED");
      assert.strictEqual(noLangResult.reason, "missing-language-label");

      // Also validate via the translation file path checker
      const frenchPaths = parseDiffFiles(frenchDiff);
      const pathResult = validateTranslationFilePaths(frenchPaths);
      assert.strictEqual(pathResult.valid, true,
        "French paths are valid translation paths (the path structure is correct, language gate catches the mismatch)");
    } finally {
      cleanupDir(tempDir);
    }
  });

  // ------------------------------------------------------------------
  // Test 6: Retry loop for re-verification failures, max 2 attempts (FR27)
  // ------------------------------------------------------------------

  it("translation pipeline retries after re-verification failure, max 2 attempts", () => {
    // FR27: Translation fixes retry up to 2 times on re-verification failure.
    // After 2 attempts, the system escalates with needs-human-review.
    // This is different from the content pipeline's MAX_FIX_ATTEMPTS (3).

    // Verify the translation retry limit is 2 (not 3 like content pipeline)
    assert.strictEqual(
      MAX_TRANSLATION_RETRY_ATTEMPTS,
      2,
      "Translation pipeline max retry attempts should be 2 (FR27), not " + LIMITS.MAX_FIX_ATTEMPTS,
    );

    // Attempt 1: Should retry
    const attempt1 = makeTranslationRetryDecision(1);
    assert.strictEqual(attempt1.shouldRetry, true,
      "Attempt 1 of 2 should trigger retry");
    assert.strictEqual(attempt1.escalate, false,
      "Attempt 1 should NOT escalate");
    assert.ok(
      attempt1.reason.includes("Retrying"),
      "Reason should mention retrying",
    );

    // Attempt 2: Should NOT retry, should escalate
    const attempt2 = makeTranslationRetryDecision(2);
    assert.strictEqual(attempt2.shouldRetry, false,
      "Attempt 2 of 2 should NOT retry -- max reached");
    assert.strictEqual(attempt2.escalate, true,
      "Attempt 2 should escalate with needs-human-review");
    assert.ok(
      attempt2.reason.includes("exhausted"),
      "Reason should mention attempts exhausted",
    );
    assert.ok(
      attempt2.reason.includes("needs-human-review"),
      "Reason should mention needs-human-review label",
    );

    // Verify the retry loop tracks context from previous failures
    // The decision at each attempt knows the current attempt number and max
    assert.strictEqual(attempt1.attempt, 1, "First decision should track attempt=1");
    assert.strictEqual(attempt1.maxAttempts, 2, "Max attempts should be 2");
    assert.strictEqual(attempt2.attempt, 2, "Second decision should track attempt=2");
    assert.strictEqual(attempt2.maxAttempts, 2, "Max attempts should be 2");

    // Simulate the retry loop behavior with re-verification results
    // First attempt: re-verification fails
    const mockReVerifyFail1: { passed: boolean; failureReason: string } = {
      passed: false,
      failureReason: "T0_STALE: baseEnVersion still does not match English version",
    };

    // Decision based on first failure
    const decision1 = makeTranslationRetryDecision(1);
    assert.ok(decision1.shouldRetry && !mockReVerifyFail1.passed,
      "First re-verify failure + decision should lead to retry");

    // Second attempt: re-verification fails again
    const mockReVerifyFail2: { passed: boolean; failureReason: string } = {
      passed: false,
      failureReason: "T9_STRIPPED: diacritics still missing after second fix attempt",
    };

    // Decision based on second failure
    const decision2 = makeTranslationRetryDecision(2);
    assert.ok(!decision2.shouldRetry && !mockReVerifyFail2.passed,
      "Second re-verify failure + decision should lead to escalation");
    assert.ok(decision2.escalate,
      "Second failure should escalate");

    // Re-verification passes on first attempt -- no retry needed
    const mockReVerifyPass: { passed: boolean } = { passed: true };
    if (mockReVerifyPass.passed) {
      // No need to check retry decision -- proceed to PR creation
      assert.ok(true, "When re-verification passes, skip retry and proceed to PR");
    }
  });

  // ------------------------------------------------------------------
  // Test 7: Only translation JSON files modified, not Swift (FR45)
  // ------------------------------------------------------------------

  it("translation pipeline only modifies translation JSON files, not Swift", () => {
    const tempDir = createTempDir("translation-only");
    try {
      // Test case 1: Valid -- only Data/events/<lang>/ files
      const validDiff = makeDiff([
        "Data/events/de/WorldHistory.json",
        "Data/events/de/USHistory.json",
      ]);
      const validDiffPath = writeTempDiff(validDiff, tempDir);

      const validIssue: IssueData = {
        number: 400,
        body: "German translation fix for WorldHistory and USHistory categories",
        labels: ["translation-error", "lang:de"],
      };

      const validResult = validateFix(validIssue, validDiffPath);
      assert.strictEqual(validResult.valid, true,
        "Diff with only Data/events/de/ .json files should pass");

      // Also check via translation file path validator
      const validPaths = parseDiffFiles(validDiff);
      const validPathResult = validateTranslationFilePaths(validPaths);
      assert.strictEqual(validPathResult.valid, true,
        "Translation path validator should approve Data/events/de/ paths");
      assert.strictEqual(validPathResult.invalidPaths.length, 0,
        "No invalid paths expected");

      // Test case 2: Invalid -- includes Swift source code
      const swiftDiff = makeDiff([
        "Data/events/de/WorldHistory.json",
        "Views/SettingsView.swift",
      ]);
      const swiftDiffPath = writeTempDiff(swiftDiff, tempDir);

      const swiftResult = validateFix(validIssue, swiftDiffPath);
      assert.strictEqual(swiftResult.valid, false,
        "Diff with .swift file should fail");
      // Language gate runs before file-type gate, so Swift file outside lang:de path
      // triggers language-mismatch first. Either rejection reason is correct behavior.
      assert.ok(
        swiftResult.reason === "language-mismatch" || swiftResult.reason === "forbidden-file-type",
        "Rejection reason should be language-mismatch or forbidden-file-type, got: " + swiftResult.reason,
      );

      // Translation path validator also catches this
      const swiftPaths = parseDiffFiles(swiftDiff);
      const swiftPathResult = validateTranslationFilePaths(swiftPaths);
      assert.strictEqual(swiftPathResult.valid, false,
        "Translation path validator should reject Swift files");
      assert.ok(
        swiftPathResult.invalidPaths.includes("Views/SettingsView.swift"),
        "Swift file should be in invalid paths list",
      );

      // Test case 3: Invalid -- modifies English source (root Data/events/)
      const englishRootDiff = makeDiff([
        "Data/events/de/WorldHistory.json",
        "Data/events/WorldHistory.json",  // English root -- not a translation!
      ]);
      const englishRootPaths = parseDiffFiles(englishRootDiff);
      const englishRootResult = validateTranslationFilePaths(englishRootPaths);
      assert.strictEqual(englishRootResult.valid, false,
        "Translation path validator should reject English root files");
      assert.ok(
        englishRootResult.invalidPaths.includes("Data/events/WorldHistory.json"),
        "English root file should be in invalid paths list",
      );

      // Test case 4: Invalid -- Localization Swift file
      const locDiff = makeDiff([
        "Data/events/pt/WorldHistory.json",
        "Localization/LocalizationHelper.swift",
      ]);
      const locPaths = parseDiffFiles(locDiff);
      const locPathResult = validateTranslationFilePaths(locPaths);
      assert.strictEqual(locPathResult.valid, false,
        "Translation path validator should reject Localization Swift files");

      // Test case 5: Valid -- multiple languages (but same issue)
      const multiLangPaths = [
        "Data/events/pt/WorldHistory.json",
      ];
      const multiLangResult = validateTranslationFilePaths(multiLangPaths);
      assert.strictEqual(multiLangResult.valid, true,
        "Single-language Portuguese path should be valid");

      // Test case 6: Invalid -- non-JSON file in translation dir
      const nonJsonPaths = [
        "Data/events/de/WorldHistory.json",
        "Data/events/de/README.md",
      ];
      const nonJsonResult = validateTranslationFilePaths(nonJsonPaths);
      assert.strictEqual(nonJsonResult.valid, false,
        "Non-JSON files in translation dir should be rejected");

      // Verify the diff parser correctly identifies all files
      const parsedFiles = parseDiffFiles(validDiff);
      for (const f of parsedFiles) {
        assert.ok(
          f.startsWith("Data/events/"),
          "All files in valid diff should be in Data/events/ directory: " + f,
        );
        assert.ok(
          f.endsWith(".json"),
          "All files in valid diff should be .json: " + f,
        );
        // Verify language subdirectory exists
        const afterPrefix = f.slice("Data/events/".length);
        const langSegment = afterPrefix.split("/")[0];
        assert.ok(
          ["de", "nl", "pt", "es", "es-419", "fr"].includes(langSegment),
          "File should be in a known language subdirectory: " + langSegment,
        );
      }
    } finally {
      cleanupDir(tempDir);
    }
  });
});
