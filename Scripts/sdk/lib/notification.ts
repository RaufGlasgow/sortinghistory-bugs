/**
 * BA-010.6: Real-time "Action Needed" email notifications.
 *
 * Sends an immediate email to the pipeline owner when a bug is classified
 * as needing human action. Called from triage.ts AFTER executeRoute().
 *
 * Uses the Resend API via fetch() — no external dependencies.
 * All errors are caught and logged — failure never breaks the triage pipeline.
 */

import type { RoutingAction } from "./routing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionNeededEmailInput {
  issueNumber: number;
  issueTitle: string;
  classification: string;
  confidence: number;
  severity: string;
  reasoning: string;
  /** Reporter's original bug description (from issue body) */
  description?: string;
  /** Story 3.5: Triage handoff signals for needs_human_review notifications */
  triageHandoff?: {
    best_guess_classification: string;
    signals_found: string[];
    signals_missing: string[];
    suggested_steps: string[];
    relevant_files: string[];
  };
}

// ---------------------------------------------------------------------------
// Email trigger logic
// ---------------------------------------------------------------------------

/** Labels/action types that trigger an email notification */
const EMAIL_TRIGGER_LABELS = new Set([
  "needs-human-review",
  "ui-bug",
  "gameplay-bug",
  "low-confidence",
  "unknown-classification",
]);

/**
 * Determine whether a routing action should trigger an email.
 *
 * Send email for:
 *   - "label" actions with trigger labels (ui_bug, gameplay_bug, needs-human-review, etc.)
 *   - "handoff_to_dev" actions (performance_issue, crash_bug)
 *   - "label_and_state" actions (translation_error)
 *
 * Do NOT send for:
 *   - "dispatch" (content_error — content verify pipeline handles it)
 *   - "skip" (already routed — idempotency guard)
 *   - "label" with only feature_request (backlog, not urgent)
 */
