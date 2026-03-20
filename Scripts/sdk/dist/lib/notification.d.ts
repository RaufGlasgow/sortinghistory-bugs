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
export declare function shouldSendEmail(action: RoutingAction): boolean;
/**
 * Extract screenshots section from issue body — returns array of image URLs found.
 * Looks for markdown image syntax: ![alt](url)
 */
export declare function extractScreenshots(raw: string): string[];
/**
 * Extract the Device Info section from issue body.
 * Returns the section content or empty string if not found.
 */
export declare function extractDeviceInfo(raw: string): string;
/**
 * Prepare issue body for email display.
 * Story 3.4 AC5: Preserve screenshots (as linked images) and device info.
 * Only truncate prose text if body exceeds maxLength, but NEVER truncate
 * screenshots or device info.
 */
export declare function prepareIssueBody(raw: string, maxLength: number, issueNumber?: number): {
    bodyText: string;
    screenshotUrls: string[];
    deviceInfo: string;
    wasTruncated: boolean;
};
export declare function buildEmailHtml(input: ActionNeededEmailInput, action: RoutingAction): string;
/**
 * Send a billing alert email when API credits are depleted.
 *
 * Fire-and-forget: catches all errors so the pipeline can exit cleanly.
 */
export declare function sendBillingAlertEmail(errorMessage: string, issueNumber?: number): Promise<void>;
/**
 * Send an "Action Needed" email to the pipeline owner.
 *
 * - Reads RESEND_API_KEY and OWNER_EMAIL from process.env
 * - If either is missing, logs a warning and returns silently
 * - All errors caught — never throws, never breaks the pipeline
 */
export declare function sendActionNeededEmail(input: ActionNeededEmailInput, action: RoutingAction): Promise<void>;
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
export declare function buildPRCreatedEmailHtml(input: PRCreatedEmailInput): string;
/**
 * Send a "PR Created" email when the pipeline successfully creates a PR.
 *
 * Fire-and-forget: catches all errors so the pipeline can continue cleanly.
 */
export declare function sendPRCreatedEmail(input: PRCreatedEmailInput): Promise<void>;
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
export declare function buildHandoffEmailHtml(input: HandoffEmailInput): string;
/**
 * Send a handoff notification email when the pipeline exhausts all fix attempts.
 *
 * Fire-and-forget: catches all errors so the pipeline can continue cleanly.
 */
export declare function sendHandoffEmail(input: HandoffEmailInput): Promise<void>;
