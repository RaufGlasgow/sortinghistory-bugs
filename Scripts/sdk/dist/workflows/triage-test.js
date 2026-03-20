/**
 * Story 4.1: Triage Test Harness
 *
 * Runs all triage fixtures through the bug triager subagent and validates:
 * - classification matches expected_classification (string or one of string[])
 * - severity is within expected_severity_range
 *
 * Logs per-fixture PASS/FAIL with details.
 * Exits 0 if all pass, exits 1 if any fail.
 *
 * Expected total cost: ~$0.21 (7 fixtures x ~$0.03 each)
 */
import { TRIAGE_FIXTURES } from "../tests/triage-fixtures.js";
import { runTriage } from "./bug-triage.js";
/** Run the triage test suite */
export async function runTriageTest() {
    console.log("=== Story 4.1: Triage Test Suite ===");
    console.log("Fixtures: " + TRIAGE_FIXTURES.length);
    console.log("");
    const results = [];
    let totalCostEstimate = 0;
    for (const fixture of TRIAGE_FIXTURES) {
        console.log("--- Fixture " + fixture.id + " ---");
        console.log("Report: \"" + fixture.report + "\"");
        const expectedClassStr = Array.isArray(fixture.expected_classification)
            ? fixture.expected_classification.join("/")
            : fixture.expected_classification;
        console.log("Expected: " + expectedClassStr + " (" + fixture.expected_severity_range.join("/") + ")");
        console.log("");
        const triageResult = await runTriage({
            report_text: fixture.report,
            report_id: fixture.id,
        });
        const classificationMatch = Array.isArray(fixture.expected_classification)
            ? fixture.expected_classification.includes(triageResult.classification)
            : triageResult.classification === fixture.expected_classification;
        const severityMatch = fixture.expected_severity_range.includes(triageResult.severity);
        const passed = classificationMatch && severityMatch;
        results.push({
            fixture,
            result: triageResult,
            classificationMatch,
            severityMatch,
            passed,
        });
        console.log("");
        console.log("[" + fixture.id + "] Classification: " +
            (classificationMatch ? "PASS" : "FAIL") +
            " (got: " + triageResult.classification + ", expected: " + expectedClassStr + ")");
        console.log("[" + fixture.id + "] Severity: " +
            (severityMatch ? "PASS" : "FAIL") +
            " (got: " + triageResult.severity + ", expected: " + fixture.expected_severity_range.join("/") + ")");
        console.log("[" + fixture.id + "] Overall: " + (passed ? "PASS" : "FAIL"));
        console.log("");
    }
    // Summary
    console.log("=== Triage Test Suite Summary ===");
    const passCount = results.filter(r => r.passed).length;
    const failCount = results.length - passCount;
    for (const r of results) {
        const status = r.passed ? "PASS" : "FAIL";
        const details = [];
        if (!r.classificationMatch) {
            const expClass = Array.isArray(r.fixture.expected_classification)
                ? r.fixture.expected_classification.join("/")
                : r.fixture.expected_classification;
            details.push("classification: got " + r.result.classification + " expected " + expClass);
        }
        if (!r.severityMatch) {
            details.push("severity: got " + r.result.severity + " expected " + r.fixture.expected_severity_range.join("/"));
        }
        const detailStr = details.length > 0 ? " (" + details.join("; ") + ")" : "";
        console.log("  " + r.fixture.id + ": " + status + detailStr);
    }
    console.log("");
    console.log("Results: " + passCount + "/" + results.length + " passed, " + failCount + " failed");
    if (failCount > 0) {
        console.error("");
        console.error("=== TRIAGE TEST SUITE FAILED ===");
        process.exit(1);
    }
    console.log("");
    console.log("=== TRIAGE TEST SUITE PASSED ===");
}
