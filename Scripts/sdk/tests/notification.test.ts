/**
 * Tests for BA-010.6: notification.ts email trigger logic.
 *
 * Tests shouldSendEmail() for all routing action types.
 * Tests sendActionNeededEmail() graceful handling of missing env vars.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { shouldSendEmail, sendActionNeededEmail, sendPRCreatedEmail, sendHandoffEmail } from "../lib/notification.js";
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
