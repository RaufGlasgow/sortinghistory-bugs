import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateFix,
  parseDiffFiles,
  extractLangLabel,
  extractBugType,
  type IssueData,
} from "../lib/validate-fix.js";

/**
 * Tests for validate-fix (Story 2.0b).
 * AC10: At least 8 unit tests covering all validation checks.
 */

/** Helper: create a temp diff file with given content, return its path */
function writeTempDiff(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "validate-fix-test-"));
  const path = join(dir, "test.diff");
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Helper: build a minimal unified diff for given file paths */
function makeDiff(files: string[], diffBody?: string): string {
  return files
    .map(
      (f) =>
        "diff --git a/" +
        f +
        " b/" +
        f +
        "\n--- a/" +
        f +
        "\n+++ b/" +
        f +
        "\n@@ -1,1 +1,1 @@\n-old\n+" +
        (diffBody ?? "new"),
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// parseDiffFiles
// ---------------------------------------------------------------------------

describe("parseDiffFiles", () => {
  it("extracts file paths from git diff headers", () => {
    const diff =
      "diff --git a/Data/en/USHistory.json b/Data/en/USHistory.json\n" +
      "--- a/Data/en/USHistory.json\n+++ b/Data/en/USHistory.json\n";
    const files = parseDiffFiles(diff);
    assert.deepEqual(files, ["Data/en/USHistory.json"]);
  });

  it("falls back to +++ lines when no git diff headers", () => {
    const diff = "--- a/foo.json\n+++ b/bar.json\n";
    const files = parseDiffFiles(diff);
    assert.deepEqual(files, ["bar.json"]);
  });
});

// ---------------------------------------------------------------------------
// extractLangLabel / extractBugType
// ---------------------------------------------------------------------------

describe("extractLangLabel", () => {
  it("finds lang:de label", () => {
    assert.equal(extractLangLabel(["content-error", "lang:de"]), "de");
  });

  it("returns null when no lang label", () => {
    assert.equal(extractLangLabel(["content-error", "sdk-routed"]), null);
  });
});

describe("extractBugType", () => {
  it("detects content-error", () => {
    assert.equal(extractBugType(["content-error", "lang:de"]), "content-error");
  });

  it("detects translation-error", () => {
    assert.equal(extractBugType(["translation-error", "lang:nl"]), "translation-error");
  });

  it("returns null for other types", () => {
    assert.equal(extractBugType(["gameplay-bug"]), null);
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC3: Language match
// ---------------------------------------------------------------------------

describe("validateFix — language match", () => {
  it("AC3: fails when diff touches wrong language files", () => {
    const diff = makeDiff(["Data/en/USHistory.json"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 100,
      body: "Event 42 has wrong date",
      labels: ["content-error", "lang:de"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "language-mismatch");
    assert.ok(result.details!.includes("en/USHistory.json"));
  });

  it("AC3: passes when diff touches correct language files", () => {
    const diff = makeDiff(["Data/de/WorldHistory.json"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 100,
      body: "Event 42 has wrong date",
      labels: ["content-error", "lang:de"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC4: Diff-vs-claim
// ---------------------------------------------------------------------------

describe("validateFix — diff-vs-claim", () => {
  it("AC4: fails when diff does not touch claimed event ID", () => {
    const diff = makeDiff(["Data/USHistory.json"], "some unrelated change");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 101,
      body: "Event 42 has the wrong year. The battle was in 1815, not 1812.",
      labels: ["content-error"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "diff-claim-mismatch");
    assert.ok(result.details!.includes("42"));
  });

  it("AC4: passes when diff touches claimed event ID", () => {
    const diff = makeDiff(["Data/USHistory.json"], '"id": 42, "year": 1815');
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 101,
      body: "Event 42 has the wrong year.",
      labels: ["content-error"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC5: File type gate
// ---------------------------------------------------------------------------

describe("validateFix — file type gate", () => {
  it("AC5: fails when diff contains .ts file", () => {
    const diff = makeDiff(["Scripts/sdk/orchestrator.ts"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 102,
      body: "Event 42 wrong",
      labels: ["content-error"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "forbidden-file-type");
    assert.ok(result.details!.includes("orchestrator.ts"));
  });

  it("AC5: fails when diff contains .swift file", () => {
    const diff = makeDiff(["Views/GameView.swift"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 102,
      body: "Event 42 wrong",
      labels: ["content-error"], // no lang label so language check is skipped (AC11)
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "forbidden-file-type");
  });

  it("AC5: passes when only .json files modified", () => {
    const diff = makeDiff(["Data/WorldHistory.json"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 102,
      body: "Event 42 wrong date",
      labels: ["content-error"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC6: Empty diff
// ---------------------------------------------------------------------------

describe("validateFix — empty diff", () => {
  it("AC6: fails on empty diff", () => {
    const diffPath = writeTempDiff("");

    const issue: IssueData = {
      number: 103,
      body: "Some bug",
      labels: ["content-error"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "empty-diff");
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC7: Structured result
// ---------------------------------------------------------------------------

describe("validateFix — structured result", () => {
  it("AC7: failure result has reason and details", () => {
    const diff = makeDiff(["Views/BadFile.swift"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 104,
      body: "Event 42 wrong",
      labels: ["content-error"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.ok(result.reason, "reason must be non-empty");
    assert.ok(result.details, "details must be non-empty");
    assert.ok(result.details!.length > 0);
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC11: content-error without lang label
// ---------------------------------------------------------------------------

describe("validateFix — content-error without lang label (AC11)", () => {
  it("AC11: skips language check, returns valid if other checks pass", () => {
    const diff = makeDiff(["Data/USHistory.json"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 105,
      body: "Event 42 has wrong year",
      labels: ["content-error"], // no lang: label
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFix — AC12: translation-error missing lang label
// ---------------------------------------------------------------------------

describe("validateFix — translation-error missing lang label (AC12)", () => {
  it("AC12: fails when translation-error has no lang label", () => {
    const diff = makeDiff(["Data/de/Translations.json"], "42");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 106,
      body: "Translation of event 42 is wrong",
      labels: ["translation-error"], // no lang: label
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "missing-language-label");
  });
});

// ---------------------------------------------------------------------------
// validateFix — Combined pass (all checks succeed)
// ---------------------------------------------------------------------------

describe("validateFix — combined", () => {
  it("combined pass: all checks succeed for valid fix", () => {
    const diff = makeDiff(["Data/de/WorldHistory.json"], '"id": 42, "year": 1815');
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 107,
      body: "Event 42 in German translation has wrong year",
      labels: ["translation-error", "lang:de"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, true);
  });

  it("combined fail: multiple problems detected (first failure returned)", () => {
    // Empty diff = first failure
    const diffPath = writeTempDiff("");

    const issue: IssueData = {
      number: 108,
      body: "Event 42 wrong",
      labels: ["translation-error"], // also missing lang label
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, false);
    // Empty diff is checked first
    assert.equal(result.reason, "empty-diff");
  });

  it("non-pipeline issue type passes validation (no checks apply)", () => {
    const diff = makeDiff(["Views/GameView.swift"], "some fix");
    const diffPath = writeTempDiff(diff);

    const issue: IssueData = {
      number: 109,
      body: "UI is broken",
      labels: ["gameplay-bug"],
    };

    const result = validateFix(issue, diffPath);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// validateFix — diff file read error
// ---------------------------------------------------------------------------

describe("validateFix — error handling", () => {
  it("returns error when diff file does not exist", () => {
    const issue: IssueData = {
      number: 110,
      body: "Event 42",
      labels: ["content-error"],
    };

    const result = validateFix(issue, "/nonexistent/path/to/diff.patch");
    assert.equal(result.valid, false);
    assert.equal(result.reason, "diff-read-error");
  });
});
