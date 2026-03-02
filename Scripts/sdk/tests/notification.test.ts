/**
 * Tests for BA-010.6: notification.ts email trigger logic.
 *
 * Tests shouldSendEmail() for all routing action types.
 * Tests sendActionNeededEmail() graceful handling of missing env vars.
 * Tests BA-008.1 AC2: diff summary parsing and "What Changed" HTML builder.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  shouldSendEmail,
  sendActionNeededEmail,
  sendPRCreatedEmail,
  sendHandoffEmail,
  parseDiffStatLine,
  parseDiffStatSummary,
  buildWhatChangedHtml,
} from "../lib/notification.js";
import type { RoutingAction } from "../lib/routing.js";

// ---------------------------------------------------------------------------
// shouldSendEmail tests
// ---------------------------------------------------------------------------

describe("shouldSendEmail", () => {
  it("returns true for ui_bug label action", () => {
    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["ui-bug", "severity/P2", "sdk-routed"],
    };
    assert.equal(shouldSendEmail(action), true);
  });

  it("returns true for gameplay_bug label action", () => {
    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["gameplay-bug", "severity/P3", "sdk-routed"],
    };
    assert.equal(shouldSendEmail(action), true);
  });

  it("returns true for needs-human-review label action", () => {
    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["needs-human-review", "sdk-routed"],
    };
    assert.equal(shouldSendEmail(action), true);
  });

  it("returns true for low-confidence label action", () => {
    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["needs-human-review", "low-confidence", "sdk-routed"],
    };
    assert.equal(shouldSendEmail(action), true);
  });

  it("returns false for translation_error dispatch action (BA-008.2)", () => {
    const action: RoutingAction = {
      type: "dispatch",
      event_type: "sdk-translation-fix",
      repo: "test/public-repo",
      payload: { workflow_type: "translation_verification", language: "German", issue_number: 1 },
    };
    assert.equal(shouldSendEmail(action), false);
  });

  it("returns true for performance_issue handoff_to_dev action", () => {
    const action: RoutingAction = {
      type: "handoff_to_dev",
      repo: "test/repo",
      issue_number: 1,
      labels: ["performance-issue", "needs-dev-handoff", "sdk-routed"],
      triage_data: {
        classification: "performance_issue",
        confidence: 0.85,
        severity: "P2",
        reasoning: "test",
        extracted_context: {},
        issue_title: "Test",
        issue_body: "Test body",
      },
    };
    assert.equal(shouldSendEmail(action), true);
  });

  it("returns true for crash_bug handoff_to_dev action", () => {
    const action: RoutingAction = {
      type: "handoff_to_dev",
      repo: "test/repo",
      issue_number: 1,
      labels: ["crash-bug", "needs-dev-handoff", "sdk-routed"],
      triage_data: {
        classification: "crash_bug",
        confidence: 0.90,
        severity: "P1",
        reasoning: "test crash",
        extracted_context: {},
        issue_title: "Crash test",
        issue_body: "Crash body",
      },
    };
    assert.equal(shouldSendEmail(action), true);
  });

  it("returns false for content_error dispatch action", () => {
    const action: RoutingAction = {
      type: "dispatch",
      event_type: "sdk-content-verify",
      repo: "test/public-repo",
      payload: { workflow_type: "content_verification", category: "US History", issue_number: 1 },
    };
    assert.equal(shouldSendEmail(action), false);
  });

  it("returns false for feature_request label action", () => {
    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["feature-request", "sdk-routed"],
    };
    assert.equal(shouldSendEmail(action), false);
  });

  it("returns false for skip action", () => {
    const action: RoutingAction = {
      type: "skip",
      reason: "already routed",
      issue_number: 1,
    };
    assert.equal(shouldSendEmail(action), false);
  });
});

// ---------------------------------------------------------------------------
// sendActionNeededEmail tests (env var handling)
// ---------------------------------------------------------------------------

describe("sendActionNeededEmail", () => {
  let origResend: string | undefined;
  let origOwner: string | undefined;

  beforeEach(() => {
    origResend = process.env.RESEND_API_KEY;
    origOwner = process.env.OWNER_EMAIL;
  });

  afterEach(() => {
    if (origResend !== undefined) {
      process.env.RESEND_API_KEY = origResend;
    } else {
      delete process.env.RESEND_API_KEY;
    }
    if (origOwner !== undefined) {
      process.env.OWNER_EMAIL = origOwner;
    } else {
      delete process.env.OWNER_EMAIL;
    }
  });

  it("does not throw when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.OWNER_EMAIL = "test@example.com";

    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["ui-bug", "sdk-routed"],
    };

    // Should return without throwing
    await sendActionNeededEmail(
      {
        issueNumber: 1,
        issueTitle: "Test bug",
        classification: "ui_bug",
        confidence: 0.92,
        severity: "P2",
        reasoning: "Test reasoning",
      },
      action,
    );
  });

  it("does not throw when OWNER_EMAIL is missing", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.OWNER_EMAIL;

    const action: RoutingAction = {
      type: "label",
      repo: "test/repo",
      issue_number: 1,
      labels: ["ui-bug", "sdk-routed"],
    };

    // Should return without throwing
    await sendActionNeededEmail(
      {
        issueNumber: 1,
        issueTitle: "Test bug",
        classification: "ui_bug",
        confidence: 0.92,
        severity: "P2",
        reasoning: "Test reasoning",
      },
      action,
    );
  });
});

// ---------------------------------------------------------------------------
// sendPRCreatedEmail tests (env var handling)
// ---------------------------------------------------------------------------

describe("sendPRCreatedEmail", () => {
  let origResend: string | undefined;
  let origOwner: string | undefined;

  beforeEach(() => {
    origResend = process.env.RESEND_API_KEY;
    origOwner = process.env.OWNER_EMAIL;
  });

  afterEach(() => {
    if (origResend !== undefined) {
      process.env.RESEND_API_KEY = origResend;
    } else {
      delete process.env.RESEND_API_KEY;
    }
    if (origOwner !== undefined) {
      process.env.OWNER_EMAIL = origOwner;
    } else {
      delete process.env.OWNER_EMAIL;
    }
  });

  it("does not throw when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.OWNER_EMAIL = "test@example.com";

    await sendPRCreatedEmail({
      issueNumber: 116,
      issueTitle: "Help bubbles appearing simultaneously",
      prNumber: 117,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/117",
      filesModified: "Views/GameSetupView.swift",
      compilation: "success",
      confidence: "high",
      fixAttempts: 1,
      pipelineMode: "full",
    });
  });

  it("does not throw when OWNER_EMAIL is missing", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.OWNER_EMAIL;

    await sendPRCreatedEmail({
      issueNumber: 116,
      issueTitle: "Help bubbles appearing simultaneously",
      prNumber: 117,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/117",
      filesModified: "Views/GameSetupView.swift",
      compilation: "success",
      confidence: "high",
      fixAttempts: 2,
      alphaVersion: "207",
      pipelineMode: "full",
    });
  });

  it("does not throw for qa-only mode", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OWNER_EMAIL;

    await sendPRCreatedEmail({
      issueNumber: 116,
      issueTitle: "Help bubbles appearing simultaneously",
      prNumber: 117,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/117",
      filesModified: "Views/GameSetupView.swift",
      compilation: "success",
      confidence: "high",
      fixAttempts: 0,
      pipelineMode: "qa-only",
    });
  });

  it("does not throw with issueBody and qaSummary", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OWNER_EMAIL;

    await sendPRCreatedEmail({
      issueNumber: 116,
      issueTitle: "Help bubbles appearing simultaneously",
      prNumber: 117,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/117",
      filesModified: "Views/GameSetupView.swift",
      compilation: "success",
      confidence: "high",
      fixAttempts: 1,
      pipelineMode: "full",
      issueBody: "## Bug Description\n\nHelp bubbles keep appearing.\n\n**Steps to reproduce:**\n1. Open app\n2. Start game\n\n**Expected behavior:**\nOnly one bubble at a time",
      qaSummary: "## QA Review\n\nFix correctly addresses the issue. Compilation passes. No regressions found.",
    });
  });
});

// ---------------------------------------------------------------------------
// sendHandoffEmail tests (env var handling + optional issueBody)
// ---------------------------------------------------------------------------

describe("sendHandoffEmail", () => {
  let origResend: string | undefined;
  let origOwner: string | undefined;

  beforeEach(() => {
    origResend = process.env.RESEND_API_KEY;
    origOwner = process.env.OWNER_EMAIL;
  });

  afterEach(() => {
    if (origResend !== undefined) {
      process.env.RESEND_API_KEY = origResend;
    } else {
      delete process.env.RESEND_API_KEY;
    }
    if (origOwner !== undefined) {
      process.env.OWNER_EMAIL = origOwner;
    } else {
      delete process.env.OWNER_EMAIL;
    }
  });

  it("does not throw when env vars are missing", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OWNER_EMAIL;

    await sendHandoffEmail({
      issueNumber: 120,
      issueTitle: "Some complex bug",
      totalAttempts: 3,
      attemptSummary: "Attempt 1: failed\nAttempt 2: failed\nAttempt 3: failed",
      modelsUsed: ["haiku", "sonnet"],
    });
  });

  it("does not throw with issueBody", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OWNER_EMAIL;

    await sendHandoffEmail({
      issueNumber: 120,
      issueTitle: "Some complex bug",
      totalAttempts: 3,
      attemptSummary: "Attempt 1: failed\nAttempt 2: failed\nAttempt 3: failed",
      modelsUsed: ["haiku", "sonnet"],
      issueBody: "## Bug Description\nThe app crashes when loading.\n\n**Steps to reproduce:**\n1. Tap play\n2. Wait\n\n**Expected behavior:**\nGame loads",
    });
  });
});

// ---------------------------------------------------------------------------
// BA-008.1 AC2: parseDiffStatLine tests
// ---------------------------------------------------------------------------

describe("parseDiffStatLine", () => {
  it("parses a line with insertions and deletions", () => {
    const result = parseDiffStatLine(" Views/GameSetupView.swift | 12 +++---");
    assert.ok(result);
    assert.equal(result.file, "Views/GameSetupView.swift");
    assert.equal(result.insertions, 3);
    assert.equal(result.deletions, 3);
  });

  it("parses a line with only insertions", () => {
    const result = parseDiffStatLine(" Models/NewFile.swift | 45 +++++++++++++++");
    assert.ok(result);
    assert.equal(result.file, "Models/NewFile.swift");
    assert.equal(result.insertions, 15);
    assert.equal(result.deletions, 0);
  });

  it("parses a line with only deletions", () => {
    const result = parseDiffStatLine(" Views/OldView.swift | 8 --------");
    assert.ok(result);
    assert.equal(result.file, "Views/OldView.swift");
    assert.equal(result.insertions, 0);
    assert.equal(result.deletions, 8);
  });

  it("handles file paths with spaces", () => {
    const result = parseDiffStatLine(" Data/some file.json | 3 +++");
    assert.ok(result);
    assert.equal(result.file, "Data/some file.json");
    assert.equal(result.insertions, 3);
    assert.equal(result.deletions, 0);
  });

  it("returns null for the summary line", () => {
    const result = parseDiffStatLine(" 3 files changed, 25 insertions(+), 8 deletions(-)");
    assert.equal(result, null);
  });

  it("returns null for empty lines", () => {
    assert.equal(parseDiffStatLine(""), null);
    assert.equal(parseDiffStatLine("   "), null);
  });

  it("parses a line with rename arrow", () => {
    const result = parseDiffStatLine(" Views/{Old => New}View.swift | 5 ++---");
    assert.ok(result);
    assert.equal(result.file, "Views/{Old => New}View.swift");
    assert.equal(result.insertions, 2);
    assert.equal(result.deletions, 3);
  });
});

// ---------------------------------------------------------------------------
// BA-008.1 AC2: parseDiffStatSummary tests
// ---------------------------------------------------------------------------

describe("parseDiffStatSummary", () => {
  it("parses a full summary with insertions and deletions", () => {
    const lines = [
      " Views/GameSetupView.swift | 12 +++---",
      " Models/Game.swift         |  4 ++--",
      " 2 files changed, 8 insertions(+), 8 deletions(-)",
    ];
    const result = parseDiffStatSummary(lines);
    assert.equal(result, "2 files changed, +8 -8");
  });

  it("parses summary with only insertions", () => {
    const lines = [
      " NewFile.swift | 50 ++++++++",
      " 1 file changed, 50 insertions(+)",
    ];
    const result = parseDiffStatSummary(lines);
    assert.equal(result, "1 file changed, +50 -0");
  });

  it("parses summary with only deletions", () => {
    const lines = [
      " OldFile.swift | 10 ----------",
      " 1 file changed, 10 deletions(-)",
    ];
    const result = parseDiffStatSummary(lines);
    assert.equal(result, "1 file changed, +0 -10");
  });

  it("returns empty string when no summary line found", () => {
    const result = parseDiffStatSummary(["just some random text", "no summary here"]);
    assert.equal(result, "");
  });

  it("pluralizes correctly for multiple files", () => {
    const lines = [" 5 files changed, 100 insertions(+), 20 deletions(-)"];
    const result = parseDiffStatSummary(lines);
    assert.equal(result, "5 files changed, +100 -20");
  });
});

// ---------------------------------------------------------------------------
// BA-008.1 AC2: buildWhatChangedHtml tests
// ---------------------------------------------------------------------------

describe("buildWhatChangedHtml", () => {
  it("falls back to plain file list when diffSummary is undefined", () => {
    const html = buildWhatChangedHtml(undefined, "Views/GameSetupView.swift");
    assert.ok(html.includes("Files Modified"));
    assert.ok(html.includes("Views/GameSetupView.swift"));
    assert.ok(!html.includes("What Changed"));
  });

  it("falls back to plain file list when diffSummary is empty string", () => {
    const html = buildWhatChangedHtml("", "2 files");
    assert.ok(html.includes("Files Modified"));
    assert.ok(!html.includes("What Changed"));
  });

  it("renders What Changed section with diff stats", () => {
    const diffSummary = [
      " Views/GameSetupView.swift | 12 +++---",
      " Models/Game.swift         |  4 ++--",
      " 2 files changed, 8 insertions(+), 8 deletions(-)",
    ].join("\n");

    const html = buildWhatChangedHtml(diffSummary, "2");
    assert.ok(html.includes("What Changed"));
    assert.ok(html.includes("Views/GameSetupView.swift"));
    assert.ok(html.includes("Models/Game.swift"));
    assert.ok(html.includes("2 files changed, +8 -8"));
    // Check for colored insertion/deletion markers
    assert.ok(html.includes("+"));
    assert.ok(html.includes("-"));
  });

  it("escapes HTML in file names", () => {
    const diffSummary = ' File<script>.swift | 3 +++\n 1 file changed, 3 insertions(+)';
    const html = buildWhatChangedHtml(diffSummary, "1");
    assert.ok(html.includes("File&lt;script&gt;.swift"));
    assert.ok(!html.includes("<script>"));
  });

  it("truncates beyond 30 files", () => {
    const lines: string[] = [];
    for (let i = 0; i < 35; i++) {
      lines.push(` File${i}.swift | 2 +-`);
    }
    lines.push(" 35 files changed, 35 insertions(+), 35 deletions(-)");
    const diffSummary = lines.join("\n");

    const html = buildWhatChangedHtml(diffSummary, "35");
    assert.ok(html.includes("File0.swift"));
    assert.ok(html.includes("File29.swift"));
    assert.ok(!html.includes("File30.swift"));
    assert.ok(html.includes("...and 5 more files"));
  });
});

// ---------------------------------------------------------------------------
// BA-008.1 AC2: sendPRCreatedEmail with diffSummary
// ---------------------------------------------------------------------------

describe("sendPRCreatedEmail with diffSummary", () => {
  let origResend: string | undefined;
  let origOwner: string | undefined;

  beforeEach(() => {
    origResend = process.env.RESEND_API_KEY;
    origOwner = process.env.OWNER_EMAIL;
  });

  afterEach(() => {
    if (origResend !== undefined) {
      process.env.RESEND_API_KEY = origResend;
    } else {
      delete process.env.RESEND_API_KEY;
    }
    if (origOwner !== undefined) {
      process.env.OWNER_EMAIL = origOwner;
    } else {
      delete process.env.OWNER_EMAIL;
    }
  });

  it("does not throw with diffSummary provided", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OWNER_EMAIL;

    await sendPRCreatedEmail({
      issueNumber: 121,
      issueTitle: "Daily Challenge in English when Portuguese",
      prNumber: 140,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/140",
      filesModified: "2",
      compilation: "success",
      confidence: "high",
      fixAttempts: 1,
      pipelineMode: "full",
      diffSummary: " Views/DailyChallengeView.swift | 12 +++---\n Models/Locale.swift | 4 ++--\n 2 files changed, 8 insertions(+), 8 deletions(-)",
    });
  });

  it("does not throw when diffSummary is undefined", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.OWNER_EMAIL;

    await sendPRCreatedEmail({
      issueNumber: 121,
      issueTitle: "Daily Challenge in English when Portuguese",
      prNumber: 140,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/140",
      filesModified: "Views/DailyChallengeView.swift",
      compilation: "success",
      confidence: "high",
      fixAttempts: 1,
      pipelineMode: "full",
    });
  });
});