export function shouldSendEmail(action: RoutingAction): boolean {
  switch (action.type) {
    case "handoff_to_dev":
      return true;

    case "label_and_state":
      return true;

    case "label": {
      // Check if any label is a trigger label (excluding feature-request-only)
      const hasFeatureRequest = action.labels.includes("feature-request");
      const hasTriggerLabel = action.labels.some((l) => EMAIL_TRIGGER_LABELS.has(l));

      // feature_request label-only actions: no email
      if (hasFeatureRequest && !hasTriggerLabel) {
        return false;
      }
      return hasTriggerLabel;
    }

    case "dispatch":
      return false;

    case "skip":
      return false;

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Email builder
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Extract screenshots section from issue body — returns array of image URLs found.
 * Looks for markdown image syntax: ![alt](url)
 */
export function extractScreenshots(raw: string): string[] {
  const urls: string[] = [];
  const regex = /!\[.*?\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/**
 * Extract the Device Info section from issue body.
 * Returns the section content or empty string if not found.
 */
export function extractDeviceInfo(raw: string): string {
  const match = raw.match(/## Device Info\s*([\s\S]*?)(?=##|$)/);
  if (!match || !match[1]) return "";
  return match[1].trim();
}

/**
 * Prepare issue body for email display.
 * Story 3.4 AC5: Preserve screenshots (as linked images) and device info.
 * Only truncate prose text if body exceeds maxLength, but NEVER truncate
 * screenshots or device info.
 */
export function prepareIssueBody(raw: string, maxLength: number, issueNumber?: number): {
  bodyText: string;
  screenshotUrls: string[];
  deviceInfo: string;
  wasTruncated: boolean;
} {
  const screenshotUrls = extractScreenshots(raw);
  const deviceInfo = extractDeviceInfo(raw);

  // Build prose text: strip base64 images (too large), clean up formatting,
  // but preserve URL images inline and keep device info
  let text = raw
    .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, "[screenshot attached]") // strip base64 images only
    .replace(/_Submitted via Sorting History app_/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let wasTruncated = false;
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    wasTruncated = true;
  }

  return { bodyText: text, screenshotUrls, deviceInfo, wasTruncated };
}

/**
 * Build HTML for screenshots section in email.
 */
function buildScreenshotsHtml(screenshotUrls: string[]): string {
  if (screenshotUrls.length === 0) return "";
  const imagesHtml = screenshotUrls
    .map((url) => `<img src="${escapeHtml(url)}" alt="Screenshot" style="max-width:100%;border-radius:8px;margin:8px 0;" />`)
    .join("\n      ");
  return `
    <!-- Screenshots -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f8f9fa;border-left:4px solid #6c757d;border-radius:4px;">
      <p style="margin:0 0 8px 0;font-size:12px;color:#6c757d;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Screenshots</p>
      ${imagesHtml}
    </div>`;
}

/**
 * Build HTML for device info section in email.
 */
function buildDeviceInfoHtml(deviceInfo: string): string {
  if (!deviceInfo) return "";
  const safeDeviceInfo = escapeHtml(deviceInfo);
  return `
    <!-- Device Info -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0f4f8;border-left:4px solid #4a5568;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#4a5568;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Device Info</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeDeviceInfo}</p>
    </div>`;
}

/**
 * Extract a labeled section from issue body (e.g. "**Steps to reproduce:**" ... next section).
 * Returns the section content or empty string if not found.
 */
function extractSection(body: string, label: string): string {
  const regex = new RegExp(`\\*\\*${label}:\\*\\*\\s*([\\s\\S]*?)(?=\\*\\*[A-Z][^*]*:\\*\\*|##|$)`, "i");
  const match = body.match(regex);
  if (!match || !match[1]) return "";
  return match[1].trim();
}

/**
 * Story 3.5: Build HTML for triage handoff signals section in email.
 * Shows contextual signals found/missing and suggested next steps.
 */
function buildTriageHandoffHtml(handoff?: ActionNeededEmailInput["triageHandoff"]): string {
  if (!handoff) return "";
  if (handoff.signals_found.length === 0 && handoff.signals_missing.length === 0) return "";

  const sections: string[] = [];

  if (handoff.best_guess_classification) {
    sections.push(`<p style="margin:0 0 8px 0;font-size:13px;color:#333333;"><strong>Best guess:</strong> <code style="background:#fef9f3;padding:2px 6px;border-radius:3px;">${escapeHtml(handoff.best_guess_classification)}</code></p>`);
  }

  if (handoff.signals_found.length > 0) {
    const signalItems = handoff.signals_found
      .map((s) => `<li style="margin:2px 0;font-size:13px;color:#166534;">${escapeHtml(s)}</li>`)
      .join("");
    sections.push(`<p style="margin:0 0 4px 0;font-size:12px;color:#166534;font-weight:600;">Signals Found</p><ul style="margin:0 0 8px 0;padding-left:20px;">${signalItems}</ul>`);
  }

  if (handoff.signals_missing.length > 0) {
    const missingItems = handoff.signals_missing
      .map((s) => `<li style="margin:2px 0;font-size:13px;color:#9a3412;">${escapeHtml(s)}</li>`)
      .join("");
    sections.push(`<p style="margin:0 0 4px 0;font-size:12px;color:#9a3412;font-weight:600;">Signals Missing</p><ul style="margin:0 0 8px 0;padding-left:20px;">${missingItems}</ul>`);
  }

  if (handoff.suggested_steps.length > 0) {
    const stepItems = handoff.suggested_steps
      .map((s) => `<li style="margin:2px 0;font-size:13px;color:#1e40af;">${escapeHtml(s)}</li>`)
      .join("");
    sections.push(`<p style="margin:0 0 4px 0;font-size:12px;color:#1e40af;font-weight:600;">Suggested Steps</p><ul style="margin:0 0 8px 0;padding-left:20px;">${stepItems}</ul>`);
  }

  if (handoff.relevant_files.length > 0) {
    const fileItems = handoff.relevant_files
      .map((f) => `<li style="margin:2px 0;font-size:13px;color:#333333;font-family:monospace;">${escapeHtml(f)}</li>`)
      .join("");
    sections.push(`<p style="margin:0 0 4px 0;font-size:12px;color:#4a5568;font-weight:600;">Relevant Files</p><ul style="margin:0 0 0 0;padding-left:20px;">${fileItems}</ul>`);
  }

  return `
    <!-- Story 3.5: Triage handoff signals -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#fefce8;border-left:4px solid #ca8a04;border-radius:4px;">
      <p style="margin:0 0 8px 0;font-size:12px;color:#ca8a04;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Triage Analysis</p>
      ${sections.join("\n      ")}
    </div>`;
}

function getActionMessage(action: RoutingAction): string {
  switch (action.type) {
    case "handoff_to_dev":
      return "Developer handoff created — investigate and fix.";
    case "label_and_state":
      return "Translation issue flagged — verify translation.";
    case "label":
      if (action.labels.includes("low-confidence") || action.labels.includes("unknown-classification")) {
        return "Manual triage needed — low confidence classification.";
      }
      return "Review and /approve for fix attempt.";
    default:
      return "Review needed.";
  }
}

export function buildEmailHtml(input: ActionNeededEmailInput, action: RoutingAction): string {
  const safeTitle = escapeHtml(input.issueTitle);
  const safeClassification = escapeHtml(input.classification);
  const safeSeverity = escapeHtml(input.severity);
  const confidencePercent = Math.round(input.confidence * 100);
  const safeReasoning = escapeHtml(input.reasoning);
  const actionMessage = escapeHtml(getActionMessage(action));
  const issueUrl = `https://github.com/RaufGlasgow/Sorting-History/issues/${input.issueNumber}`;
  const authToken = process.env.AUTH_TOKEN;

  // Build bug description section — preserve screenshots and device info (Story 3.4 AC5)
  let descriptionHtml = "";
  let screenshotsHtml = "";
  let deviceInfoHtml = "";
  if (input.description) {
    const prepared = prepareIssueBody(input.description, 5000, input.issueNumber);
    const safeDescription = escapeHtml(prepared.bodyText);
    let truncationNote = "";
    if (prepared.wasTruncated) {
      const fixLocallyLink = authToken
        ? `https://sortinghistory.com/api/pipeline/fix-locally?issue=${input.issueNumber}&token=${encodeURIComponent(authToken)}`
        : issueUrl;
      truncationNote = `<p style="margin:8px 0 0;font-size:12px;color:#6b7280;"><a href="${fixLocallyLink}" style="color:#2563eb;">Full details available via Fix Locally</a></p>`;
    }
    descriptionHtml = `
    <!-- Reporter description -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0f7ff;border-left:4px solid #2563eb;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What The Reporter Said</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeDescription}</p>
      ${truncationNote}
    </div>`;

    // Extract repro steps and expected behavior for decision-making
    const reproSteps = extractSection(input.description, "Steps to reproduce");
    const expectedBehavior = extractSection(input.description, "Expected behavior");

    if (reproSteps) {
      const safeRepro = escapeHtml(reproSteps.slice(0, 500));
      descriptionHtml += `
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#fefce8;border-left:4px solid #ca8a04;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#ca8a04;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Steps to Reproduce</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeRepro}</p>
    </div>`;
    }

    if (expectedBehavior) {
      const safeExpected = escapeHtml(expectedBehavior.slice(0, 500));
      descriptionHtml += `
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#16a34a;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Expected Behavior</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeExpected}</p>
    </div>`;
    }

    // Screenshots and device info — NEVER truncated (Story 3.4 AC5)
    screenshotsHtml = buildScreenshotsHtml(prepared.screenshotUrls);
    deviceInfoHtml = buildDeviceInfoHtml(prepared.deviceInfo);
  }

  // Generate action button URLs if AUTH_TOKEN is available
  let actionButtonsHtml: string;
  let githubLinkHtml: string;
  if (authToken) {
    const encodedToken = encodeURIComponent(authToken);
    const approveUrl = `https://sortinghistory.com/api/pipeline/approve?issue=${input.issueNumber}&token=${encodedToken}`;
    const rejectUrl = `https://sortinghistory.com/api/pipeline/reject?issue=${input.issueNumber}&token=${encodedToken}`;
    const reworkUrl = `https://sortinghistory.com/api/pipeline/rework?issue=${input.issueNumber}&token=${encodedToken}`;
    const commentUrl = `https://sortinghistory.com/api/pipeline/comment?issue=${input.issueNumber}&token=${encodedToken}`;
    const fixLocallyUrl = `https://sortinghistory.com/api/pipeline/fix-locally?issue=${input.issueNumber}&token=${encodedToken}`;
    actionButtonsHtml = `<a href="${approveUrl}" style="display:inline-block;padding:14px 24px;background:#22863a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Approve Fix</a>
      <a href="${rejectUrl}" style="display:inline-block;padding:14px 24px;background:#cb2431;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Reject</a>
      <a href="${reworkUrl}" style="display:inline-block;padding:14px 24px;background:#d97706;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Rework</a>
      <a href="${commentUrl}" style="display:inline-block;padding:14px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Comment</a>
      <a href="${fixLocallyUrl}" style="display:inline-block;padding:14px 24px;background:#6b7280;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Fix Locally</a>`;
    githubLinkHtml = `<p style="text-align:center;margin-top:12px;"><a href="${issueUrl}" style="color:#8B6914;font-size:13px;text-decoration:none;">View on GitHub &rarr;</a></p>`;
  } else {
    actionButtonsHtml = `<a href="${issueUrl}" style="display:inline-block;padding:14px 32px;background:#8B6914;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">View Issue on GitHub</a>`;
    githubLinkHtml = '';
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0;background:#fffdf8;">
  <!-- Header with app icon -->
  <div style="background:#8B6914;padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <img src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History" style="width:80px;height:80px;border-radius:18px;margin-bottom:12px;" />
    <div style="display:inline-block;padding:4px 14px;background:#b91c1c;border-radius:20px;margin-bottom:8px;">
      <span style="color:#ffffff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Urgent</span>
    </div>
    <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">Bug #${input.issueNumber} Needs Your Attention</h1>
  </div>

  <!-- Main content -->
  <div style="padding:28px 24px;background:#ffffff;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <!-- Bug title -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#faf8f4;border-left:4px solid #DAA520;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#8B6914;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Bug Report</p>
      <p style="margin:0;font-size:15px;color:#333333;line-height:1.5;overflow-wrap:break-word;">${safeTitle}</p>
    </div>

    ${descriptionHtml}

    ${screenshotsHtml}

    ${deviceInfoHtml}

    <!-- Classification table -->
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">
      <tr><td style="padding:8px 12px;font-weight:600;width:120px;background:#faf8f4;color:#8B6914;font-size:13px;">Classification</td><td style="padding:8px 12px;background:#faf8f4;font-size:14px;color:#333333;"><code style="background:#fef9f3;padding:2px 6px;border-radius:3px;">${safeClassification}</code> @ ${confidencePercent}% confidence</td></tr>
      <tr><td style="padding:8px 12px;font-weight:600;color:#8B6914;font-size:13px;">Severity</td><td style="padding:8px 12px;font-size:14px;color:#333333;">${safeSeverity}</td></tr>
    </table>

    <!-- AI Reasoning -->
    <p style="margin:0 0 6px 0;font-weight:600;font-size:13px;color:#8B6914;text-transform:uppercase;letter-spacing:0.5px;">AI Reasoning</p>
    <p style="margin:0 0 24px 0;font-size:14px;color:#444444;line-height:1.6;">${safeReasoning}</p>

    ${buildTriageHandoffHtml(input.triageHandoff)}

    <!-- Action callout -->
    <div style="padding:14px 16px;background:#fef2f2;border:2px solid #fca5a5;border-radius:8px;margin-bottom:24px;">
      <p style="margin:0;font-weight:700;color:#991b1b;font-size:14px;">${actionMessage}</p>
    </div>

    <!-- Re-engagement guidance -->
    <div style="padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:24px;">
      <p style="margin:0 0 6px 0;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">How to respond</p>
      <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;">Comment <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:12px;">/approve</code> on the GitHub issue to trigger an automated fix, or add your assessment and then <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:12px;">/approve</code> to retry with your guidance.</p>
    </div>

    <!-- Action buttons -->
    <div style="text-align:center;">
      ${actionButtonsHtml}
    </div>
    ${githubLinkHtml}
  </div>

  <!-- Footer with social links -->
  <div style="padding:20px 24px;background:#faf8f4;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <p style="margin:0 0 4px 0;font-size:14px;color:#8B6914;font-weight:600;text-align:center;">Sorting History</p>
    <p style="margin:0 0 12px 0;font-size:13px;color:#777777;text-align:center;">Sort history's greatest moments into the correct order</p>
    <p style="margin:0;font-size:13px;color:#888888;text-align:center;">
      <a href="https://sortinghistory.com" style="color:#8B6914;text-decoration:none;">Website</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://x.com/SortingHistory" style="color:#8B6914;text-decoration:none;">X/Twitter</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://instagram.com/sortinghistory" style="color:#8B6914;text-decoration:none;">Instagram</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://youtube.com/@sortinghistory" style="color:#8B6914;text-decoration:none;">YouTube</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://bsky.app/profile/sortinghistory.bsky.social" style="color:#8B6914;text-decoration:none;">Bluesky</a>
    </p>
  </div>

  <!-- Bottom bar -->
  <div style="padding:16px 24px;background:#f5f0e8;border:1px solid #e5e1d8;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
    <p style="margin:0 0 4px 0;font-size:12px;color:#8B6914;font-weight:600;">Sorting History &mdash; Learn history by playing it</p>
    <p style="margin:0 0 4px 0;font-size:11px;"><a href="https://sortinghistory.com" style="color:#999999;text-decoration:none;">sortinghistory.com</a></p>
    <p style="margin:0;font-size:10px;color:#aaaaaa;">SortingHistory Pipeline &bull; Urgent real-time alert</p>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Billing alert email
// ---------------------------------------------------------------------------

function buildBillingAlertHtml(errorMessage: string, issueNumber?: number): string {
  const issueContext = issueNumber
    ? `<p style="margin:0 0 16px 0;font-size:14px;color:#444444;line-height:1.6;">This happened while triaging <strong>issue #${issueNumber}</strong>. The issue is still open and will need to be re-triaged after credits are restored.</p>`
    : "";

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0;background:#fffdf8;">
  <!-- Header -->
  <div style="background:#b91c1c;padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <img src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History" style="width:80px;height:80px;border-radius:18px;margin-bottom:12px;" />
    <div style="display:inline-block;padding:4px 14px;background:#7f1d1d;border-radius:20px;margin-bottom:8px;">
      <span style="color:#ffffff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Pipeline Stopped</span>
    </div>
    <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">API Credits Depleted</h1>
  </div>

  <!-- Main content -->
  <div style="padding:28px 24px;background:#ffffff;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#fef2f2;border-left:4px solid #b91c1c;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#b91c1c;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Error</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;font-family:monospace;">${escapeHtml(errorMessage)}</p>
    </div>

    ${issueContext}

    <p style="margin:0 0 20px 0;font-size:14px;color:#444444;line-height:1.6;">The bug pipeline cannot classify, fix, or verify anything until credits are topped up. All incoming bugs will fail at triage.</p>

    <!-- Action buttons -->
    <div style="text-align:center;margin-bottom:16px;">
      <a href="https://console.anthropic.com/settings/billing" style="display:inline-block;padding:14px 28px;background:#8B6914;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Top Up API Credits</a>
      ${issueNumber ? `<a href="https://github.com/RaufGlasgow/sortinghistory-bugs/actions/workflows/bug-analysis.yml" style="display:inline-block;padding:14px 28px;background:#22863a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Retry Triage #${issueNumber}</a>` : ""}
    </div>
    <p style="text-align:center;margin:0 0 4px 0;font-size:13px;color:#888888;">console.anthropic.com &rarr; Settings &rarr; Billing</p>
    ${issueNumber ? `<p style="text-align:center;margin:0;font-size:13px;color:#888888;">Click <strong>Run workflow</strong> and enter issue number <strong>${issueNumber}</strong></p>` : ""}
  </div>

  <!-- Footer -->
  <div style="padding:20px 24px;background:#faf8f4;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <p style="margin:0 0 4px 0;font-size:14px;color:#8B6914;font-weight:600;text-align:center;">Sorting History</p>
    <p style="margin:0;font-size:13px;color:#777777;text-align:center;">Sort history's greatest moments into the correct order</p>
  </div>

  <!-- Bottom bar -->
  <div style="padding:16px 24px;background:#f5f0e8;border:1px solid #e5e1d8;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
    <p style="margin:0;font-size:10px;color:#aaaaaa;">SortingHistory Pipeline &bull; Billing alert</p>
  </div>
</div>`;
}

/**
 * Send a billing alert email when API credits are depleted.
 *
 * Fire-and-forget: catches all errors so the pipeline can exit cleanly.
 */
export async function sendBillingAlertEmail(
  errorMessage: string,
  issueNumber?: number,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey || !ownerEmail) {
    console.log("[notification] WARNING: RESEND_API_KEY or OWNER_EMAIL not configured — cannot send billing alert");
    return;
  }

  const subject = "Pipeline Stopped: API Credits Depleted";
  const html = buildBillingAlertHtml(errorMessage, issueNumber);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SortingHistory Pipeline <bugs@sortinghistory.com>",
        to: [ownerEmail],
        subject,
        html,
      }),
    });

    if (response.ok) {
      console.log("[notification] Billing alert email sent");
    } else {
      const errorText = await response.text();
      console.error("[notification] Resend API error (" + response.status + "): " + errorText);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[notification] Failed to send billing alert: " + errMsg);
  }
}

// ---------------------------------------------------------------------------
// Email sender
// ---------------------------------------------------------------------------

/**
 * Send an "Action Needed" email to the pipeline owner.
 *
 * - Reads RESEND_API_KEY and OWNER_EMAIL from process.env
 * - If either is missing, logs a warning and returns silently
 * - All errors caught — never throws, never breaks the pipeline
 */
export async function sendActionNeededEmail(
  input: ActionNeededEmailInput,
  action: RoutingAction,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey) {
    console.log("[notification] WARNING: RESEND_API_KEY not configured — skipping action email");
    return;
  }
  if (!ownerEmail) {
    console.log("[notification] WARNING: OWNER_EMAIL not configured — skipping action email");
    return;
  }

  const subject = `Urgent: #${input.issueNumber} — ${input.classification}`;
  const html = buildEmailHtml(input, action);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SortingHistory Pipeline <bugs@sortinghistory.com>",
        to: [ownerEmail],
        subject,
        html,
      }),
    });

    if (response.ok) {
      console.log("[notification] Action email sent for issue #" + input.issueNumber + " (" + input.classification + ")");
    } else {
      const errorText = await response.text();
      console.error("[notification] Resend API error (" + response.status + "): " + errorText);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[notification] Failed to send action email: " + errMsg);
  }
}

// ---------------------------------------------------------------------------
// PR Created notification email
// ---------------------------------------------------------------------------

export interface PRCreatedEmailInput {
  issueNumber: number;
  issueTitle: string;
  prNumber: number;
  prUrl: string;
  filesModified: string;
  compilation: string;
  confidence: string;
  fixAttempts: number;
  buildNumber?: string;
  pipelineMode: string;
  /** Original issue body — displayed as "What's the bug" in the email */
  issueBody?: string;
  /** QA review summary — displayed as "QA Review" in the email */
  qaSummary?: string;
  /** Plain-language summary of what the fix does (PIPE-011 AC-1) */
  fixSummary?: string;
  /** Raw unified diff text from GitHub API (PIPE-011 AC-2) */
  diffText?: string;
}

// ---------------------------------------------------------------------------
// PIPE-011: Diff rendering for PR email
// ---------------------------------------------------------------------------

const DIFF_MAX_LINES = 200;
const DIFF_MAX_BYTES = 50_000; // 50KB cap to avoid email clipping

/**
 * Parse a unified diff string and render it as email-safe HTML.
 *
 * - Green background for added lines, red for removed, gray for context
 * - File headers in bold monospace
 * - Truncates at DIFF_MAX_LINES or DIFF_MAX_BYTES
 * - Highlights SettingsView.swift version changes with yellow background
 * - Shows "Binary file changed" for binary diffs
 */
function buildDiffHtml(diffText: string, prUrl: string): string {
  if (!diffText || !diffText.trim()) return "";

  const lines = diffText.split("\n");
  let renderedLines = 0;
  let renderedBytes = 0;
  let truncated = false;
  const htmlParts: string[] = [];

  // Styles (inline for email compatibility)
  const monoFont = "font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;";
  const addStyle = `background:#e6ffec;color:#24292f;${monoFont}`;
  const removeStyle = `background:#ffebe9;color:#24292f;${monoFont}`;
  const contextStyle = `background:#f6f8fa;color:#24292f;${monoFont}`;
  const headerStyle = `background:#ddf4ff;color:#0969da;font-weight:700;${monoFont}`;
  const hunkStyle = `background:#f0f0f0;color:#656d76;${monoFont}`;
  const versionHighlightAdd = `background:#fef08a;color:#24292f;${monoFont}`;
  const versionHighlightRemove = `background:#fde68a;color:#24292f;${monoFont}`;

  let currentFile = "";

  for (const line of lines) {
    if (truncated) break;

    // Check byte budget
    const lineHtml = escapeHtml(line);
    renderedBytes += lineHtml.length + 80; // estimate tag overhead
    if (renderedBytes > DIFF_MAX_BYTES) {
      truncated = true;
      break;
    }

    // File header: diff --git a/path b/path
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : "";
      continue; // rendered when we hit the --- / +++ lines
    }

    // Binary file detection
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
      htmlParts.push(
        `<div style="padding:4px 10px;${hunkStyle}font-style:italic;">Binary file changed: ${escapeHtml(currentFile)}</div>`
      );
      renderedLines++;
      continue;
    }

    // File path headers (--- and +++)
    if (line.startsWith("---") || line.startsWith("+++")) {
      // Show the +++ line as the file header
      if (line.startsWith("+++")) {
        const filePath = line.replace(/^\+\+\+ [ab]\//, "").replace(/^\+\+\+ /, "");
        htmlParts.push(
          `<div style="padding:6px 10px;margin-top:12px;${headerStyle}font-size:13px;">${escapeHtml(filePath)}</div>`
        );
        renderedLines++;
      }
      continue;
    }

    // Hunk header: @@ -x,y +x,y @@
    if (line.startsWith("@@")) {
      htmlParts.push(
        `<div style="padding:2px 10px;${hunkStyle}font-size:12px;">${lineHtml}</div>`
      );
      renderedLines++;
      if (renderedLines >= DIFF_MAX_LINES) { truncated = true; break; }
      continue;
    }

    // Skip index and mode lines
    if (line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode") ||
        line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") ||
        line.startsWith("rename from") || line.startsWith("rename to")) {
      continue;
    }

    // Detect version string changes in SettingsView.swift for yellow highlight
    const isVersionLine = currentFile.includes("SettingsView") &&
      (line.includes("1.1.0-alpha.") || line.includes("1.1.0-beta."));

    // Diff content lines
    let style: string;
    if (line.startsWith("+")) {
      style = isVersionLine ? versionHighlightAdd : addStyle;
    } else if (line.startsWith("-")) {
      style = isVersionLine ? versionHighlightRemove : removeStyle;
    } else {
      style = contextStyle;
    }

    htmlParts.push(
      `<div style="padding:1px 10px;${style}font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:break-word;">${lineHtml}</div>`
    );
    renderedLines++;
    if (renderedLines >= DIFF_MAX_LINES) { truncated = true; break; }
  }

  if (htmlParts.length === 0) return "";

  let truncNote = "";
  if (truncated) {
    const filesUrl = `${prUrl}/files`;
    truncNote = `<div style="padding:8px 10px;background:#fff3cd;border-top:1px solid #e2e8f0;font-size:12px;color:#856404;">Diff truncated at ${renderedLines} lines &mdash; <a href="${filesUrl}" style="color:#0969da;text-decoration:underline;">View full diff on GitHub</a></div>`;
  }

  return `<!-- Code diff (PIPE-011 AC-2) -->
    <div style="margin:0 0 20px 0;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#166534;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Code Changes</p>
      <div style="border:1px solid #d0d7de;border-radius:6px;overflow:hidden;">
        ${htmlParts.join("\n        ")}
        ${truncNote}
      </div>
    </div>`;
}

export function buildPRCreatedEmailHtml(input: PRCreatedEmailInput): string {
  const safeTitle = escapeHtml(input.issueTitle);
  const safeFiles = escapeHtml(input.filesModified);
  const safeCompilation = escapeHtml(input.compilation);
  const safeConfidence = escapeHtml(input.confidence);
  const modeLabel = input.pipelineMode === "qa-only" ? " (QA-Only Re-Run)" : "";

  const authToken = process.env.AUTH_TOKEN;
  let reviewButtonHtml = "";
  let approveButtonHtml = "";
  let rejectButtonHtml = "";
  let reworkButtonHtml = "";
  let fixLocallyButtonHtml = "";
  if (authToken) {
    const encodedToken = encodeURIComponent(authToken);
    // PIPE-011 AC-7/AC-8: Review button — builds app, uploads to TestFlight (Empty Cup only)
    const reviewUrl = `https://sortinghistory.com/api/pipeline/review-build?issue=${input.issueNumber}&token=${encodedToken}`;
    reviewButtonHtml = `<a href="${reviewUrl}" style="display:inline-block;padding:14px 24px;background:#22863a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Review</a>`;
    // PIPE-011 AC-15: Approve button — merges PR to main after device testing
    const approveUrl = `https://sortinghistory.com/api/pipeline/approve-merge?issue=${input.issueNumber}&token=${encodedToken}`;
    approveButtonHtml = `<a href="${approveUrl}" style="display:inline-block;padding:14px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Approve</a>`;
    const reworkUrl = `https://sortinghistory.com/api/pipeline/rework?issue=${input.issueNumber}&token=${encodedToken}`;
    reworkButtonHtml = `<a href="${reworkUrl}" style="display:inline-block;padding:14px 24px;background:#d97706;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Rework</a>`;
    const rejectUrl = `https://sortinghistory.com/api/pipeline/reject?issue=${input.issueNumber}&token=${encodedToken}`;
    rejectButtonHtml = `<a href="${rejectUrl}" style="display:inline-block;padding:14px 24px;background:#cb2431;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Reject</a>`;
    const fixLocallyUrl = `https://sortinghistory.com/api/pipeline/fix-locally?issue=${input.issueNumber}&token=${encodedToken}`;
    fixLocallyButtonHtml = `<a href="${fixLocallyUrl}" style="display:inline-block;padding:14px 24px;background:#6b7280;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Fix Locally</a>`;
  }

  const versionHtml = input.buildNumber
    ? `<tr><td style="padding:8px 12px;font-weight:600;color:#166534;font-size:13px;">Build Number</td><td style="padding:8px 12px;font-size:14px;color:#333333;">${escapeHtml(input.buildNumber)}</td></tr>`
    : "";

  const retryHtml = input.fixAttempts > 1
    ? `<tr><td style="padding:8px 12px;font-weight:600;color:#166534;font-size:13px;">Fix Attempts</td><td style="padding:8px 12px;font-size:14px;color:#333333;">${input.fixAttempts} (with model escalation)</td></tr>`
    : "";

  // Bug description from issue body — preserve screenshots and device info (Story 3.4 AC5)
  let bugDescHtml = "";
  let prScreenshotsHtml = "";
  let prDeviceInfoHtml = "";
  if (input.issueBody) {
    const prepared = prepareIssueBody(input.issueBody, 5000, input.issueNumber);
    const safeDesc = escapeHtml(prepared.bodyText);
    let truncNote = "";
    if (prepared.wasTruncated && authToken) {
      const flUrl = `https://sortinghistory.com/api/pipeline/fix-locally?issue=${input.issueNumber}&token=${encodeURIComponent(authToken)}`;
      truncNote = `<p style="margin:8px 0 0;font-size:12px;color:#6b7280;"><a href="${flUrl}" style="color:#2563eb;">Full details available via Fix Locally</a></p>`;
    }
    bugDescHtml = `<!-- Bug description -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0f7ff;border-left:4px solid #2563eb;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What's The Bug</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeDesc}</p>
      ${truncNote}
    </div>`;
    prScreenshotsHtml = buildScreenshotsHtml(prepared.screenshotUrls);
    prDeviceInfoHtml = buildDeviceInfoHtml(prepared.deviceInfo);
  }

  // Fix summary (PIPE-011 AC-1)
  let fixSummaryHtml = "";
  if (input.fixSummary) {
    const safeSummary = escapeHtml(input.fixSummary);
    fixSummaryHtml = `<!-- Fix summary (PIPE-011 AC-1) -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0fdf4;border-left:4px solid #166534;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#166534;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What This Fix Does</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeSummary}</p>
    </div>`;
  }

  // Code diff (PIPE-011 AC-2)
  const codeDiffHtml = buildDiffHtml(input.diffText || "", input.prUrl);

  // QA summary
  let qaSummaryHtml = "";
  if (input.qaSummary) {
    const qaTruncated = input.qaSummary.length > 8000
      ? input.qaSummary.slice(0, 8000) + "\n\n[Truncated for email — full QA summary on GitHub PR]"
      : input.qaSummary;
    const safeQa = escapeHtml(qaTruncated);
    qaSummaryHtml = `<!-- QA review -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#fefce8;border-left:4px solid #ca8a04;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#ca8a04;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">QA Review</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeQa}</p>
    </div>`;
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0;background:#fffdf8;">
  <!-- Header -->
  <div style="background:#166534;padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <img src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History" style="width:80px;height:80px;border-radius:18px;margin-bottom:12px;" />
    <div style="display:inline-block;padding:4px 14px;background:#15803d;border-radius:20px;margin-bottom:8px;">
      <span style="color:#ffffff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">PR Ready</span>
    </div>
    <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">PR #${input.prNumber} Ready for Review${modeLabel}</h1>
  </div>

  <!-- Main content -->
  <div style="padding:28px 24px;background:#ffffff;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <!-- Bug title -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0fdf4;border-left:4px solid #22c55e;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#166534;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Bug #${input.issueNumber}</p>
      <p style="margin:0;font-size:15px;color:#333333;line-height:1.5;overflow-wrap:break-word;">${safeTitle}</p>
    </div>

    ${bugDescHtml}

    ${prScreenshotsHtml}

    ${prDeviceInfoHtml}

    ${fixSummaryHtml}

    ${codeDiffHtml}

    ${qaSummaryHtml}

    <!-- Details table -->
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">
      <tr><td style="padding:8px 12px;font-weight:600;width:120px;background:#f0fdf4;color:#166534;font-size:13px;">Compilation</td><td style="padding:8px 12px;background:#f0fdf4;font-size:14px;color:#333333;">${safeCompilation}</td></tr>
      <tr><td style="padding:8px 12px;font-weight:600;color:#166534;font-size:13px;">Confidence</td><td style="padding:8px 12px;font-size:14px;color:#333333;">${safeConfidence}</td></tr>
      ${retryHtml}
      ${versionHtml}
    </table>

    <!-- Files modified -->
    <p style="margin:0 0 6px 0;font-weight:600;font-size:13px;color:#166534;text-transform:uppercase;letter-spacing:0.5px;">Files Modified</p>
    <div style="margin:0 0 24px 0;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-family:monospace;font-size:13px;color:#334155;line-height:1.8;white-space:pre-line;overflow-wrap:break-word;">${safeFiles}</div>

    <!-- Action callout -->
    <div style="padding:14px 16px;background:#f0fdf4;border:2px solid #86efac;border-radius:8px;margin-bottom:24px;">
      <p style="margin:0;font-weight:700;color:#166534;font-size:14px;">The pipeline has generated a fix and it passed QA review. Click Review to build and test on TestFlight, then Approve to merge, Rework to retry, or Reject to discard.</p>
    </div>

    <!-- Action buttons (PIPE-011 AC-7: Review, Approve, Rework, Reject, Fix Locally) -->
    <div style="text-align:center;">
      ${reviewButtonHtml}
      ${approveButtonHtml}
      ${reworkButtonHtml}
      ${rejectButtonHtml}
      ${fixLocallyButtonHtml}
    </div>
  </div>

  <!-- Footer -->
  <div style="padding:20px 24px;background:#faf8f4;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <p style="margin:0 0 4px 0;font-size:14px;color:#8B6914;font-weight:600;text-align:center;">Sorting History</p>
    <p style="margin:0 0 12px 0;font-size:13px;color:#777777;text-align:center;">Sort history's greatest moments into the correct order</p>
    <p style="margin:0;font-size:13px;color:#888888;text-align:center;">
      <a href="https://sortinghistory.com" style="color:#8B6914;text-decoration:none;">Website</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://x.com/SortingHistory" style="color:#8B6914;text-decoration:none;">X/Twitter</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://instagram.com/sortinghistory" style="color:#8B6914;text-decoration:none;">Instagram</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://youtube.com/@sortinghistory" style="color:#8B6914;text-decoration:none;">YouTube</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://bsky.app/profile/sortinghistory.bsky.social" style="color:#8B6914;text-decoration:none;">Bluesky</a>
    </p>
  </div>

  <!-- Bottom bar -->
  <div style="padding:16px 24px;background:#f5f0e8;border:1px solid #e5e1d8;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
    <p style="margin:0 0 4px 0;font-size:12px;color:#8B6914;font-weight:600;">Sorting History &mdash; Learn history by playing it</p>
    <p style="margin:0 0 4px 0;font-size:11px;"><a href="https://sortinghistory.com" style="color:#999999;text-decoration:none;">sortinghistory.com</a></p>
    <p style="margin:0;font-size:10px;color:#aaaaaa;">SortingHistory Pipeline &bull; PR notification</p>
  </div>
</div>`;
}

/**
 * Send a "PR Created" email when the pipeline successfully creates a PR.
 *
 * Fire-and-forget: catches all errors so the pipeline can continue cleanly.
 */
export async function sendPRCreatedEmail(
  input: PRCreatedEmailInput,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey) {
    console.log("[notification] WARNING: RESEND_API_KEY not configured — skipping PR created email");
    return;
  }
  if (!ownerEmail) {
    console.log("[notification] WARNING: OWNER_EMAIL not configured — skipping PR created email");
    return;
  }

  const modeLabel = input.pipelineMode === "qa-only" ? " [QA re-run]" : "";
  const subject = `PR #${input.prNumber} Ready: Fix for #${input.issueNumber}${modeLabel}`;
  const html = buildPRCreatedEmailHtml(input);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SortingHistory Pipeline <bugs@sortinghistory.com>",
        to: [ownerEmail],
        subject,
        html,
      }),
    });

    if (response.ok) {
      console.log("[notification] PR created email sent for PR #" + input.prNumber + " (issue #" + input.issueNumber + ")");
    } else {
      const errorText = await response.text();
      console.error("[notification] Resend API error (" + response.status + "): " + errorText);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[notification] Failed to send PR created email: " + errMsg);
  }
}

