/**
 * PV2-6.2: QA Profile Tests
 *
 * Tests determineQAProfile() returns the correct profile for
 * different file extension combinations.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { determineQAProfile } from "../lib/model-router.js";
describe("qa-profile: determineQAProfile", () => {
    it("only .swift files changed → code", () => {
        assert.equal(determineQAProfile([".swift"]), "code");
    });
    it("only .json files changed → content", () => {
        assert.equal(determineQAProfile([".json"]), "content");
    });
    it("both .swift and .json changed → both", () => {
        assert.equal(determineQAProfile([".swift", ".json"]), "both");
    });
    it(".pbxproj only → code", () => {
        assert.equal(determineQAProfile([".pbxproj"]), "code");
    });
    it(".strings only → content", () => {
        assert.equal(determineQAProfile([".strings"]), "content");
    });
    it("empty file list → code (safe default, PV2-6.4 fix)", () => {
        assert.equal(determineQAProfile([]), "code");
    });
    it("unrecognized extension (.xcscheme) → code (safe default)", () => {
        assert.equal(determineQAProfile([".xcscheme"]), "code");
    });
    it("unrecognized extension (.md) → code (safe default)", () => {
        assert.equal(determineQAProfile([".md"]), "code");
    });
    it("mixed code + content + unknown → both", () => {
        assert.equal(determineQAProfile([".swift", ".json", ".md"]), "both");
    });
    it(".stringsdict only → content", () => {
        assert.equal(determineQAProfile([".stringsdict"]), "content");
    });
});
