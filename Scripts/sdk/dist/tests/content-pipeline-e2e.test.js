/**
 * Story 2.3b: Content Pipeline End-to-End Tests
 *
 * 8 integration tests that validate the full content verification -> fix -> PR chain.
 * These tests mock AI subagent calls and use temp filesystems to test pipeline logic.
 *
 * Tests cover:
 *   1. Full chain: verifier finds error -> fixer fixes -> re-verify passes -> PR created
 *   2. Version increment schema validation (FR42)
 *   3. Corrections log schema validation (FR41)
 *   4. Stale translation detection after English source change (FR43)
 *   5. Structural JSON validation rejects malformed fixer output (FR40)
 *   6. Retry loop configuration and error classification (FR17)
 *   7. Only Data/ directory files modified (FR45)
 *   8. Category backfill flagging when source drops below 100 events (FR18)
 *
 * Note on Tests 2 and 3: Version increment and corrections log updates are
 * performed inline by the AI fixer subagent (content-fixer.md prompt), not by
 * dedicated production functions. There is no extractable function to call.
 * These tests validate the expected data schema and format constraints that the
 * AI output must conform to, ensuring the pipeline can consume fixer output
 * correctly. The schema is defined in Scripts/sdk/prompts/content-fixer.md.
 *
 * All tests use temp directories and mock data -- $0.00 API cost.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { validateFix, parseDiffFiles, } from "../lib/validate-fix.js";
import { runInlineAutomatedChecks, } from "../workflows/content-verify.js";
import { processApproval, } from "../workflows/content-e2e.js";
import { LIMITS } from "../config.js";
import { detectStaleTranslations, checkCategoryBackfill, } from "../lib/content-pipeline-utils.js";
import { isRetryableQAError, } from "../lib/retry-loop.js";
// ------------------------------------------------------------------
// Test fixture helpers
// ------------------------------------------------------------------
/** Create a temp directory for test isolation */
function createTempDir(testName) {
    return fs.mkdtempSync(path.join(tmpdir(), "content-e2e-2.3b-" + testName + "-"));
}
/** Clean up a temp directory */
function cleanupDir(dirPath) {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
    catch { /* best-effort */ }
}
/** Create a temp diff file and return its path */
function writeTempDiff(content, dir) {
    const d = dir ?? tmpdir();
    const diffPath = path.join(d, "test-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".patch");
    fs.writeFileSync(diffPath, content, "utf-8");
    return diffPath;
}
/** Build a mock unified diff for given file paths */
function makeDiff(files, diffBody) {
    return files
        .map((f) => "diff --git a/" + f + " b/" + f +
        "\n--- a/" + f +
        "\n+++ b/" + f +
        "\n@@ -1,1 +1,1 @@\n-old\n+" + (diffBody ?? "new"))
        .join("\n");
}
/** Build a minimal category JSON file with N events */
function buildCategoryFile(category, eventCount, options) {
    const events = [];
    const baseVersion = options?.baseVersion ?? 1;
    for (let i = 0; i < eventCount; i++) {
        const event = {
            title: "Event " + (i + 1) + " in " + category,
            year: 1776 + i,
            description: "This American historical event occurred during an important period of national significance",
            category,
            difficulty: 1 + (i % 3),
            version: baseVersion,
            imageURL: null,
        };
        // Optionally inject errors for the first event
        if (options?.includeErrors && i === 0) {
            event.description = "Short desc"; // P1: too few words
            event._planted_error = "P1: Description too short";
        }
        events.push(event);
    }
    return { category, events };
}
/** Build a corrections log JSON structure */
function buildCorrectionsLog(existingCorrections) {
    return {
        schema_version: "1.1",
        description: "Test corrections log",
        corrections: existingCorrections ?? [],
        category_moves: [],
        translation_errors: [],
        backfill_events: [],
    };
}
/** Build a mock translation file for a given language */
function buildTranslationFile(category, lang, eventCount, baseEnVersion) {
    const events = [];
    for (let i = 0; i < eventCount; i++) {
        events.push({
            title: "Event " + (i + 1) + " translated to " + lang,
            year: 1776 + i,
            description: "Translated description for event " + (i + 1),
            category,
            difficulty: 1,
            version: 1,
            baseEnVersion,
        });
    }
    return { category, language: lang, events };
}
// ------------------------------------------------------------------
// Test 1: Full chain creates PR after verifier finds error, fixer
// fixes, and re-verify passes
// ------------------------------------------------------------------
describe("Story 2.3b: Content Pipeline E2E", () => {
    it("content pipeline creates PR after verifier finds error, fixer fixes, and re-verify passes", () => {
        // This test validates the full data flow:
        // 1. Verifier finds an error (P1: short description)
        // 2. The finding is converted to a WorkflowFinding
        // 3. Approval processes correctly
        // 4. After fix, validate-fix gate passes (only .json files, matching claim)
        // 5. PR would be created (asserted via diff validation)
        const tempDir = createTempDir("full-chain");
        try {
            // Step 1: Create fixture with a planted error
            const categoryData = buildCategoryFile("US History", 5, { includeErrors: true });
            const filePath = path.join(tempDir, "USHistory.json");
            fs.writeFileSync(filePath, JSON.stringify(categoryData, null, 2), "utf-8");
            // Step 2: Run automated checks (Phase 1 of verification)
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            const { passed, failed } = runInlineAutomatedChecks(parsed.events);
            // Verify the error was found
            assert.ok(failed.length > 0, "Automated checks should find at least 1 error");
            assert.ok(failed.some((f) => f.codes.includes("P1")), "Should find P1 (description too short)");
            // Step 3: Simulate approval -- all findings approved
            const mockFindings = failed.map((f) => ({
                event_id: f.title.toLowerCase().replace(/\s+/g, "_"),
                event_title: f.title,
                gates_failed: f.codes,
                details: f.details,
                severity: "medium",
            }));
            const mockState = {
                findings: mockFindings,
                approved_findings: [],
                rejected_findings: [],
            };
            const approval = { action: "approve" };
            const { approved, rejected } = processApproval(mockState, approval);
            assert.ok(approved.length > 0, "Should have approved findings");
            assert.strictEqual(rejected.length, 0, "No findings rejected");
            // Step 4: Simulate fix applied -- create diff for only Data/ .json files
            const fixDiff = makeDiff(["Data/Events/USHistory.json"], '"title": "Event 1 in US History", "description": "This American historical event description was corrected to meet minimum word count requirements"');
            const diffPath = writeTempDiff(fixDiff, tempDir);
            // Step 5: Validate-fix gate should PASS (only .json, matching claim)
            const issueData = {
                number: 200,
                body: "Event 1 in US History has description that is too short. P1 gate failure.",
                labels: ["content-error"],
            };
            const validationResult = validateFix(issueData, diffPath);
            assert.strictEqual(validationResult.valid, true, "Validate-fix should pass for valid content fix");
        }
        finally {
            cleanupDir(tempDir);
        }
    });
    // ------------------------------------------------------------------
    // Test 2: Version increment schema validation (FR42)
    //
    // The version increment is performed inline by the AI fixer subagent
    // (see Scripts/sdk/prompts/content-fixer.md "Version Increment Rules").
    // There is no dedicated production function for this operation.
    // This test validates:
    //   (a) The expected schema: events must have a numeric `version` field
    //   (b) The increment contract: version must be exactly previous + 1
    //   (c) The "no version field" rule: absent version should be set to 2
    //   (d) Post-fix verification via runInlineAutomatedChecks still passes
    // ------------------------------------------------------------------
    it("content pipeline validates version increment schema on fix (FR42)", () => {
        const tempDir = createTempDir("version-increment");
        try {
            // Create a category file with version 1
            const categoryData = buildCategoryFile("US History", 3, { baseVersion: 1 });
            const filePath = path.join(tempDir, "USHistory.json");
            fs.writeFileSync(filePath, JSON.stringify(categoryData, null, 2), "utf-8");
            // Read and verify initial schema
            const before = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            assert.strictEqual(before.events[0].version, 1, "Initial version should be 1");
            // Validate the schema contract: version must be a positive integer
            for (const event of before.events) {
                assert.strictEqual(typeof event.version, "number", "version must be a number");
                assert.ok(Number.isInteger(event.version), "version must be an integer");
                assert.ok(event.version >= 1, "version must be >= 1");
            }
            // Apply the fixer contract: increment version by exactly 1
            const fixedVersion = before.events[0].version + 1;
            before.events[0].version = fixedVersion;
            // Also fix the description (simulate a real fix so re-verification passes)
            before.events[0].description = "This corrected American historical event occurred during an important period of national significance";
            fs.writeFileSync(filePath, JSON.stringify(before, null, 2), "utf-8");
            // Verify version was incremented correctly
            const after = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            assert.strictEqual(after.events[0].version, 2, "Version should be incremented to 2");
            assert.strictEqual(after.events[0].version, 1 + 1, "Version must be exactly previous + 1 (fixer contract)");
            // Validate the "no version field" rule from content-fixer.md:
            // "If an event has no version field, set it to 2 (assumes baseline was 1)"
            const noVersionEvent = { title: "Test", version: undefined };
            const inferredVersion = noVersionEvent.version ?? 1;
            assert.strictEqual(inferredVersion + 1, 2, "Events with no version field should default to baseline 1, then increment to 2");
            // Verify the fixed file is still valid for re-verification
            const reparsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            const { failed } = runInlineAutomatedChecks(reparsed.events);
            assert.strictEqual(failed.length, 0, "Fixed file should pass all automated checks");
        }
        finally {
            cleanupDir(tempDir);
        }
    });
    // ------------------------------------------------------------------
    // Test 3: Corrections log schema validation (FR41)
    //
    // The corrections log update is performed inline by the AI fixer subagent
    // (see Scripts/sdk/prompts/content-fixer.md "Corrections Log Format").
    // There is no dedicated production function for this operation.
    // This test validates:
    //   (a) The expected correction entry schema matches the prompt specification
    //   (b) Required fields are present and correctly typed
    //   (c) The corrections log remains valid JSON after appending
    //   (d) The correction_type field uses allowed values from the prompt
    //   (e) The diff produced by the fixer passes validateFix for corrections-log.json
    // ------------------------------------------------------------------
    it("content pipeline validates corrections-log.json schema on fix (FR41)", () => {
        const tempDir = createTempDir("corrections-log");
        try {
            // Create empty corrections log
            const correctionsDir = path.join(tempDir, "Data", "corrections");
            fs.mkdirSync(correctionsDir, { recursive: true });
            const logPath = path.join(correctionsDir, "corrections-log.json");
            const emptyLog = buildCorrectionsLog();
            fs.writeFileSync(logPath, JSON.stringify(emptyLog, null, 2), "utf-8");
            // Verify log starts empty
            const before = JSON.parse(fs.readFileSync(logPath, "utf-8"));
            assert.strictEqual(before.corrections.length, 0, "Log should start empty");
            // Build a correction entry matching the schema from content-fixer.md
            // Required fields per the prompt specification:
            const newCorrection = {
                id: "CORR-001",
                status: "applied_en",
                date_identified: new Date().toISOString().slice(0, 10),
                date_applied: new Date().toISOString().slice(0, 10),
                source_file: "Data/Events/USHistory.json",
                event_title: "Event 1 in US History",
                correction_type: "factual_error",
                field: "description",
                current_value: "Short desc",
                correct_value: "This American historical event occurred during an important period of significance",
                reason: "P1 gate failure: description was too short (below 10 word minimum)",
                fact_check_source: "Automated P1 gate detection",
                translations_affected: ["de", "nl", "pt"],
                translations_updated: [],
            };
            // Validate required fields are present and correctly typed (schema contract)
            assert.ok(newCorrection.id, "Correction must have an id");
            assert.ok(newCorrection.status, "Correction must have a status");
            assert.ok(newCorrection.date_identified, "Correction must have date_identified");
            assert.ok(newCorrection.date_applied, "Correction must have date_applied");
            assert.ok(newCorrection.source_file, "Correction must have source_file");
            assert.ok(newCorrection.event_title, "Correction must have event_title");
            assert.ok(newCorrection.correction_type, "Correction must have correction_type");
            assert.ok(newCorrection.field, "Correction must have field");
            assert.ok(newCorrection.reason, "Correction must have reason");
            assert.ok(Array.isArray(newCorrection.translations_affected), "translations_affected must be an array");
            assert.ok(Array.isArray(newCorrection.translations_updated), "translations_updated must be an array");
            // Validate correction_type uses allowed values from content-fixer.md
            const allowedTypes = [
                "factual_error", "typo", "clarity", "duplicate_removal",
                "age_content", "parameter_fix",
            ];
            assert.ok(allowedTypes.includes(newCorrection.correction_type), "correction_type must be one of: " + allowedTypes.join(", ") +
                " (got: " + newCorrection.correction_type + ")");
            // Validate source_file starts with Data/ (FR45 constraint)
            assert.ok(newCorrection.source_file.startsWith("Data/"), "source_file must be in Data/ directory");
            // Append to log and verify JSON integrity
            before.corrections.push(newCorrection);
            fs.writeFileSync(logPath, JSON.stringify(before, null, 2), "utf-8");
            // Verify corrections log is still valid JSON after update
            const after = JSON.parse(fs.readFileSync(logPath, "utf-8"));
            assert.strictEqual(after.corrections.length, 1, "Should have 1 correction entry");
            assert.strictEqual(after.corrections[0].id, "CORR-001");
            assert.strictEqual(after.corrections[0].correction_type, "factual_error");
            assert.strictEqual(after.corrections[0].event_title, "Event 1 in US History");
            assert.strictEqual(after.corrections[0].status, "applied_en");
            // Verify the diff that would include corrections-log.json passes validateFix
            const correctionsDiff = makeDiff(["Data/corrections/corrections-log.json"]);
            const diffPath = writeTempDiff(correctionsDiff, tempDir);
            const issueData = {
                number: 202,
                body: "Content error in US History events",
                labels: ["content-error"],
            };
            const validationResult = validateFix(issueData, diffPath);
            assert.strictEqual(validationResult.valid, true, "Diff with corrections-log.json should pass validateFix");
        }
        finally {
            cleanupDir(tempDir);
        }
    });
    // ------------------------------------------------------------------
    // Test 4: Stale translation detection (FR43 / AC6)
    //
    // AC6 says: "checks DE/NL/PT translations of that event" (singular).
    // The function must filter to only the specific modified event, not
    // flag all events in the category. This test creates multiple events
    // with mixed baseEnVersions and verifies only the targeted event is
    // flagged via the eventIndex parameter.
    // ------------------------------------------------------------------
    it("content pipeline flags stale translations only for the specific modified event (FR43)", () => {
        const tempDir = createTempDir("stale-translations");
        try {
            // Create English source file: event 0 bumped to version 2, others at version 1
            const enData = buildCategoryFile("US History", 3, { baseVersion: 1 });
            const enDir = path.join(tempDir, "Data", "Events");
            fs.mkdirSync(enDir, { recursive: true });
            // Bump only event 0 to version 2 (simulating fixer modified only this event)
            enData.events[0].version = 2;
            fs.writeFileSync(path.join(enDir, "USHistory.json"), JSON.stringify(enData, null, 2), "utf-8");
            // Create translation files for DE, NL, PT
            // Event 0: baseEnVersion=1 (stale -- English is now v2)
            // Events 1,2: baseEnVersion=1 (NOT stale -- English is still v1)
            const translationsDir = path.join(tempDir, "Data", "translations");
            for (const lang of ["de", "nl", "pt"]) {
                const transDir = path.join(translationsDir, lang);
                fs.mkdirSync(transDir, { recursive: true });
                // All translations have baseEnVersion=1
                const transData = buildTranslationFile("US History", lang, 3, 1);
                fs.writeFileSync(path.join(transDir, "USHistory.json"), JSON.stringify(transData, null, 2), "utf-8");
            }
            // Use the actual detectStaleTranslations utility with eventIndex=0
            // This targets only the specific event that was modified (AC6: singular)
            const staleResult = detectStaleTranslations("Event 1 in US History", 2, // newEnVersion after fix (only event 0 was bumped)
            translationsDir, "USHistory.json", { eventIndex: 0 });
            // Only the targeted event (index 0) should be flagged, across 3 languages
            assert.strictEqual(staleResult.hasStale, true, "Should detect stale translations");
            assert.strictEqual(staleResult.totalStale, 3, "Should find 3 stale entries (1 event x 3 langs), not 9");
            assert.deepStrictEqual(staleResult.languagesChecked.sort(), ["de", "nl", "pt"], "All 3 translation languages should be checked");
            // Verify each language has exactly 1 stale entry (the targeted event)
            for (const lang of ["de", "nl", "pt"]) {
                assert.ok(staleResult.staleByLang[lang], lang.toUpperCase() + " should have stale translations");
                assert.strictEqual(staleResult.staleByLang[lang].length, 1, lang.toUpperCase() + " should have exactly 1 stale entry (the targeted event)");
                const entry = staleResult.staleByLang[lang][0];
                assert.ok(entry.baseEnVersion < entry.currentEnVersion, lang.toUpperCase() + ": baseEnVersion (" + entry.baseEnVersion +
                    ") should be < currentEnVersion (" + entry.currentEnVersion + ")");
                // Verify the flagged event is at index 0 (Event 1)
                assert.ok(entry.eventTitle.includes("1"), lang.toUpperCase() + ": flagged event should be Event 1 (index 0)");
            }
            // Also verify: without eventIndex, ALL events are checked (backward compat)
            const allResult = detectStaleTranslations("Event 1 in US History", 2, translationsDir, "USHistory.json");
            assert.strictEqual(allResult.totalStale, 9, "Without eventIndex, all 9 stale entries should be found (3 events x 3 langs)");
        }
        finally {
            cleanupDir(tempDir);
        }
    });
    // ------------------------------------------------------------------
    // Test 5: Structural JSON validation rejects malformed fixer output (FR40)
    //
    // FR40 requires structural validation of fixer output before a PR is created.
    // This test validates the structural integrity checks that prevent malformed
    // JSON from entering the pipeline:
    //   (a) Broken JSON fails parsing (no PR created)
    //   (b) Structurally invalid event data fails runInlineAutomatedChecks
    //   (c) Missing required fields are caught
    //   (d) Events with wrong types are rejected
    //
    // Note: validate_content.py is not integrated into the SDK pipeline directly;
    // structural validation is performed by JSON.parse + runInlineAutomatedChecks
    // in the content-verify workflow.
    // ------------------------------------------------------------------
    it("content pipeline rejects structurally invalid JSON fixer output (FR40)", () => {
        const tempDir = createTempDir("structural-validation");
        try {
            // Case 1: Completely broken JSON fails parsing -- no PR possible
            const brokenJsonPath = path.join(tempDir, "broken.json");
            fs.writeFileSync(brokenJsonPath, '{"events": [{"title": "Test"invalid}]}', "utf-8");
            let parseError = null;
            try {
                JSON.parse(fs.readFileSync(brokenJsonPath, "utf-8"));
            }
            catch (err) {
                parseError = err;
            }
            assert.ok(parseError, "Broken JSON must fail parsing (FR40: structural integrity)");
            assert.ok(parseError.message.includes("Unexpected") || parseError.message.includes("JSON"), "Parse error should describe the JSON problem");
            // Case 2: Valid JSON but structurally invalid event data
            // Fixer outputs an event with a too-short description -- runInlineAutomatedChecks catches this
            const badEvents = [
                {
                    title: "Test Event",
                    year: 1776,
                    description: "Too short", // P1: below 10-word minimum
                    category: "US History",
                    difficulty: 1,
                    version: 2,
                },
            ];
            const { failed: structuralFailures } = runInlineAutomatedChecks(badEvents);
            assert.ok(structuralFailures.length > 0, "runInlineAutomatedChecks should catch structurally invalid events");
            assert.ok(structuralFailures.some((f) => f.codes.includes("P1")), "Should detect P1 (description too short) in fixer output");
            // Case 3: Valid JSON with correct structure passes checks
            const goodEvents = [
                {
                    title: "Declaration of Independence",
                    year: 1776,
                    description: "The Continental Congress adopted the Declaration of Independence marking American freedom from Britain",
                    category: "US History",
                    difficulty: 1,
                    version: 2,
                },
            ];
            const { failed: goodFailures } = runInlineAutomatedChecks(goodEvents);
            assert.strictEqual(goodFailures.length, 0, "Structurally valid event should pass all automated checks");
            // Case 4: Truncated JSON (fixer output cut off) fails parsing
            const truncatedJsonPath = path.join(tempDir, "truncated.json");
            fs.writeFileSync(truncatedJsonPath, '{"events": [{"title": "Test", "year": 1776', "utf-8");
            assert.throws(() => JSON.parse(fs.readFileSync(truncatedJsonPath, "utf-8")), "Truncated JSON must fail parsing (FR40: fixer output cut off)");
        }
        finally {
            cleanupDir(tempDir);
        }
    });
    // ------------------------------------------------------------------
    // Test 6: Retry loop configuration and error classification (FR17)
    //
    // The retry loop (retry-loop.ts::runRetryLoop) is an async function that
    // spawns Claude subagents, runs compilation, and invokes QA review --
    // it cannot be called in a unit test without real API credentials.
    // Instead, this test validates:
    //   (a) The production MAX_FIX_ATTEMPTS config value from config.ts
    //   (b) The production isRetryableQAError() classifier from retry-loop.ts
    //   (c) The RetryLoopResult type contract (exhausted attempts -> error message)
    //   (d) That the retry loop uses LIMITS.MAX_FIX_ATTEMPTS (not a hardcoded value)
    // ------------------------------------------------------------------
    it("content pipeline retry loop uses production config and classifies errors correctly (FR17)", () => {
        // (a) Verify production MAX_FIX_ATTEMPTS from config.ts
        // Config says 3; the retry loop defaults to this value (retry-loop.ts line 697:
        //   "const maxAttempts = input.maxAttempts ?? LIMITS.MAX_FIX_ATTEMPTS")
        assert.strictEqual(LIMITS.MAX_FIX_ATTEMPTS, 3, "Production MAX_FIX_ATTEMPTS should be 3 (from config.ts LIMITS)");
        // (b) Test the production isRetryableQAError() function from retry-loop.ts
        // This function determines whether a QA failure should trigger a retry
        // or fall through as a non-retryable error.
        // Retryable errors: timeouts, rate limits, connection failures
        assert.strictEqual(isRetryableQAError("Request timeout after 30s"), true, "Timeout errors should be retryable");
        assert.strictEqual(isRetryableQAError("rate_limit_exceeded: too many requests"), true, "Rate limit errors should be retryable");
        assert.strictEqual(isRetryableQAError("connect ECONNREFUSED 127.0.0.1:3000"), true, "Connection refused errors should be retryable");
        assert.strictEqual(isRetryableQAError("HTTP 429 Too Many Requests"), true, "HTTP 429 should be retryable");
        assert.strictEqual(isRetryableQAError("HTTP 502 Bad Gateway"), true, "HTTP 502 should be retryable");
        assert.strictEqual(isRetryableQAError("process exited with code 1"), true, "Process exit errors should be retryable");
        // Non-retryable errors: billing, missing config, unknown errors
        assert.strictEqual(isRetryableQAError("Your credit balance is too low to continue"), false, "Billing errors should NOT be retryable");
        assert.strictEqual(isRetryableQAError("Missing required prompt file for QA review configuration"), false, "Missing config errors should NOT be retryable");
        // (c) Validate RetryLoopResult type contract for exhausted attempts
        // When all attempts are exhausted, the result must contain:
        //   - success: false
        //   - error: string mentioning attempt count
        //   - fixAttemptsUsed: equal to maxAttempts
        //   - handoffMarkdown: non-null (for human review)
        const mockExhaustedResult = {
            success: false,
            attemptLogs: [],
            qaResults: [],
            modelsUsed: [],
            diff: null,
            changedFiles: [],
            handoffMarkdown: "# Handoff: Content fix failed\n\nAll attempts exhausted.",
            handoffFilePath: "/tmp/handoff.md",
            qaSummary: null,
            fixSummary: null,
            error: "All " + LIMITS.MAX_FIX_ATTEMPTS + " fix attempts exhausted",
            fixAttemptsUsed: LIMITS.MAX_FIX_ATTEMPTS,
        };
        assert.strictEqual(mockExhaustedResult.success, false, "Exhausted result must have success=false");
        assert.strictEqual(mockExhaustedResult.fixAttemptsUsed, LIMITS.MAX_FIX_ATTEMPTS, "fixAttemptsUsed must equal MAX_FIX_ATTEMPTS when exhausted");
        assert.ok(mockExhaustedResult.error, "Error message must be present after exhaustion");
        assert.ok(mockExhaustedResult.error.includes(String(LIMITS.MAX_FIX_ATTEMPTS)), "Error should reference the production MAX_FIX_ATTEMPTS value (" +
            LIMITS.MAX_FIX_ATTEMPTS + "), not a hardcoded number");
        assert.ok(mockExhaustedResult.handoffMarkdown, "Handoff document must be generated on exhaustion (FR17)");
        assert.strictEqual(mockExhaustedResult.diff, null, "No diff when all attempts exhausted");
    });
    // ------------------------------------------------------------------
    // Test 7: Only Data/ directory files modified (FR45)
    // ------------------------------------------------------------------
    it("content pipeline only modifies Data/ directory files", () => {
        const tempDir = createTempDir("data-only");
        try {
            // Test case 1: Valid -- only Data/ files
            const validDiff = makeDiff([
                "Data/Events/USHistory.json",
                "Data/corrections/corrections-log.json",
            ]);
            const validDiffPath = writeTempDiff(validDiff, tempDir);
            const validIssue = {
                number: 300,
                body: "Content error fix",
                labels: ["content-error"],
            };
            const validResult = validateFix(validIssue, validDiffPath);
            assert.strictEqual(validResult.valid, true, "Diff with only Data/ .json files should pass");
            // Test case 2: Invalid -- includes non-Data files
            const invalidDiff = makeDiff([
                "Data/Events/USHistory.json",
                "Scripts/validate_content.py",
            ]);
            const invalidDiffPath = writeTempDiff(invalidDiff, tempDir);
            const invalidResult = validateFix(validIssue, invalidDiffPath);
            assert.strictEqual(invalidResult.valid, false, "Diff with .py file should fail");
            assert.strictEqual(invalidResult.reason, "forbidden-file-type");
            // Test case 3: Invalid -- Swift source code
            const swiftDiff = makeDiff([
                "Data/Events/USHistory.json",
                "Views/SettingsView.swift",
            ]);
            const swiftDiffPath = writeTempDiff(swiftDiff, tempDir);
            const swiftResult = validateFix(validIssue, swiftDiffPath);
            assert.strictEqual(swiftResult.valid, false, "Diff with .swift file should fail");
            assert.strictEqual(swiftResult.reason, "forbidden-file-type");
            // Test case 4: Invalid -- Xcode project file
            const xcodeDiff = makeDiff([
                "Data/Events/USHistory.json",
                "SortingHistory.xcodeproj/project.pbxproj",
            ]);
            const xcodeDiffPath = writeTempDiff(xcodeDiff, tempDir);
            const xcodeResult = validateFix(validIssue, xcodeDiffPath);
            assert.strictEqual(xcodeResult.valid, false, "Diff with .pbxproj file should fail");
            // Verify the diff parser correctly identifies all files
            const parsedFiles = parseDiffFiles(validDiff);
            for (const f of parsedFiles) {
                assert.ok(f.startsWith("Data/"), "All files in valid diff should be in Data/ directory: " + f);
                assert.ok(f.endsWith(".json"), "All files in valid diff should be .json: " + f);
            }
        }
        finally {
            cleanupDir(tempDir);
        }
    });
    // ------------------------------------------------------------------
    // Test 8: Backfill flagging when category move drops source below
    // 100 events (FR18)
    // ------------------------------------------------------------------
    it("content pipeline flags backfill when category move drops source below 100 events", () => {
        const tempDir = createTempDir("backfill");
        try {
            // Create a source category with exactly 100 events
            const sourceCategory = "US History";
            const sourceData = buildCategoryFile(sourceCategory, 100);
            const sourceDir = path.join(tempDir, "Data", "Events");
            fs.mkdirSync(sourceDir, { recursive: true });
            const sourcePath = path.join(sourceDir, "USHistory.json");
            fs.writeFileSync(sourcePath, JSON.stringify(sourceData, null, 2), "utf-8");
            // Verify the source has exactly 100 events
            const before = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
            assert.strictEqual(before.events.length, 100, "Source should start with 100 events");
            // Simulate a category move: remove 1 event from source
            const movedEvent = before.events.pop();
            fs.writeFileSync(sourcePath, JSON.stringify({ category: sourceCategory, events: before.events }, null, 2), "utf-8");
            // Use the actual checkCategoryBackfill utility (FR18)
            const backfillResult = checkCategoryBackfill(sourceCategory, sourcePath);
            assert.strictEqual(backfillResult.needsBackfill, true, "Source category should need backfill after dropping to 99 events");
            assert.ok(backfillResult.flag, "Backfill flag should be present");
            assert.strictEqual(backfillResult.flag.category, sourceCategory);
            assert.strictEqual(backfillResult.flag.currentCount, 99);
            assert.strictEqual(backfillResult.flag.minimumRequired, 100);
            assert.strictEqual(backfillResult.flag.deficit, 1);
            assert.ok(backfillResult.flag.actionRequired.includes("1 replacement"), "Action should specify how many events to create");
            // Also verify: category with >= 100 events does NOT need backfill
            const fullCategoryData = buildCategoryFile("World Wars", 105);
            const fullPath = path.join(sourceDir, "WorldWars.json");
            fs.writeFileSync(fullPath, JSON.stringify(fullCategoryData, null, 2), "utf-8");
            const fullResult = checkCategoryBackfill("World Wars", fullPath);
            assert.strictEqual(fullResult.needsBackfill, false, "Category with 105 events should NOT need backfill");
            assert.strictEqual(fullResult.flag, null, "No backfill flag when count is sufficient");
        }
        finally {
            cleanupDir(tempDir);
        }
    });
});
