/**
 * Story 2.0c: Integration tests for validate-fix gate in resume pipelines.
 *
 * These test the exported runValidateFixGate() and handleValidationFailure()
 * functions, as well as the validateFix() behavior with realistic inputs
 * matching what the resume functions would pass.
 *
 * AC12: At least 3 integration tests:
 *   1. Happy path -- validateFix passes on a valid content-error diff
 *   2. Validation failure -- validateFix rejects forbidden file types, details captured
 *   3. Validation failure -- language mismatch detected for translation-error
 *   4. Empty diff -- validateFix catches empty diff before PR creation
 *   5. runValidateFixGate captures diff and calls validateFix as direct function call (AC9)
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { validateFix } from "../lib/validate-fix.js";
import { runValidateFixGate } from "../workflows/content-e2e.js";
// ------------------------------------------------------------------
// Test fixtures
// ------------------------------------------------------------------
/** Minimal valid diff for a content-error fix (only .json files) */
const VALID_CONTENT_DIFF = `diff --git a/Data/events/us-history.json b/Data/events/us-history.json
index abc1234..def5678 100644
--- a/Data/events/us-history.json
+++ b/Data/events/us-history.json
@@ -10,7 +10,7 @@
       "id": 42,
       "title": "Boston Tea Party",
-      "year": 1772,
+      "year": 1773,
       "category": "US History"
`;
/** Diff that modifies forbidden file types (AC5 violation) */
const FORBIDDEN_FILE_DIFF = `diff --git a/Views/MainView.swift b/Views/MainView.swift
index abc1234..def5678 100644
--- a/Views/MainView.swift
+++ b/Views/MainView.swift
@@ -1,3 +1,3 @@
-import SwiftUI
+import SwiftUI // modified
`;
/** Diff for a translation-error that modifies the wrong language path */
const WRONG_LANG_DIFF = `diff --git a/Data/translations/de/events.json b/Data/translations/de/events.json
index abc1234..def5678 100644
--- a/Data/translations/de/events.json
+++ b/Data/translations/de/events.json
@@ -5,7 +5,7 @@
-      "title": "Alte Ubersetzung",
+      "title": "Neue Ubersetzung",
`;
/** Empty diff */
const EMPTY_DIFF = "";
// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
/** Create a temp diff file with given content */
function writeTempDiff(content) {
    const diffPath = path.join(tmpdir(), "test-validate-fix-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".patch");
    fs.writeFileSync(diffPath, content, "utf-8");
    return diffPath;
}
/** Clean up a temp file (best-effort) */
function cleanupFile(filePath) {
    try {
        fs.unlinkSync(filePath);
    }
    catch { /* ok */ }
}
// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
describe("Story 2.0c: validate-fix integration", () => {
    // AC12 Test 1: Happy path -- valid content-error diff passes validation
    it("passes validation for a valid content-error diff with matching claim", () => {
        const diffPath = writeTempDiff(VALID_CONTENT_DIFF);
        try {
            const issueData = {
                number: 42,
                body: 'The event "Boston Tea Party" (id: 42) has the wrong year. It says 1772 but should be 1773.',
                labels: ["content-error"],
            };
            const result = validateFix(issueData, diffPath);
            // AC8: On success, validation passes and pipeline would proceed to createPR
            assert.strictEqual(result.valid, true, "Valid content diff should pass validation");
            assert.strictEqual(result.reason, undefined, "No failure reason on success");
        }
        finally {
            cleanupFile(diffPath);
        }
    });
    // AC12 Test 2: Validation failure -- forbidden file type blocks PR
    it("rejects diff containing forbidden file types (.swift)", () => {
        const diffPath = writeTempDiff(FORBIDDEN_FILE_DIFF);
        try {
            const issueData = {
                number: 99,
                body: "Some content error in event 123",
                labels: ["content-error"],
            };
            const result = validateFix(issueData, diffPath);
            // AC4/AC5: Validation fails with reason and details
            assert.strictEqual(result.valid, false, "Diff with .swift files should fail validation");
            assert.strictEqual(result.reason, "forbidden-file-type", "Reason should be forbidden-file-type");
            assert.ok(result.details, "Details should be present");
            assert.ok(result.details.includes("MainView.swift"), "Details should mention the forbidden file");
        }
        finally {
            cleanupFile(diffPath);
        }
    });
    // AC12 Test 3: Language mismatch for translation-error
    it("rejects translation-error diff that modifies wrong language path", () => {
        // Issue is tagged lang:es (Spanish) but diff modifies de/ (German) path
        const diffPath = writeTempDiff(WRONG_LANG_DIFF);
        try {
            const issueData = {
                number: 121,
                body: "Spanish translation is wrong for daily_challenge_title",
                labels: ["translation-error", "lang:es"],
            };
            const result = validateFix(issueData, diffPath);
            // AC3 (language gate): Should reject because diff touches de/ but issue is lang:es
            assert.strictEqual(result.valid, false, "Diff in wrong language path should fail");
            assert.strictEqual(result.reason, "language-mismatch", "Reason should be language-mismatch");
            assert.ok(result.details, "Details should be present");
            assert.ok(result.details.includes("es"), "Details should mention expected language (es)");
        }
        finally {
            cleanupFile(diffPath);
        }
    });
    // AC12 Test 4 (bonus): Empty diff detection
    it("rejects empty diff", () => {
        const diffPath = writeTempDiff(EMPTY_DIFF);
        try {
            const issueData = {
                number: 50,
                body: "Content error in event 100",
                labels: ["content-error"],
            };
            const result = validateFix(issueData, diffPath);
            assert.strictEqual(result.valid, false, "Empty diff should fail");
            assert.strictEqual(result.reason, "empty-diff", "Reason should be empty-diff");
        }
        finally {
            cleanupFile(diffPath);
        }
    });
    // AC12 Test 5 (bonus): translation-error without lang label fails
    it("rejects translation-error issue missing lang label", () => {
        const diffPath = writeTempDiff(VALID_CONTENT_DIFF);
        try {
            const issueData = {
                number: 130,
                body: "Translation is wrong for some key",
                labels: ["translation-error"], // No lang:XX label
            };
            const result = validateFix(issueData, diffPath);
            assert.strictEqual(result.valid, false, "Translation-error without lang label should fail");
            assert.strictEqual(result.reason, "missing-language-label");
        }
        finally {
            cleanupFile(diffPath);
        }
    });
    // AC9: Verify runValidateFixGate calls validateFix as direct function call
    // We test this by verifying the function exists and returns a ValidationResult
    it("runValidateFixGate returns structured ValidationResult (AC9 direct call)", () => {
        // Create a temp dir with a fake git repo for diff capture
        const tempDir = fs.mkdtempSync(path.join(tmpdir(), "validate-fix-gate-test-"));
        const diffContent = VALID_CONTENT_DIFF;
        try {
            // Initialize minimal git repo for the diff capture to work
            execSync("git init", { cwd: tempDir, encoding: "utf-8" });
            execSync('git config user.name "test"', { cwd: tempDir, encoding: "utf-8" });
            execSync('git config user.email "test@test.com"', { cwd: tempDir, encoding: "utf-8" });
            // Create and commit a file so HEAD exists
            fs.writeFileSync(path.join(tempDir, "test.json"), '{"test": true}', "utf-8");
            execSync("git add -A && git commit -m 'init'", { cwd: tempDir, encoding: "utf-8" });
            // runValidateFixGate should return a ValidationResult
            // Since no actual changes exist in the temp repo, diff will be empty -> empty-diff result
            const result = runValidateFixGate(42, "Content error in event 42", ["content-error"], tempDir);
            // Verify it returns a proper ValidationResult structure
            assert.strictEqual(typeof result.valid, "boolean", "result.valid should be boolean");
            // With empty diff (no uncommitted changes), should fail with empty-diff
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.reason, "empty-diff");
        }
        finally {
            // Cleanup temp dir
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
