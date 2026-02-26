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
  const safeReasoning = escapeHtml(
    input.reasoning.length > 200 ? input.reasoning.slice(0, 200) + "..." : input.reasoning,
  );
  const actionMessage = escapeHtml(getActionMessage(action));
  const issueUrl = `https://github.com/RaufGlasgow/Sorting-History/issues/${input.issueNumber}`;

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#1a1a1a;margin:0 0 16px 0;">Action Needed: Bug #${input.issueNumber}</h2>
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px;background:#fafafa;">
    <h3 style="margin:0 0 8px 0;font-size:16px;color:#111827;overflow-wrap:break-word;">${safeTitle}</h3>
    <table style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr><td style="padding:6px 12px;font-weight:600;width:120px;background:#f5f5f5;">Classification</td><td style="padding:6px 12px;background:#f5f5f5;"><code>${safeClassification}</code> @ ${confidencePercent}% confidence</td></tr>
      <tr><td style="padding:6px 12px;font-weight:600;">Severity</td><td style="padding:6px 12px;">${safeSeverity}</td></tr>
    </table>
    <p style="margin:12px 0 4px 0;font-weight:600;font-size:13px;color:#374151;">AI Reasoning:</p>
    <p style="margin:0 0 16px 0;font-size:14px;color:#1a1a1a;line-height:1.4;">${safeReasoning}</p>
    <div style="padding:12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;margin-bottom:16px;">
      <p style="margin:0;font-weight:600;color:#991b1b;font-size:14px;">${actionMessage}</p>
    </div>
    <a href="${issueUrl}" style="display:inline-block;padding:12px 24px;background:#0366d6;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:bold;">View Issue on GitHub</a>
  </div>
  <p style="color:#999;font-size:12px;text-align:center;margin-top:16px;">SortingHistory Pipeline &bull; Real-time alert</p>
</div>`;
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

  const subject = `Action Needed: #${input.issueNumber} — ${input.classification}`;
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
