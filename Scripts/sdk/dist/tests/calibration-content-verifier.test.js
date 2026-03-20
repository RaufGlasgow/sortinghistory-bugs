import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runInlineAutomatedChecks } from "../workflows/content-verify.js";
/**
 * Story 2.3a: Calibrate Content Verifier
 *
 * Tests 1-3: Pure unit tests validating fixture structure and automated gate detection.
 * Tests 4-7: Integration tests validating AI verifier results from a calibration run.
 *
 * Tests 4-7 read pre-recorded calibration results from a results file.
 * The calibration run itself is executed separately (via runContentVerify or
 * the orchestrator) and results saved before these tests validate them.
 */
// Resolve SDK root: at runtime __dirname is dist/tests/, so go up to dist/ then up to sdk/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_PATH = path.resolve(SDK_ROOT, "tests", "fixtures", "calibration-content", "calibration-test-set.json");
const RESULTS_PATH = path.resolve(SDK_ROOT, "tests", "fixtures", "calibration-content", "calibration-results.json");
/** Load the calibration fixture file */
function loadFixture() {
    const raw = fs.readFileSync(FIXTURE_PATH, "utf-8");
    return JSON.parse(raw);
}
/** Load pre-recorded calibration results (from a real AI run) */
function loadCalibrationResults() {
    if (!fs.existsSync(RESULTS_PATH)) {
        return null;
    }
    const raw = fs.readFileSync(RESULTS_PATH, "utf-8");
    return JSON.parse(raw);
}
// ---------------------------------------------------------------------------
// Test 1: Fixture structure validation
// ---------------------------------------------------------------------------
describe("Story 2.3a: Calibration Content Verifier", () => {
    it("calibration test set has 10 events: 5 good, 5 with planted errors", () => {
        const fixture = loadFixture();
        // Must have exactly 10 events
        assert.equal(fixture.events.length, 10, "fixture must have exactly 10 events");
        // Must have a valid category
        assert.equal(fixture.category, "US History", "fixture must use US History category");
        // Count good vs planted-error events
        const goodEvents = fixture.events.filter(e => !e._planted_error);
        const errorEvents = fixture.events.filter(e => !!e._planted_error);
        assert.equal(goodEvents.length, 5, "must have exactly 5 good events");
        assert.equal(errorEvents.length, 5, "must have exactly 5 planted-error events");
        // Verify all events have required fields
        for (const event of fixture.events) {
            assert.ok(event.title, "event must have title");
            assert.ok(typeof event.year === "number", "event must have numeric year");
            assert.ok(event.description, "event must have description");
            assert.ok(event.category, "event must have category");
            assert.ok(typeof event.difficulty === "number", "event must have numeric difficulty");
        }
        // Verify the 5 planted errors cover the required types
        const errorDescriptions = errorEvents.map(e => String(e._planted_error));
        const hasWrongYear = errorDescriptions.some(d => d.includes("WRONG YEAR"));
        const hasTooLong = errorDescriptions.some(d => d.includes("TOO LONG"));
        const hasWrongCountry = errorDescriptions.some(d => d.includes("WRONG COUNTRY"));
        const hasDuplicate = errorDescriptions.some(d => d.includes("DUPLICATE"));
        const hasAgeInappropriate = errorDescriptions.some(d => d.includes("AGE-INAPPROPRIATE"));
        assert.ok(hasWrongYear, "must have a wrong-year planted error (Gate 1)");
        assert.ok(hasTooLong, "must have a too-long description planted error (Gate 3, P7)");
        assert.ok(hasWrongCountry, "must have a wrong-country planted error (Gate 1)");
        assert.ok(hasDuplicate, "must have a duplicate planted error (Gate 4, D1)");
        assert.ok(hasAgeInappropriate, "must have an age-inappropriate planted error (Gate 2)");
    });
    // ---------------------------------------------------------------------------
    // Test 2: Automated gate catches P2 (too-long description = P7 in story terms)
    // ---------------------------------------------------------------------------
    it("validate_content.py catches P7 length violation in test set", () => {
        const fixture = loadFixture();
        const events = fixture.events.map(e => ({
            title: String(e.title),
            year: Number(e.year),
            description: String(e.description),
            category: String(e.category),
            difficulty: Number(e.difficulty),
            month: e.month != null ? Number(e.month) : undefined,
            day: e.day != null ? Number(e.day) : undefined,
            version: e.version != null ? Number(e.version) : undefined,
            imageURL: e.imageURL != null ? String(e.imageURL) : null,
        }));
        const { failed } = runInlineAutomatedChecks(events);
        // "First Telephone Call Made" has a 36-word description (max 23)
        const telephoneFailure = failed.find(f => f.title === "First Telephone Call Made");
        assert.ok(telephoneFailure, "First Telephone Call Made must be flagged by automated checks");
        assert.ok(telephoneFailure.codes.includes("P2"), "First Telephone Call Made must be flagged with P2 (description too long). Got: [" + telephoneFailure.codes.join(", ") + "]");
    });
    // ---------------------------------------------------------------------------
    // Test 3: Automated gate catches D1 (exact duplicate title)
    // ---------------------------------------------------------------------------
    it("validate_content.py catches D1 duplicate in test set", () => {
        const fixture = loadFixture();
        const events = fixture.events.map(e => ({
            title: String(e.title),
            year: Number(e.year),
            description: String(e.description),
            category: String(e.category),
            difficulty: Number(e.difficulty),
            month: e.month != null ? Number(e.month) : undefined,
            day: e.day != null ? Number(e.day) : undefined,
            version: e.version != null ? Number(e.version) : undefined,
            imageURL: e.imageURL != null ? String(e.imageURL) : null,
        }));
        const { failed } = runInlineAutomatedChecks(events);
        // The second "Declaration of Independence Signed" is an exact duplicate
        const duplicateFailures = failed.filter(f => f.title === "Declaration of Independence Signed");
        assert.ok(duplicateFailures.length >= 1, "at least one 'Declaration of Independence Signed' must be flagged as duplicate");
        const d1Failure = duplicateFailures.find(f => f.codes.includes("D1"));
        assert.ok(d1Failure, "duplicate Declaration of Independence Signed must be flagged with D1. Got: [" +
            duplicateFailures.map(f => f.codes.join(",")).join("; ") + "]");
    });
    // ---------------------------------------------------------------------------
    // Tests 4-7: AI verifier results (from pre-recorded calibration run)
    // These tests validate the results of a real calibration run.
    // Run the calibration first, then these tests validate the output.
    // ---------------------------------------------------------------------------
    it("content verifier catches wrong-year factual error", () => {
        const results = loadCalibrationResults();
        if (!results) {
            assert.fail("Calibration results file not found at " + RESULTS_PATH +
                ". Run the calibration first to generate results.");
        }
        const columbus = results.ai_results.find(r => r.title === "Columbus Reaches Americas");
        assert.ok(columbus, "Columbus Reaches Americas must be in AI results");
        assert.equal(columbus.gate1_factual.passed, false, "Columbus Reaches Americas must FAIL Gate 1 (wrong year 1493 vs 1492). Details: " +
            columbus.gate1_factual.details);
        assert.ok(columbus.gate1_factual.code === "F1" || columbus.gate1_factual.code === "F2", "Columbus failure must use code F1 or F2. Got: " + columbus.gate1_factual.code);
    });
    it("content verifier catches wrong-country factual error", () => {
        const results = loadCalibrationResults();
        if (!results) {
            assert.fail("Calibration results file not found at " + RESULTS_PATH +
                ". Run the calibration first to generate results.");
        }
        const teaParty = results.ai_results.find(r => r.title === "Boston Tea Party");
        assert.ok(teaParty, "Boston Tea Party must be in AI results");
        assert.equal(teaParty.gate1_factual.passed, false, "Boston Tea Party must FAIL Gate 1 (wrong country context: Paris/France instead of Boston/America). Details: " +
            teaParty.gate1_factual.details);
        assert.ok(teaParty.gate1_factual.code === "F1" || teaParty.gate1_factual.code === "F2", "Boston Tea Party failure must use code F1 or F2. Got: " + teaParty.gate1_factual.code);
    });
    it("content verifier catches age-inappropriate content", () => {
        const results = loadCalibrationResults();
        if (!results) {
            assert.fail("Calibration results file not found at " + RESULTS_PATH +
                ". Run the calibration first to generate results.");
        }
        const salem = results.ai_results.find(r => r.title === "Salem Witch Executions");
        assert.ok(salem, "Salem Witch Executions must be in AI results");
        assert.equal(salem.gate2_age.passed, false, "Salem Witch Executions must FAIL Gate 2 (age-inappropriate graphic violence). Details: " +
            salem.gate2_age.details);
        assert.ok(salem.gate2_age.code === "A1" || salem.gate2_age.code === "A2", "Salem failure must use code A1 or A2. Got: " + salem.gate2_age.code);
    });
    it("content verifier does not flag known-good events as errors (max 1/5)", () => {
        const results = loadCalibrationResults();
        if (!results) {
            assert.fail("Calibration results file not found at " + RESULTS_PATH +
                ". Run the calibration first to generate results.");
        }
        const goodTitles = [
            "Moon Landing",
            "Louisiana Purchase Completed",
            "Rosa Parks Refuses to Give Up Seat",
            "Transcontinental Railroad Completed",
        ];
        // Note: "Declaration of Independence Signed" may not reach AI due to D1 duplicate
        // filtering in automated gates, so we only check the 4 good events guaranteed to
        // reach the AI verifier.
        let falsePositives = 0;
        const falsePositiveDetails = [];
        for (const title of goodTitles) {
            const eventResult = results.ai_results.find(r => r.title === title);
            if (eventResult && !eventResult.overall_passed) {
                falsePositives++;
                const details = [];
                if (!eventResult.gate1_factual.passed) {
                    details.push("G1:" + eventResult.gate1_factual.code + " " + eventResult.gate1_factual.details);
                }
                if (!eventResult.gate2_age.passed) {
                    details.push("G2:" + eventResult.gate2_age.code + " " + eventResult.gate2_age.details);
                }
                falsePositiveDetails.push("'" + title + "' falsely flagged: " + details.join("; "));
            }
        }
        assert.ok(falsePositives <= 1, "False positive rate must be < 20% (max 1 of good events flagged). " +
            "Got " + falsePositives + " false positives: " + falsePositiveDetails.join(". "));
    });
});