// ---------------------------------------------------------------------------
// Handoff notification email
// ---------------------------------------------------------------------------

export interface HandoffEmailInput {
  issueNumber: number;
  issueTitle: string;
  totalAttempts: number;
  /** Short summary of what was tried */
  attemptSummary: string;
  /** The models used across attempts */
  modelsUsed: string[];
  /** Link to the handoff comment on GitHub */
  handoffCommentUrl?: string;
  /** Original issue body — displayed as "What's the bug" in the email */
  issueBody?: string;
}

export function buildHandoffEmailHtml(input: HandoffEmailInput): string {
  const safeTitle = escapeHtml(input.issueTitle);
  const safeAttemptSummary = escapeHtml(input.attemptSummary);
  const issueUrl = `https://github.com/RaufGlasgow/Sorting-History/issues/${input.issueNumber}`;
  const modelsText = escapeHtml(input.modelsUsed.join(", ") || "unknown");

  // Bug description from issue body — preserve screenshots and device info (Story 3.4 AC5)
  let handoffBugDescHtml = "";
  let handoffScreenshotsHtml = "";
  let handoffDeviceInfoHtml = "";
  if (input.issueBody) {
    const prepared = prepareIssueBody(input.issueBody, 5000, input.issueNumber);
    const safeDesc = escapeHtml(prepared.bodyText);
    let truncNote = "";
    if (prepared.wasTruncated) {
      const authTk = process.env.AUTH_TOKEN;
      if (authTk) {
        const flUrl = `https://sortinghistory.com/api/pipeline/fix-locally?issue=${input.issueNumber}&token=${encodeURIComponent(authTk)}`;
        truncNote = `<p style="margin:8px 0 0;font-size:12px;color:#6b7280;"><a href="${flUrl}" style="color:#2563eb;">Full details available via Fix Locally</a></p>`;
      }
    }
    handoffBugDescHtml = `
    <!-- Bug description -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0f7ff;border-left:4px solid #2563eb;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What's The Bug</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeDesc}</p>
      ${truncNote}
    </div>`;
    handoffScreenshotsHtml = buildScreenshotsHtml(prepared.screenshotUrls);
    handoffDeviceInfoHtml = buildDeviceInfoHtml(prepared.deviceInfo);
  }

  // Comment + Fix Locally button URLs
  const authToken = process.env.AUTH_TOKEN;
  let commentButtonHtml = "";
  let fixLocallyButtonHtml = "";
  if (authToken) {
    const encodedToken = encodeURIComponent(authToken);
    const commentUrl = `https://sortinghistory.com/api/pipeline/comment?issue=${input.issueNumber}&token=${encodedToken}`;
    commentButtonHtml = `<a href="${commentUrl}" style="display:inline-block;padding:14px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Provide Guidance</a>`;
    const fixLocallyUrl = `https://sortinghistory.com/api/pipeline/fix-locally?issue=${input.issueNumber}&token=${encodedToken}`;
    fixLocallyButtonHtml = `<a href="${fixLocallyUrl}" style="display:inline-block;padding:14px 24px;background:#6b7280;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Fix Locally</a>`;
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:0;background:#fffdf8;">
  <!-- Header -->
  <div style="background:#d97706;padding:32px 24px;text-align:center;border-radius:12px 12px 0 0;">
    <img src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History" style="width:80px;height:80px;border-radius:18px;margin-bottom:12px;" />
    <div style="display:inline-block;padding:4px 14px;background:#92400e;border-radius:20px;margin-bottom:8px;">
      <span style="color:#ffffff;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Handoff</span>
    </div>
    <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">Pipeline Needs Your Help</h1>
  </div>

  <!-- Main content -->
  <div style="padding:28px 24px;background:#ffffff;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <!-- Bug title -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#faf8f4;border-left:4px solid #DAA520;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#8B6914;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Bug #${input.issueNumber}</p>
      <p style="margin:0;font-size:15px;color:#333333;line-height:1.5;overflow-wrap:break-word;">${safeTitle}</p>
    </div>

    ${handoffBugDescHtml}

    ${handoffScreenshotsHtml}

    ${handoffDeviceInfoHtml}

    <!-- What happened -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#fffbeb;border-left:4px solid #d97706;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#d97706;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What Happened</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;">The pipeline tried <strong>${input.totalAttempts} fix attempt${input.totalAttempts === 1 ? "" : "s"}</strong> and could not produce a fix that passed all quality gates.</p>
    </div>

    <!-- Details table -->
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">
      <tr><td style="padding:8px 12px;font-weight:600;width:120px;background:#faf8f4;color:#8B6914;font-size:13px;">Attempts</td><td style="padding:8px 12px;background:#faf8f4;font-size:14px;color:#333333;">${input.totalAttempts}</td></tr>
      <tr><td style="padding:8px 12px;font-weight:600;color:#8B6914;font-size:13px;">Models Used</td><td style="padding:8px 12px;font-size:14px;color:#333333;">${modelsText}</td></tr>
    </table>

    <!-- Summary -->
    <p style="margin:0 0 6px 0;font-weight:600;font-size:13px;color:#8B6914;text-transform:uppercase;letter-spacing:0.5px;">Attempt Summary</p>
    <p style="margin:0 0 24px 0;font-size:14px;color:#444444;line-height:1.6;white-space:pre-line;">${safeAttemptSummary}</p>

    <!-- Action callout -->
    <div style="padding:14px 16px;background:#fffbeb;border:2px solid #fbbf24;border-radius:8px;margin-bottom:24px;">
      <p style="margin:0;font-weight:700;color:#92400e;font-size:14px;">The pipeline needs your guidance to make progress on this bug.</p>
    </div>

    <!-- Action buttons -->
    <div style="text-align:center;">
      <a href="${issueUrl}" style="display:inline-block;padding:14px 24px;background:#8B6914;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">View Handoff</a>
      ${commentButtonHtml}
      ${fixLocallyButtonHtml}
    </div>
  </div>

  <!-- Footer -->
  <div style="padding:20px 24px;background:#faf8f4;border-left:1px solid #e5e1d8;border-right:1px solid #e5e1d8;">
    <p style="margin:0 0 4px 0;font-size:14px;color:#8B6914;font-weight:600;text-align:center;">Sorting History</p>
    <p style="margin:0 0 12px 0;font-size:13px;color:#777777;text-align:center;">Sort history's greatest moments into the correct order</p>
    <p style="margin:0;font-size:13px;color:#888888;text-align:center;">
      <a href="https://sortinghistory.com" style="color:#8B6914;text-decoration:none;">Website</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://x.com/SortingHistory" style="color:#8B6914;text-decoration:none;">X/Twitter</a>
      &nbsp;&nbsp;&#183;&nbsp;&nbsp;
      <a href="https://instagram.com/sortinghistory" style="color:#8B6914;text-decoration:none;">Instagram</a>
    </p>
  </div>

  <!-- Bottom bar -->
  <div style="padding:16px 24px;background:#f5f0e8;border:1px solid #e5e1d8;border-top:none;border-radius:0 0 12px 12px;text-align:center;">
    <p style="margin:0 0 4px 0;font-size:12px;color:#8B6914;font-weight:600;">Sorting History &mdash; Learn history by playing it</p>
    <p style="margin:0;font-size:10px;color:#aaaaaa;">SortingHistory Pipeline &bull; Handoff notification</p>
  </div>
</div>`;
}

/**
 * Send a handoff notification email when the pipeline exhausts all fix attempts.
 *
 * Fire-and-forget: catches all errors so the pipeline can continue cleanly.
 */
export async function sendHandoffEmail(
  input: HandoffEmailInput,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!apiKey) {
    console.log("[notification] WARNING: RESEND_API_KEY not configured — skipping handoff email");
    return;
  }
  if (!ownerEmail) {
    console.log("[notification] WARNING: OWNER_EMAIL not configured — skipping handoff email");
    return;
  }

  const subject = `Handoff: #${input.issueNumber} — Pipeline needs your help`;
  const html = buildHandoffEmailHtml(input);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "SortingHistory Pipeline <bugs@sortinghistory.com>",
        to: [ownerEmail],
        subject,
        html,
      }),
    });

    if (response.ok) {
      console.log("[notification] Handoff email sent for issue #" + input.issueNumber);
    } else {
      const errorText = await response.text();
      console.error("[notification] Resend API error (" + response.status + "): " + errorText);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[notification] Failed to send handoff email: " + errMsg);
  }
}
