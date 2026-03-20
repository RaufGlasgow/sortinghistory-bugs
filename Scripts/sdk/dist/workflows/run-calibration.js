/**
 * Story 2.3a: Content Verifier Calibration Runner
 *
 * Runs the content verification pipeline against the calibration test set
 * and saves structured results to the calibration-results.json file.
 *
 * Usage:
 *   npx tsx Scripts/sdk/workflows/run-calibration.ts
 *
 * Requires ANTHROPIC_API_KEY in environment.
 * Cost: ~$0.30-0.50 per run (10 events x Haiku verifier).
 *
 * After running, execute the calibration tests to validate:
 *   node --test dist/tests/calibration-content-verifier.test.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runContentVerify } from "./content-verify.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.resolve(SDK_ROOT, "tests", "fixtures", "calibration-content", "calibration-test-set.json");
const RESULTS_PATH = path.resolve(SDK_ROOT, "tests", "fixtures", "calibration-content", "calibration-results.json");
async function main() {
    console.log("=== Story 2.3a: Content Verifier Calibration Run ===");
    console.log("Fixture: " + FIXTURE_PATH);
    console.log("Results will be saved to: " + RESULTS_PATH);
    console.log("");
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error("ERROR: ANTHROPIC_API_KEY not set. Cannot run AI calibration.");
        process.exit(1);
    }
    // Run the full content verification pipeline
    const result = await runContentVerify({
        filePath: FIXTURE_PATH,
        category: "US History",
    });
    // Build the calibration results in the format expected by the tests
    const aiResults = result.ai_gates.failures.map(f => ({
        title: f.title,
        year: 0, // Not available from failure records
        gate1_factual: {
            passed: !f.codes.some(c => c === "F1" || c === "F2"),
            code: f.codes.find(c => c === "F1" || c === "F2") ?? null,
            details: f.details,
        },
        gate2_age: {
            passed: !f.codes.some(c => c === "A1" || c === "A2"),
            code: f.codes.find(c => c === "A1" || c === "A2") ?? null,
            details: f.details,
        },
        overall_passed: false,
    }));
    // Add passed events (those checked by AI but not in failures)
    const failedTitles = new Set(result.ai_gates.failures.map(f => f.title));
    const fixtureData = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf-8"));
    const autoFailedTitles = new Set(result.automated_gates.failures.map(f => f.title));
    for (const event of fixtureData.events) {
        const title = event.title;
        // Skip events caught by automated gates or already in AI failures
        if (autoFailedTitles.has(title) || failedTitles.has(title))
            continue;
        // Skip duplicates (second occurrence caught by D1)
        if (aiResults.some(r => r.title === title))
            continue;
        aiResults.push({
            title,
            year: event.year,
            gate1_factual: { passed: true, code: null, details: "Passed AI verification" },
            gate2_age: { passed: true, code: null, details: "Passed AI verification" },
            overall_passed: true,
        });
    }
    const calibrationOutput = {
        run_date: new Date().toISOString(),
        prompt_version: "1.1-calibrated",
        iteration: 1,
        model: "claude-haiku-4-5-20251001",
        method: "Automated calibration via run-calibration.ts using Claude Agent SDK",
        notes: "Calibration run against 10-event test set via SDK pipeline.",
        automated_gates: {
            total_events: result.total_events,
            passed_to_ai: result.automated_gates.passed,
            failed: result.automated_gates.failed,
            failures: result.automated_gates.failures,
        },
        ai_results: aiResults,
        per_gate_accuracy: {
            gate1_factual: { details: "See ai_results for individual event outcomes" },
            gate2_age_appropriateness: { details: "See ai_results for individual event outcomes" },
            gate3_parameters_p2: {
                caught: result.automated_gates.failures.some(f => f.codes.includes("P2")),
                details: "Automated gate check",
            },
            gate4_duplicates_d1: {
                caught: result.automated_gates.failures.some(f => f.codes.includes("D1")),
                details: "Automated gate check",
            },
        },
        calibration_summary: {
            total_events: result.total_events,
            total_passed: result.summary.total_passed,
            total_failed: result.summary.total_failed,
            result: result.summary.total_failed >= 5 ? "PASS" : "NEEDS_TUNING",
        },
    };
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(calibrationOutput, null, 2) + "\n");
    console.log("");
    console.log("Calibration results saved to: " + RESULTS_PATH);
    console.log("Run tests: node --test dist/tests/calibration-content-verifier.test.js");
}
main().catch(err => {
    console.error("Calibration run failed:", err);
    process.exit(1);
});
