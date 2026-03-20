import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractJson } from "../lib/json-extract.js";
describe("extractJson — no requiredKey", () => {
    it("raw JSON passthrough", () => {
        const input = '{"key": "value"}';
        const result = extractJson(input);
        assert.equal(result, '{"key": "value"}');
        const parsed = JSON.parse(result);
        assert.equal(parsed.key, "value");
    });
    it("extracts from markdown code block", () => {
        const input = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
        const result = extractJson(input);
        const parsed = JSON.parse(result);
        assert.equal(parsed.key, "value");
    });
    it("extracts from code block without json tag", () => {
        const input = 'Result:\n```\n{"key": "value"}\n```';
        const result = extractJson(input);
        const parsed = JSON.parse(result);
        assert.equal(parsed.key, "value");
    });
    it("extracts from brace boundaries (narrative wrapping)", () => {
        const input = 'The result is {"key": "value"} as shown.';
        const result = extractJson(input);
        const parsed = JSON.parse(result);
        assert.equal(parsed.key, "value");
    });
    it("handles empty/whitespace input", () => {
        const input = "   ";
        const result = extractJson(input);
        // Should return trimmed empty string without crashing
        assert.equal(result, "");
    });
    it("returns original if no JSON found", () => {
        const input = "No JSON here at all";
        const result = extractJson(input);
        // Falls through to passthrough — returns trimmed original
        assert.equal(result, "No JSON here at all");
    });
});
describe("extractJson — with requiredKey", () => {
    it("selects object containing requiredKey from multiple", () => {
        const input = '{"event": "data"}\n{"classification": "content_error"}';
        const result = extractJson(input, "classification");
        const parsed = JSON.parse(result);
        assert.equal(parsed.classification, "content_error");
        assert.ok(!("event" in parsed), "Should not return the first object");
    });
    it("selects from code block when requiredKey matches", () => {
        const input = '```json\n{"classification": "ui_bug"}\n```';
        const result = extractJson(input, "classification");
        const parsed = JSON.parse(result);
        assert.equal(parsed.classification, "ui_bug");
    });
    it("falls through when requiredKey not found in any candidate", () => {
        const input = '{"other": "data"}';
        const result = extractJson(input, "classification");
        // requiredKey not found in any candidate, falls through to normal extraction
        // The brace scan in the non-requiredKey path should still extract the JSON
        const parsed = JSON.parse(result);
        assert.equal(parsed.other, "data");
    });
    it("handles nested braces in string values", () => {
        const input = 'Here is {"description": "value is {something}", "classification": "content_error"}';
        const result = extractJson(input, "classification");
        const parsed = JSON.parse(result);
        assert.equal(parsed.classification, "content_error");
        assert.equal(parsed.description, "value is {something}");
    });
    it("handles escaped quotes in string values", () => {
        const input = '{"title": "He said \\"hello\\"", "classification": "ui_bug"}';
        const result = extractJson(input, "classification");
        const parsed = JSON.parse(result);
        assert.equal(parsed.classification, "ui_bug");
        assert.equal(parsed.title, 'He said "hello"');
    });
});
