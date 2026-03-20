/**
 * PV2-6.2: Triage Contract Tests
 *
 * Tests that triage output (JSON block in comment) is readable by the
 * bug-fix consumer. Validates the PV2-6.1 typed interface roundtrip.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildClassificationComment } from "../workflows/triage.js";
import { extractTriageFromComments } from "../workflows/bug-fix.js";
/** A realistic TriageResult matching the interface from bug-triage.ts */
function makeSampleTriage() {
    return {
        classification: "gameplay_bug",
        confidence: 0.92,
        severity: "P2",
        reasoning: "Category selection not persisting across sessions",
        extracted_context: {
            category: "US History",
            file_path: "Views/GameSetupView.swift",
            event_id: null,
            expected_behavior: "Category selection should persist",
            actual_behavior: "Category resets on app restart",
        },
        routing_recommendation: "auto_fix",
    };
}
describe("triage-contract: buildClassificationComment", () => {
    it("output contains parseable JSON block", () => {
        const comment = buildClassificationComment(makeSampleTriage());
        // Must contain the delimiters
        assert.ok(comment.includes("<!-- TRIAGE_DATA_START"));
        assert.ok(comment.includes("TRIAGE_DATA_END -->"));
        // Extract and parse the JSON
        const match = comment.match(/<!-- TRIAGE_DATA_START\n```json\n([\s\S]*?)\n```\nTRIAGE_DATA_END -->/);
        assert.ok(match, "JSON block not found in comment");
        const parsed = JSON.parse(match[1]);
        assert.equal(typeof parsed.classification, "string");
        assert.equal(typeof parsed.severity, "string");
        assert.equal(typeof parsed.confidence, "number");
    });
});
describe("triage-contract: extractTriageFromComments", () => {
    it("correctly parses the JSON block and returns all fields", () => {
        const comment = buildClassificationComment(makeSampleTriage());
        const result = extractTriageFromComments([{ body: comment }]);
        assert.ok(result, "extractTriageFromComments returned null");
        assert.equal(result.classification, "gameplay_bug");
        assert.equal(result.severity, "P2");
        assert.equal(result.confidence, 0.92);
        assert.equal(result.reasoning, "Category selection not persisting across sessions");
        assert.equal(result.extracted_context.file_path, "Views/GameSetupView.swift");
        assert.equal(result.extracted_context.category, "US History");
    });
    it("comment with NO JSON block (legacy) returns null", () => {
        const legacyComment = [
            "## Triage Classification",
            "",
            "| Field | Value |",
            "|-------|-------|",
            "| Classification | `ui_bug` |",
            "| Severity | `P3` |",
            "| Confidence | 85% |",
        ].join("\n");
        const result = extractTriageFromComments([{ body: legacyComment }]);
        assert.equal(result, null);
    });
    it("comment with malformed JSON block returns null (not crash)", () => {
        const malformedComment = [
            "## Triage Classification",
            "",
            "<!-- TRIAGE_DATA_START",
            "```json",
            "{invalid json here!!!",
            "```",
            "TRIAGE_DATA_END -->",
        ].join("\n");
        const result = extractTriageFromComments([{ body: malformedComment }]);
        assert.equal(result, null);
    });
});
describe("triage-contract: roundtrip", () => {
    it("build comment → extract triage data → all fields match original", () => {
        const original = makeSampleTriage();
        const comment = buildClassificationComment(original);
        const extracted = extractTriageFromComments([{ body: comment }]);
        assert.ok(extracted, "roundtrip returned null");
        assert.equal(extracted.classification, original.classification);
        assert.equal(extracted.severity, original.severity);
        assert.equal(extracted.confidence, original.confidence);
        assert.equal(extracted.reasoning, original.reasoning);
        assert.equal(extracted.extracted_context.category, original.extracted_context.category);
        assert.equal(extracted.extracted_context.file_path, original.extracted_context.file_path);
        assert.equal(extracted.extracted_context.event_id, null);
        assert.equal(extracted.extracted_context.expected_behavior, original.extracted_context.expected_behavior);
        assert.equal(extracted.extracted_context.actual_behavior, original.extracted_context.actual_behavior);
    });
    it("re-triage uses most recent comment (reverse iteration)", () => {
        const oldTriage = makeSampleTriage();
        oldTriage.classification = "content_error";
        oldTriage.confidence = 0.6;
        const newTriage = makeSampleTriage();
        newTriage.classification = "gameplay_bug";
        newTriage.confidence = 0.95;
        const oldComment = buildClassificationComment(oldTriage);
        const newComment = buildClassificationComment(newTriage);
        // Old comment first, new comment second — extractor should pick the new one
        const result = extractTriageFromComments([
            { body: oldComment },
            { body: newComment },
        ]);
        assert.ok(result);
        assert.equal(result.classification, "gameplay_bug");
        assert.equal(result.confidence, 0.95);
    });
    it("comment with missing required fields returns null", () => {
        // JSON block with empty classification (fails validation)
        const badComment = [
            "<!-- TRIAGE_DATA_START",
            "```json",
            JSON.stringify({ classification: "", severity: "P2", confidence: 0.5, reasoning: "test", extracted_context: {} }),
            "```",
            "TRIAGE_DATA_END -->",
        ].join("\n");
        const result = extractTriageFromComments([{ body: badComment }]);
        assert.equal(result, null);
    });
});
