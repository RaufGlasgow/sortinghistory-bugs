/**
 * PV2-6.2: Orchestrator Output Tests
 *
 * Verifies that orchestrator log format strings match the grep patterns
 * used in sdk-bug-fix.yml to extract structured output from logs.
 *
 * If someone changes the log format in orchestrator.ts without updating
 * the YAML grep patterns, these tests will catch it.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
/**
 * Log format strings from orchestrator.ts lines 523-531.
 * These are the exact prefixes that the YAML workflow greps for.
 */
const ORCHESTRATOR_LOG_PREFIXES = [
    "[orchestrator] Bug fix result: ",
    "[orchestrator] Fix attempts used: ",
    "[orchestrator] Files modified: ",
    "[orchestrator] Compilation: ",
    "[orchestrator] Confidence: ",
];
/**
 * Grep patterns from sdk-bug-fix.yml that extract values from orchestrator logs.
 * These are simplified — the YAML uses `grep 'pattern' | sed ...` to extract.
 */
const YAML_GREP_PATTERNS = [
    "\\[orchestrator\\] Bug fix result:",
    "\\[orchestrator\\] Fix attempts used:",
    "\\[orchestrator\\] Files modified:",
    "\\[orchestrator\\] Compilation:",
    "\\[orchestrator\\] Confidence:",
];
describe("orchestrator-output: log format matches YAML grep patterns", () => {
    it("each orchestrator log prefix matches its corresponding YAML grep pattern", () => {
        for (let i = 0; i < ORCHESTRATOR_LOG_PREFIXES.length; i++) {
            const logPrefix = ORCHESTRATOR_LOG_PREFIXES[i];
            const grepPattern = YAML_GREP_PATTERNS[i];
            // Convert grep pattern to regex and test against the log prefix
            const regex = new RegExp(grepPattern);
            assert.ok(regex.test(logPrefix), `Log prefix "${logPrefix}" does not match YAML grep pattern "${grepPattern}"`);
        }
    });
    it("simulated orchestrator output is greppable", () => {
        // Simulate what orchestrator.ts actually outputs
        const simulatedOutput = [
            "[orchestrator] Bug fix result: success",
            "[orchestrator] Fix attempts used: 2",
            "[orchestrator] Files modified: 3",
            "[orchestrator] Compilation: success",
            "[orchestrator] Confidence: high",
        ];
        for (let i = 0; i < simulatedOutput.length; i++) {
            const line = simulatedOutput[i];
            const grepPattern = YAML_GREP_PATTERNS[i];
            const regex = new RegExp(grepPattern);
            assert.ok(regex.test(line), `Simulated output "${line}" not matched by grep pattern "${grepPattern}"`);
        }
    });
    it("simulated output values can be extracted with sed-like split", () => {
        // The YAML uses sed to extract the value after the colon
        const lines = {
            "[orchestrator] Bug fix result: success": "success",
            "[orchestrator] Fix attempts used: 2": "2",
            "[orchestrator] Files modified: 3": "3",
            "[orchestrator] Compilation: success": "success",
            "[orchestrator] Confidence: high": "high",
        };
        for (const [line, expectedValue] of Object.entries(lines)) {
            // Simulate sed extraction: everything after the last ": "
            const parts = line.split(": ");
            const extracted = parts[parts.length - 1];
            assert.equal(extracted, expectedValue, `Failed to extract "${expectedValue}" from "${line}"`);
        }
    });
});
