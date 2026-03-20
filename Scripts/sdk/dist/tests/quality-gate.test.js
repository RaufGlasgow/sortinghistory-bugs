/**
 * PV2-6.2: Quality Gate Tests
 *
 * Tests the diff quality checks (runQualityGate).
 * All checks are pure string/pattern matching — no IO needed.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { runQualityGate } from "../lib/quality-gate.js";
/** Generate a fake diff with a given number of lines */
function makeDiff(lineCount) {
    const lines = ["diff --git a/Views/Test.swift b/Views/Test.swift"];
    for (let i = 0; i < lineCount - 1; i++) {
        lines.push("+ line " + i);
    }
    return lines.join("\n");
}
describe("quality-gate: clean diff", () => {
    it("only .swift files, < 1500 lines → PASS", () => {
        const diff = makeDiff(50);
        const files = ["Views/GameSetupView.swift"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, true);
        assert.equal(result.failures.length, 0);
    });
    it(".json + .swift → PASS (allowed combo)", () => {
        const diff = makeDiff(100);
        const files = ["Views/GameSetupView.swift", "Data/USHistory.json"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, true);
        assert.equal(result.failures.length, 0);
    });
});
describe("quality-gate: build artifacts", () => {
    it("DerivedData/ → FAIL (build artifacts)", () => {
        const diff = makeDiff(10);
        const files = ["DerivedData/Build/foo.o"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        const artifactFail = result.failures.find((f) => f.check === "no_build_artifacts");
        assert.ok(artifactFail, "Expected no_build_artifacts failure");
        assert.ok(artifactFail.offendingPaths.includes("DerivedData/Build/foo.o"));
    });
});
describe("quality-gate: temp files", () => {
    it(".DS_Store → FAIL (temp files)", () => {
        const diff = makeDiff(10);
        const files = [".DS_Store"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        const tempFail = result.failures.find((f) => f.check === "no_temp_files");
        assert.ok(tempFail, "Expected no_temp_files failure");
    });
});
describe("quality-gate: automation files", () => {
    it(".github/workflows/ → FAIL (automation files)", () => {
        const diff = makeDiff(10);
        const files = [".github/workflows/ci.yml"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        const autoFail = result.failures.find((f) => f.check === "no_automation_files");
        assert.ok(autoFail, "Expected no_automation_files failure");
    });
    it(".ts files → FAIL (automation extension)", () => {
        const diff = makeDiff(10);
        const files = ["Scripts/sdk/lib/test.ts"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        // .ts triggers both automation path (Scripts/) and automation extension (.ts)
        const autoFail = result.failures.find((f) => f.check === "no_automation_files");
        assert.ok(autoFail, "Expected no_automation_files failure");
    });
});
describe("quality-gate: diff proportionality", () => {
    it("diff > 1500 lines → FAIL (oversized)", () => {
        const diff = makeDiff(1600);
        const files = ["Views/Test.swift"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        const sizeFail = result.failures.find((f) => f.check === "diff_proportionality");
        assert.ok(sizeFail, "Expected diff_proportionality failure");
        assert.ok(sizeFail.description.includes("1600"));
    });
});
describe("quality-gate: binary files", () => {
    it("binary content → FAIL", () => {
        const diff = [
            "diff --git a/Assets/image.png b/Assets/image.png",
            "Binary files /dev/null and b/Assets/image.png differ",
        ].join("\n");
        const files = ["Assets/image.png"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        const binFail = result.failures.find((f) => f.check === "no_binary_files");
        assert.ok(binFail, "Expected no_binary_files failure");
        assert.ok(binFail.offendingPaths.includes("Assets/image.png"));
    });
});
describe("quality-gate: disallowed extensions", () => {
    it("file with no extension → FAIL", () => {
        const diff = makeDiff(10);
        const files = ["Makefile"];
        const result = runQualityGate(diff, files);
        assert.equal(result.passed, false);
        const extFail = result.failures.find((f) => f.check === "allowed_extensions_only");
        assert.ok(extFail, "Expected allowed_extensions_only failure");
    });
});
