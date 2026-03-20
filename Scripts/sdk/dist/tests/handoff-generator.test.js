/**
 * PV2-6.2: Handoff Generator Tests
 *
 * Tests generateHandoff() for Tier 3 and Tier 4 handoff documents.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { generateHandoff } from "../lib/handoff-generator.js";
function makeTier3Input() {
    return {
        issueNumber: 87,
        issueTitle: "Whiskey Rebellion date wrong",
        issueBody: "The Whiskey Rebellion event shows 1791 but it was 1794.",
        triageClassification: "content_error",
        triageSeverity: "P3",
        triageReasoning: "Content error: incorrect date for historical event",
        extractedContext: {
            category: "US History",
            file_path: "Data/USHistory.json",
            event_id: "whiskey-rebellion",
        },
        attemptLogs: [
            {
                attempt_number: 1,
                model: "claude-sonnet-4-5-20250929",
                approach: "Direct JSON edit to fix date",
                result: "qa_rejected",
                error_summary: "QA found that the description also references the wrong year",
            },
            {
                attempt_number: 2,
                model: "claude-sonnet-4-5-20250929",
                approach: "Fix date and description together",
                result: "compilation_error",
                error_summary: "JSON syntax error introduced",
            },
        ],
        qaResults: [
            {
                attempt_number: 1,
                verdict: "rejected",
                findings: ["Date fixed but description still says 1791"],
                summary: "Partial fix — description inconsistency remains",
            },
        ],
        screenshotCount: 1,
        suggestedApproach: "Edit both the date field and the description text in USHistory.json",
        failureReason: "All automated fix attempts exhausted",
        tier: 3,
    };
}
function makeTier4Input() {
    return {
        ...makeTier3Input(),
        tier: 4,
        humanQuestion: "This event appears in both USHistory.json and WorldWars.json. Which file should contain it?",
    };
}
describe("handoff-generator: Tier 3", () => {
    it("markdown contains all required sections", () => {
        const result = generateHandoff(makeTier3Input());
        assert.ok(result.markdown.includes("# Pipeline Handoff: Issue #87"));
        assert.ok(result.markdown.includes("Whiskey Rebellion date wrong"));
        assert.ok(result.markdown.includes("Tier:** 3"));
        assert.ok(result.markdown.includes("## Bug Summary"));
        assert.ok(result.markdown.includes("## Extracted Context"));
        assert.ok(result.markdown.includes("## Original Report"));
        assert.ok(result.markdown.includes("## What Was Tried"));
        assert.ok(result.markdown.includes("## Why the Pipeline Stopped"));
        assert.ok(result.markdown.includes("## Suggested Approach"));
        assert.ok(result.markdown.includes("## How to Fix"));
        // Should NOT contain human decision section for Tier 3
        assert.ok(!result.markdown.includes("## Human Decision Needed"));
    });
    it("file path follows expected convention", () => {
        const result = generateHandoff(makeTier3Input());
        assert.equal(result.filePath, ".bmad/handoffs/pipeline/issue-87-handoff.md");
    });
    it("attempt logs are rendered with details", () => {
        const result = generateHandoff(makeTier3Input());
        assert.ok(result.markdown.includes("### Attempt 1"));
        assert.ok(result.markdown.includes("### Attempt 2"));
        assert.ok(result.markdown.includes("claude-sonnet-4-5-20250929"));
        assert.ok(result.markdown.includes("QA rejected"));
        assert.ok(result.markdown.includes("Compilation failed"));
    });
    it("extracted context is formatted", () => {
        const result = generateHandoff(makeTier3Input());
        assert.ok(result.markdown.includes("US History"));
        assert.ok(result.markdown.includes("Data/USHistory.json"));
    });
    it("screenshot count is included", () => {
        const result = generateHandoff(makeTier3Input());
        assert.ok(result.markdown.includes("**Screenshots:** 1"));
    });
});
describe("handoff-generator: Tier 4", () => {
    it("markdown contains humanQuestion in Human Decision Needed section", () => {
        const result = generateHandoff(makeTier4Input());
        assert.ok(result.markdown.includes("## Human Decision Needed"));
        assert.ok(result.markdown.includes("This event appears in both USHistory.json and WorldWars.json"));
    });
    it("Tier 4 label is correct", () => {
        const result = generateHandoff(makeTier4Input());
        assert.ok(result.markdown.includes("4 (Human decision needed)"));
    });
});
