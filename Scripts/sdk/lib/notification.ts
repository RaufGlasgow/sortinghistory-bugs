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

function buildEmailHtml(input: ActionNeededEmailInput, action: RoutingAction): string {
  const safeTitle = escapeHtml(input.issueTitle);
  const safeClassification = escapeHtml(input.classification);
  const safeSeverity = escapeHtml(input.severity);
  const confidencePercent = Math.round(input.confidence * 100);
  const safeReasoning = escapeHtml(input.reasoning);
  const actionMessage = escapeHtml(getActionMessage(action));
  const issueUrl = `https://github.com/RaufGlasgow/Sorting-History/issues/${input.issueNumber}`;

  // Build bug description section (truncated to 1000 chars for email)
  let descriptionHtml = "";
  if (input.description) {
    // Extract just the description text, strip markdown images and device info table
    let descText = input.description
      .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, "[screenshot attached]") // strip base64 images
      .replace(/\|[^\n]*\|/g, "") // strip markdown tables
      .replace(/---/g, "")
      .replace(/## Device Info[\s\S]*?(?=##|$)/, "") // strip device info section
      .replace(/## Screenshot[\s\S]*?(?=##|$)/, "") // strip screenshot section
      .replace(/_Submitted via Sorting History app_/, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (descText.length > 1000) {
      descText = descText.slice(0, 1000) + "...";
    }
    const safeDescription = escapeHtml(descText);
    descriptionHtml = `
    <!-- Reporter description -->
    <div style="margin:0 0 20px 0;padding:14px 16px;background:#f0f7ff;border-left:4px solid #2563eb;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What The Reporter Said</p>
      <p style="margin:0;font-size:14px;color:#333333;line-height:1.5;overflow-wrap:break-word;white-space:pre-line;">${safeDescription}</p>
    </div>`;
  }

  // Generate action button URLs if AUTH_TOKEN is available
  const authToken = process.env.AUTH_TOKEN;
  let actionButtonsHtml: string;
  let githubLinkHtml: string;
  if (authToken) {
    const encodedToken = encodeURIComponent(authToken);
    const approveUrl = `https://sortinghistory.com/api/pipeline/approve?issue=${input.issueNumber}&amp;token=${encodedToken}`;
    const rejectUrl = `https://sortinghistory.com/api/pipeline/reject?issue=${input.issueNumber}&amp;token=${encodedToken}`;
    const commentUrl = `https://sortinghistory.com/api/pipeline/comment?issue=${input.issueNumber}&amp;token=${encodedToken}`;
    actionButtonsHtml = `<a href="${approveUrl}" style="display:inline-block;padding:14px 24px;background:#22863a;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Approve Fix</a>
      <a href="${rejectUrl}" style="display:inline-block;padding:14px 24px;background:#cb2431;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Reject</a>
      <a href="${commentUrl}" style="display:inline-block;padding:14px 24px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;margin:0 6px 8px;">Comment</a>`;
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

    <!-- Classification table -->
    <table style="width:100%;border-collapse:collapse;margin:0 0 20px 0;">
      <tr><td style="padding:8px 12px;font-weight:600;width:120px;background:#faf8f4;color:#8B6914;font-size:13px;">Classification</td><td style="padding:8px 12px;background:#faf8f4;font-size:14px;color:#333333;"><code style="background:#fef9f3;padding:2px 6px;border-radius:3px;">${safeClassification}</code> @ ${confidencePercent}% confidence</td></tr>
      <tr><td style="padding:8px 12px;font-weight:600;color:#8B6914;font-size:13px;">Severity</td><td style="padding:8px 12px;font-size:14px;color:#333333;">${safeSeverity}</td></tr>
    </table>

    <!-- AI Reasoning -->
    <p style="margin:0 0 6px 0;font-weight:600;font-size:13px;color:#8B6914;text-transform:uppercase;letter-spacing:0.5px;">AI Reasoning</p>
    <p style="margin:0 0 24px 0;font-size:14px;color:#444444;line-height:1.6;">${safeReasoning}</p>

    <!-- Action callout -->
    <div style="padding:14px 16px;background:#fef2f2;border:2px solid #fca5a5;border-radius:8px;margin-bottom:24px;">
      <p style="margin:0;font-weight:700;color:#991b1b;font-size:14px;">${actionMessage}</p>
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
