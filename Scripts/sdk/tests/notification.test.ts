/**
 * Tests for BA-010.6: notification.ts email trigger logic.
 *
 * Tests shouldSendEmail() for all routing action types.
 * Tests sendActionNeededEmail() graceful handling of missing env vars.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  shouldSendEmail,
  sendActionNeededEmail,
  sendPRCreatedEmail,
  sendHandoffEmail,
  buildEmailHtml,
  buildPRCreatedEmailHtml,
  buildHandoffEmailHtml,
  prepareIssueBody,
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
      buildNumber: "207",
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
// Story 3.4: Email button parity and content preservation tests
// ---------------------------------------------------------------------------

describe("Story 3.4: action-needed email buttons", () => {
  let origAuth: string | undefined;

  beforeEach(() => {
    origAuth = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "test_token_1234";
  });

  afterEach(() => {
    if (origAuth !== undefined) {
      process.env.AUTH_TOKEN = origAuth;
    } else {
      delete process.env.AUTH_TOKEN;
    }
  });

  it("includes all 5 buttons with correct URLs", () => {
    const input = {
      issueNumber: 152,
      issueTitle: "App crashes on phone call",
      classification: "needs_human_review",
      confidence: 0.35,
      severity: "P2",
      reasoning: "Low confidence triage",
      description: "The app crashes when I receive a phone call during gameplay.",
    };
    const action: RoutingAction = {
      type: "label" as const,
      repo: "RaufGlasgow/Sorting-History",
      issue_number: 152,
      labels: ["needs-human-review", "sdk-routed"],
    };

    const html = buildEmailHtml(input, action);

    // All 5 buttons present
    assert.ok(html.includes(">Approve Fix</a>"), "Approve button missing");
    assert.ok(html.includes(">Reject</a>"), "Reject button missing");
    assert.ok(html.includes(">Rework</a>"), "Rework button missing");
    assert.ok(html.includes(">Comment</a>"), "Comment button missing");
    assert.ok(html.includes(">Fix Locally</a>"), "Fix Locally button missing");

    // Rework URL points to /api/pipeline/rework
    assert.ok(html.includes("/api/pipeline/rework?issue=152"), "Rework URL incorrect");

    // Fix Locally URL points to /api/pipeline/fix-locally
    assert.ok(html.includes("/api/pipeline/fix-locally?issue=152"), "Fix Locally URL incorrect");

    // All URLs use sortinghistory.com domain
    assert.ok(!html.includes("bug-webhook.emptycupmedia.workers.dev"), "Should not use emptycupmedia domain");
    const urlMatches = html.match(/https:\/\/sortinghistory\.com\/api\/pipeline\//g);
    assert.ok(urlMatches && urlMatches.length >= 5, `Expected at least 5 sortinghistory.com URLs, got ${urlMatches?.length}`);
  });
});

describe("Story 3.4: PR-created email buttons", () => {
  let origAuth: string | undefined;

  beforeEach(() => {
    origAuth = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "test_token_1234";
  });

  afterEach(() => {
    if (origAuth !== undefined) {
      process.env.AUTH_TOKEN = origAuth;
    } else {
      delete process.env.AUTH_TOKEN;
    }
  });

  it("includes Fix Locally button", () => {
    const html = buildPRCreatedEmailHtml({
      issueNumber: 152,
      issueTitle: "App crashes on phone call",
      prNumber: 155,
      prUrl: "https://github.com/RaufGlasgow/Sorting-History/pull/155",
      filesModified: "Views/GameView.swift",
      compilation: "success",
      confidence: "high",
      fixAttempts: 1,
      pipelineMode: "full",
    });

    // Review PR, Reject Fix, Fix Locally
    assert.ok(html.includes(">Review PR #155</a>"), "Review PR button missing");
    assert.ok(html.includes(">Reject Fix</a>"), "Reject Fix button missing");
    assert.ok(html.includes(">Fix Locally</a>"), "Fix Locally button missing");
    assert.ok(html.includes("/api/pipeline/fix-locally?issue=152"), "Fix Locally URL incorrect");
  });
});

describe("Story 3.4: handoff email buttons", () => {
  let origAuth: string | undefined;

  beforeEach(() => {
    origAuth = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "test_token_1234";
  });

  afterEach(() => {
    if (origAuth !== undefined) {
      process.env.AUTH_TOKEN = origAuth;
    } else {
      delete process.env.AUTH_TOKEN;
    }
  });

  it("includes Fix Locally button", () => {
    const html = buildHandoffEmailHtml({
      issueNumber: 152,
      issueTitle: "App crashes on phone call",
      totalAttempts: 3,
      attemptSummary: "All attempts failed",
      modelsUsed: ["haiku", "sonnet"],
    });

    // View Handoff, Provide Guidance, Fix Locally
    assert.ok(html.includes(">View Handoff</a>"), "View Handoff button missing");
    assert.ok(html.includes(">Provide Guidance</a>"), "Provide Guidance button missing");
    assert.ok(html.includes(">Fix Locally</a>"), "Fix Locally button missing");
    assert.ok(html.includes("/api/pipeline/fix-locally?issue=152"), "Fix Locally URL incorrect");
  });
});

describe("Story 3.4: screenshot and device info preservation", () => {
  let origAuth: string | undefined;

  beforeEach(() => {
    origAuth = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "test_token_1234";
  });

  afterEach(() => {
    if (origAuth !== undefined) {
      process.env.AUTH_TOKEN = origAuth;
    } else {
      delete process.env.AUTH_TOKEN;
    }
  });

  it("notification email preserves screenshots", () => {
    const issueBody = `## Bug Description
The app crashes.

![Screenshot](https://bug-webhook.emptycupmedia.workers.dev/screenshots/abc123.png)

## Device Info
- Model: iPhone 13 Pro Max
- OS Version: iOS 17.2
- App Version: 1.1.0-alpha.261`;

    const input = {
      issueNumber: 152,
      issueTitle: "App crashes",
      classification: "needs_human_review",
      confidence: 0.35,
      severity: "P2",
      reasoning: "Low confidence",
      description: issueBody,
    };
    const action: RoutingAction = {
      type: "label" as const,
      repo: "RaufGlasgow/Sorting-History",
      issue_number: 152,
      labels: ["needs-human-review"],
    };

    const html = buildEmailHtml(input, action);

    // Screenshots should be present as img tags, NOT stripped
    assert.ok(
      html.includes("bug-webhook.emptycupmedia.workers.dev/screenshots/abc123.png"),
      "Screenshot R2 URL was stripped — should be preserved",
    );
    assert.ok(html.includes("<img"), "Should contain img tags for screenshots");
  });

  it("notification email preserves device info", () => {
    const issueBody = `## Bug Description
The app crashes.

## Device Info
- Model: iPhone 13 Pro Max
- OS Version: iOS 17.2
- App Version: 1.1.0-alpha.261`;

    const input = {
      issueNumber: 152,
      issueTitle: "App crashes",
      classification: "needs_human_review",
      confidence: 0.35,
      severity: "P2",
      reasoning: "Low confidence",
      description: issueBody,
    };
    const action: RoutingAction = {
      type: "label" as const,
      repo: "RaufGlasgow/Sorting-History",
      issue_number: 152,
      labels: ["needs-human-review"],
    };

    const html = buildEmailHtml(input, action);

    // Device info should be present, NOT stripped
    assert.ok(html.includes("iPhone 13 Pro Max"), "Device model was stripped");
    assert.ok(html.includes("iOS 17.2"), "OS version was stripped");
  });

  it("long email body truncates prose but preserves screenshots and device info", () => {
    // Generate a body > 5000 chars with screenshots and device info
    const longProse = "A".repeat(6000);
    const issueBody = `## Bug Description
${longProse}

![Screenshot](https://bug-webhook.emptycupmedia.workers.dev/screenshots/long-test.png)

## Device Info
- Model: iPad Pro 12.9
- OS Version: iPadOS 17.3
- App Version: 1.1.0-alpha.265`;

    const input = {
      issueNumber: 153,
      issueTitle: "Long bug report",
      classification: "needs_human_review",
      confidence: 0.40,
      severity: "P3",
      reasoning: "Verbose report",
      description: issueBody,
    };
    const action: RoutingAction = {
      type: "label" as const,
      repo: "RaufGlasgow/Sorting-History",
      issue_number: 153,
      labels: ["needs-human-review"],
    };

    const html = buildEmailHtml(input, action);

    // Screenshots R2 URL still present (NEVER truncated)
    assert.ok(
      html.includes("bug-webhook.emptycupmedia.workers.dev/screenshots/long-test.png"),
      "Screenshot URL was truncated — screenshots must NEVER be truncated",
    );

    // Device info still present (NEVER truncated)
    assert.ok(html.includes("iPad Pro 12.9"), "Device model was truncated");
    assert.ok(html.includes("iPadOS 17.3"), "OS version was truncated");

    // "Full details via Fix Locally" link shown
    assert.ok(
      html.includes("Full details available via Fix Locally"),
      "Truncation notice with Fix Locally link missing",
    );
  });
});
