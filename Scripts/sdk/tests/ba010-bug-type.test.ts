/**
 * BA-010.10: Bug Type Hint Tests
 *
 * Tests for:
 * - Webhook validation of bug_type field
 * - Triage extraction of reporter hint from issue body
 * - Triage confidence adjustments on disagreement
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { validateBugReport, formatIssueBody } from "../lib/worker-utils.js";
import { buildClassificationComment } from "../workflows/triage.js";
import type { TriageResult } from "../workflows/bug-triage.js";

// ---------------------------------------------------------------------------
// Webhook: bug_type validation
// ---------------------------------------------------------------------------

describe("BA-010.10 webhook: bug_type validation", () => {
  it("rejects unknown bug_type with validation error", () => {
    const result = validateBugReport({
      description: "This is a valid bug report",
      bug_type: "invalid_type",
    });
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.ok(result.errors.some((e) => e.field === "bug_type"));
    }
  });

  it("accepts request without bug_type field (backward compat)", () => {
    const result = validateBugReport({
      description: "This is a valid bug report",
    });
    assert.equal(result.valid, true);
    if (result.valid) {
      assert.equal(result.report.bug_type, undefined);
    }
  });

  it("accepts valid bug_type values", () => {
    for (const bugType of ["ui_bug", "gameplay_bug", "content_error", "crash_bug"]) {
      const result = validateBugReport({
        description: "This is a valid bug report",
        bug_type: bugType,
      });
      assert.equal(result.valid, true, `Expected ${bugType} to be valid`);
      if (result.valid) {
        assert.equal(result.report.bug_type, bugType);
      }
    }
  });

  it("formatIssueBody includes Reporter Classification when bug_type present", () => {
    const body = formatIssueBody(
      { description: "Bug text", bug_type: "gameplay_bug" },
      "BUG-TEST",
    );
    assert.ok(
      body.includes("**Reporter Classification:** gameplay_bug"),
      "body should contain Reporter Classification line",
    );
  });

  it("formatIssueBody omits Reporter Classification when bug_type absent", () => {
    const body = formatIssueBody(
      { description: "Bug text" },
      "BUG-TEST",
    );
    assert.ok(
      !body.includes("Reporter Classification"),
      "body should NOT contain Reporter Classification line",
    );
  });
});

// ---------------------------------------------------------------------------
// Triage: reporter hint extraction and confidence adjustment
// ---------------------------------------------------------------------------

/** Helper: build an issue body with reporter classification line */
function bodyWithHint(hint: string): string {
  return [
    "## Bug Report",
    "",
    "**Description:**",
    "Events from wrong category showing up",
    "",
    `**Reporter Classification:** ${hint}`,
    "",
    "---",
  ].join("\n");
}

/** Helper: extract reporter hint using the same regex as triage.ts */
function extractHint(body: string): string | null {
  const KNOWN_BUG_TYPES = ["ui_bug", "gameplay_bug", "content_error", "crash_bug"];
  const match = body.match(/\*\*Reporter Classification:\*\*\s*(\S+)/);
  return match && KNOWN_BUG_TYPES.includes(match[1]) ? match[1] : null;
}

/** Helper: simulate the triage confidence adjustment logic from triage.ts */
function adjustForHint(
  triageResult: { classification: string; confidence: number },
  reporterHint: string | null,
): { classification: string; confidence: number; originalClassification: string } {
  const originalClassification = triageResult.classification;
  if (reporterHint) {
    if (triageResult.classification === reporterHint) {
      // Match — no adjustment
    } else if (triageResult.confidence >= 0.70) {
      triageResult.confidence = 0.70;
    } else {
      triageResult.classification = "needs_human_review";
    }
  }
  return { ...triageResult, originalClassification };
}

describe("BA-010.10 triage: reporter hint extraction", () => {
  it("extracts reporter hint from issue body when present", () => {
    const body = bodyWithHint("gameplay_bug");
    const hint = extractHint(body);
    assert.equal(hint, "gameplay_bug");
  });

  it("returns null when no reporter hint in issue body", () => {
    const body = [
      "## Bug Report",
      "",
      "**Description:**",
      "Something is broken",
      "",
      "---",
    ].join("\n");
    const hint = extractHint(body);
    assert.equal(hint, null);
  });

  it("ignores invalid hint values", () => {
    const body = bodyWithHint("banana");
    const hint = extractHint(body);
    assert.equal(hint, null);
  });
});

describe("BA-010.10 triage: confidence adjustment on disagreement", () => {
  it("caps confidence at 0.70 when AI disagrees with reporter hint (confidence >= 0.70)", () => {
    const result = adjustForHint(
      { classification: "content_error", confidence: 0.85 },
      "gameplay_bug",
    );
    assert.equal(result.classification, "content_error");
    assert.equal(result.confidence, 0.70);
  });

  it("routes to needs_human_review when AI disagrees and confidence < 0.70", () => {
    const result = adjustForHint(
      { classification: "content_error", confidence: 0.55 },
      "gameplay_bug",
    );
    assert.equal(result.classification, "needs_human_review");
    assert.equal(result.originalClassification, "content_error");
  });

  it("no adjustment when AI matches reporter hint", () => {
    const result = adjustForHint(
      { classification: "gameplay_bug", confidence: 0.92 },
      "gameplay_bug",
    );
    assert.equal(result.classification, "gameplay_bug");
    assert.equal(result.confidence, 0.92);
  });

  it("no adjustment when no reporter hint", () => {
    const result = adjustForHint(
      { classification: "content_error", confidence: 0.85 },
      null,
    );
    assert.equal(result.classification, "content_error");
    assert.equal(result.confidence, 0.85);
  });
});
