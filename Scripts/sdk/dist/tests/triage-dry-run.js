/**
 * Story 3.2: Dry-Run Testing Script (BA-011 FR18, FR19, ARCH-7)
 *
 * Feeds known bug descriptions from triage-fixtures.ts through the real
 * runTriage() function (calls Haiku API) and reports accuracy.
 *
 * NOT a CI test — runs manually by operator before deployment.
 * Requires ANTHROPIC_API_KEY and costs real money (~$0.03-$0.10 per run).
 *
 * Usage:
 *   npx tsx Scripts/sdk/tests/triage-dry-run.ts           # All fixtures
 *   npx tsx Scripts/sdk/tests/triage-dry-run.ts --fixture test-A  # Single fixture
 *
 * Output: Human-readable summary + JSON summary for programmatic comparison.
 *
 * Exit codes:
 * - 0: Dry-run completed (regardless of accuracy)
 * - 1: Fatal error (e.g., no fixtures, all API calls failed)
 */
import { TRIAGE_FIXTURES } from "./triage-fixtures.js";
import { runTriage } from "../workflows/bug-triage.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Check if a classification matches the expected value(s) */
function isCorrect(got, expected) {
    if (Array.isArray(expected)) {
        return expected.includes(got);
    }
    return got === expected;
}
/** Parse --fixture flag from command line args */
function parseFixtureFlag() {
    const args = process.argv.slice(2);
    const idx = args.indexOf("--fixture");
    if (idx >= 0 && args[idx + 1]) {
        return args[idx + 1];
    }
    return null;
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const fixtureFilter = parseFixtureFlag();
    let fixtures = TRIAGE_FIXTURES;
    if (fixtureFilter) {
        fixtures = fixtures.filter(f => f.id === fixtureFilter);
        if (fixtures.length === 0) {
            console.error("No fixture found with id: " + fixtureFilter);
            console.error("Available: " + TRIAGE_FIXTURES.map(f => f.id).join(", "));
            process.exit(1);
        }
        console.log("Running single fixture: " + fixtureFilter);
    }
    console.log("=== BA-011 Story 3.2: Triage Dry-Run ===");
    console.log("Fixtures: " + fixtures.length);
    console.log("Model: Haiku (via runTriage)");
    console.log("Cost estimate: ~$" + (fixtures.length * 0.008).toFixed(3));
    console.log("");
    const fixtureResults = [];
    const errors = [];
    let totalCostUsd = 0;
    for (const fixture of fixtures) {
        console.log("--- " + fixture.id + " ---");
        console.log("Report: \"" + fixture.report.slice(0, 80) + (fixture.report.length > 80 ? "..." : "") + "\"");
        console.log("Expected: " + JSON.stringify(fixture.expected_classification));
        let result;
        try {
            result = await runTriage({
                report_text: fixture.report,
                report_id: fixture.id,
            });
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("[" + fixture.id + "] ERROR: " + errMsg);
            errors.push({ fixture_id: fixture.id, error: errMsg });
            console.log("");
            continue;
        }
        const correct = isCorrect(result.classification, fixture.expected_classification);
        fixtureResults.push({
            fixture_id: fixture.id,
            expected: fixture.expected_classification,
            got: result.classification,
            confidence: result.confidence,
            correct,
        });
        if (correct) {
            console.log("[" + fixture.id + "] CORRECT: " + result.classification + " (confidence: " + result.confidence.toFixed(2) + ")");
        }
        else {
            console.log("[" + fixture.id + "] WRONG: expected " + JSON.stringify(fixture.expected_classification) + ", got " + result.classification + " (confidence: " + result.confidence.toFixed(2) + ")");
        }
        console.log("");
    }
    // --- Summary ---
    const correctCount = fixtureResults.filter(r => r.correct).length;
    const totalProcessed = fixtureResults.length;
    const accuracy = totalProcessed > 0 ? correctCount / totalProcessed : 0;
    const misclassifications = fixtureResults.filter(r => !r.correct);
    console.log("=== Dry-Run Summary ===");
    console.log("Processed: " + totalProcessed + "/" + fixtures.length);
    console.log("Correct: " + correctCount + "/" + totalProcessed + " (" + (accuracy * 100).toFixed(0) + "%)");
    if (errors.length > 0) {
        console.log("API Errors: " + errors.length);
    }
    if (misclassifications.length > 0) {
        console.log("");
        console.log("Misclassifications:");
        for (const m of misclassifications) {
            console.log("  " + m.fixture_id + ": expected " + JSON.stringify(m.expected) + ", got " + m.got + " (confidence: " + m.confidence.toFixed(2) + ")");
        }
    }
    if (errors.length > 0) {
        console.log("");
        console.log("Errors:");
        for (const e of errors) {
            console.log("  " + e.fixture_id + ": " + e.error);
        }
    }
    // --- JSON summary ---
    const summary = {
        total: fixtures.length,
        correct: correctCount,
        accuracy: Math.round(accuracy * 1000) / 1000,
        misclassifications: misclassifications.map(m => ({
            fixture_id: m.fixture_id,
            expected: m.expected,
            got: m.got,
            confidence: m.confidence,
            correct: false,
        })),
        errors,
        cost_usd: totalCostUsd,
    };
    console.log("");
    console.log("=== JSON Summary ===");
    console.log(JSON.stringify(summary, null, 2));
    // Exit 0 even on misclassifications (dry-run is informational)
    // Exit 1 only if ALL fixtures errored (no useful data)
    if (totalProcessed === 0 && errors.length > 0) {
        console.error("FATAL: All fixtures errored — no results to report");
        process.exit(1);
    }
}
main().catch((err) => {
    console.error("Fatal error: " + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
});
