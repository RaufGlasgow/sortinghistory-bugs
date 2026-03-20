/**
 * Story 3.1: Observability -- Health Metrics
 *
 * Pure computation functions that take WorkflowState arrays and return
 * aggregate metrics for the daily digest email. No side effects, no API calls.
 *
 * Covers: FR47 (success/failure rates), FR48 (failure pattern detection)
 */
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Number of days to include in the metrics window */
const METRICS_WINDOW_DAYS = 7;
/** Minimum consecutive gate failures before triggering a pattern alert */
const PATTERN_ALERT_THRESHOLD = 3;
/** Statuses that count as "completed" for success rate calculation */
const COMPLETED_STATUSES = new Set(["complete"]);
/** Statuses that count as "failed" for success rate calculation */
const FAILED_STATUSES = new Set(["fix_failed", "error", "escalated"]);
/** Statuses that are "in progress" (excluded from success rate denominator) */
const IN_PROGRESS_STATUSES = new Set([
    "verifying",
    "fixing",
    "re_verifying",
]);
/** Suggestion templates for pattern alerts */
const GATE_SUGGESTIONS = {
    factual_accuracy: "Content verifier factual accuracy gate failing repeatedly -- review Scripts/sdk/prompts/content-verifier.md for calibration",
    proof_check: "Proof check gate failing repeatedly -- review Scripts/sdk/prompts/content-verifier.md for calibration",
    diacritics: "Diacritics gate failing repeatedly -- check translation source data for encoding issues",
    date_validation: "Date validation gate failing repeatedly -- review event date format requirements",
};
const DEFAULT_SUGGESTION_TEMPLATE = "gate_name gate has failed COUNT consecutive times -- review pipeline configuration";
// ---------------------------------------------------------------------------
// Core computation functions
// ---------------------------------------------------------------------------
/**
 * Filter workflows to those created within the last N days.
 * Uses `created_at` field for the date window.
 */
export function filterByDateWindow(states, windowDays = METRICS_WINDOW_DAYS, now = new Date()) {
    const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
    return states.filter((s) => new Date(s.created_at).getTime() >= cutoff.getTime());
}
/**
 * Compute per-pipeline success rates.
 *
 * - Only completed + failed workflows count toward the denominator.
 * - In-progress workflows are excluded.
 * - "First attempt pass" = completed with fix_attempts <= 1.
 * - Returns "N/A" for success_rate when denominator is zero.
 */
export function computePipelineMetrics(states, pipelineType) {
    const pipelineStates = states.filter((s) => s.workflow_type === pipelineType);
    // Only count completed and failed workflows (not in-progress)
    const finished = pipelineStates.filter((s) => COMPLETED_STATUSES.has(s.status) || FAILED_STATUSES.has(s.status));
    const total = finished.length;
    if (total === 0) {
        return { total: 0, first_attempt_pass: 0, success_rate: "N/A" };
    }
    // First attempt pass: completed AND fix_attempts <= 1
    const firstAttemptPass = finished.filter((s) => COMPLETED_STATUSES.has(s.status) && s.fix_attempts <= 1).length;
    const rate = Math.round((firstAttemptPass / total) * 100);
    return {
        total,
        first_attempt_pass: firstAttemptPass,
        success_rate: `${rate}%`,
    };
}
/**
 * Compute queue depth: pending approval, in progress, and stuck.
 *
 * "Stuck" definition (AC3):
 *   - State status is `escalated`, OR
 *   - GitHub issue has `fix-failed` or `needs-human-review` label
 *   AND `updated_at` is older than 24 hours.
 */
export function computeQueueDepth(states, issueLabels, now = new Date()) {
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Build a lookup: issue_number -> labels
    const labelMap = new Map();
    for (const il of issueLabels) {
        labelMap.set(il.issue_number, il.labels);
    }
    let pendingApproval = 0;
    let inProgress = 0;
    let stuck = 0;
    for (const s of states) {
        if (s.status === "awaiting_approval") {
            pendingApproval++;
            continue;
        }
        if (IN_PROGRESS_STATUSES.has(s.status)) {
            inProgress++;
            continue;
        }
        // Check stuck: escalated status OR issue labels include fix-failed/needs-human-review
        const isEscalated = s.status === "escalated";
        const labels = s.issue_number != null ? (labelMap.get(s.issue_number) ?? []) : [];
        const hasStuckLabel = labels.includes("fix-failed") || labels.includes("needs-human-review");
        if ((isEscalated || hasStuckLabel) && new Date(s.updated_at).getTime() < twentyFourHoursAgo.getTime()) {
            stuck++;
        }
    }
    return { pending_approval: pendingApproval, in_progress: inProgress, stuck };
}
/**
 * Detect failure pattern alerts: gates that have failed 3+ consecutive times
 * across different workflow runs.
 *
 * Scans `findings[].gates_failed` across all workflows (sorted by created_at desc).
 * For each unique gate name, counts consecutive failures backward from most recent.
 */
export function detectPatternAlerts(states) {
    // Sort by created_at descending (most recent first)
    const sorted = [...states].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    // Collect all gate names that have ever failed
    const allGates = new Set();
    for (const s of sorted) {
        for (const f of s.findings) {
            for (const g of f.gates_failed) {
                allGates.add(g);
            }
        }
    }
    const alerts = [];
    for (const gate of allGates) {
        // For this gate, walk through workflows (most recent first).
        // Count how many consecutive workflows have this gate in their failures.
        let consecutiveCount = 0;
        const affectedWorkflows = [];
        for (const s of sorted) {
            const hasGateFailure = s.findings.some((f) => f.gates_failed.includes(gate));
            if (hasGateFailure) {
                consecutiveCount++;
                affectedWorkflows.push(s.workflow_id);
            }
            else {
                // A workflow without this gate failure breaks the streak
                break;
            }
        }
        if (consecutiveCount >= PATTERN_ALERT_THRESHOLD) {
            const suggestion = GATE_SUGGESTIONS[gate] ??
                DEFAULT_SUGGESTION_TEMPLATE
                    .replace("gate_name", gate)
                    .replace("COUNT", String(consecutiveCount));
            alerts.push({
                gate,
                consecutive_failures: consecutiveCount,
                affected_workflows: affectedWorkflows,
                suggestion,
            });
        }
    }
    return alerts;
}
/**
 * Main entry point: compute all health metrics from workflow states.
 *
 * @param states - All workflow state objects (from listWorkflowStates())
 * @param issueLabels - GitHub issue label data for stuck detection
 * @param now - Current time (injectable for testing)
 */
export function computeHealthMetrics(states, issueLabels = [], now = new Date()) {
    // Filter to 7-day window for pipeline metrics
    const recentStates = filterByDateWindow(states, METRICS_WINDOW_DAYS, now);
    // If no data at all, return early with message
    if (states.length === 0) {
        return {
            period: "7d",
            pipelines: {
                content_verification: { total: 0, first_attempt_pass: 0, success_rate: "N/A" },
                translation_verification: { total: 0, first_attempt_pass: 0, success_rate: "N/A" },
                bug_fix: { total: 0, first_attempt_pass: 0, success_rate: "N/A" },
            },
            queue: { pending_approval: 0, in_progress: 0, stuck: 0 },
            pattern_alerts: [],
            message: "No pipeline data yet -- metrics will appear after the first completed cycle",
        };
    }
    const pipelines = {
        content_verification: computePipelineMetrics(recentStates, "content_verification"),
        translation_verification: computePipelineMetrics(recentStates, "translation_verification"),
        bug_fix: computePipelineMetrics(recentStates, "bug_fix"),
    };
    // Queue depth uses ALL states (not filtered by date — queue is current state)
    const queue = computeQueueDepth(states, issueLabels, now);
    // Pattern detection uses recent states only
    const pattern_alerts = detectPatternAlerts(recentStates);
    return {
        period: "7d",
        pipelines,
        queue,
        pattern_alerts,
        message: null,
    };
}
// ---------------------------------------------------------------------------
// Digest HTML builder
// ---------------------------------------------------------------------------
/**
 * Build the "System Health" HTML section for the daily digest email.
 * Returns an HTML string that should be placed at the TOP of the digest.
 */
export function buildHealthSectionHtml(metrics) {
    if (metrics.message) {
        return `
    <!-- System Health -->
    <div style="margin:0 0 24px 0;padding:16px 20px;background:#f0f7ff;border-left:4px solid #2563eb;border-radius:4px;">
      <p style="margin:0 0 4px 0;font-size:12px;color:#2563eb;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">System Health</p>
      <p style="margin:0;font-size:14px;color:#555555;font-style:italic;">${escapeHtml(metrics.message)}</p>
    </div>`;
    }
    // Build pipeline success rates table
    const pipelineRows = [
        buildPipelineRow("Content Verification", metrics.pipelines.content_verification),
        buildPipelineRow("Translation Verification", metrics.pipelines.translation_verification),
        buildPipelineRow("Bug Fix", metrics.pipelines.bug_fix),
    ].join("");
    // Build queue depth
    const queueHtml = `
    <div style="margin:12px 0;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">
      <p style="margin:0 0 6px 0;font-weight:600;font-size:13px;color:#334155;">Queue Depth</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 8px;font-size:13px;color:#555;">Pending Approval</td><td style="padding:4px 8px;font-size:13px;font-weight:600;text-align:right;">${metrics.queue.pending_approval}</td></tr>
        <tr><td style="padding:4px 8px;font-size:13px;color:#555;">In Progress</td><td style="padding:4px 8px;font-size:13px;font-weight:600;text-align:right;">${metrics.queue.in_progress}</td></tr>
        <tr><td style="padding:4px 8px;font-size:13px;color:#555;">Stuck</td><td style="padding:4px 8px;font-size:13px;font-weight:600;color:${metrics.queue.stuck > 0 ? "#dc2626" : "#333"};text-align:right;">${metrics.queue.stuck}</td></tr>
      </table>
    </div>`;
    // Build pattern alerts (if any)
    let alertsHtml = "";
    if (metrics.pattern_alerts.length > 0) {
        const alertItems = metrics.pattern_alerts
            .map((a) => `<div style="padding:10px 14px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;margin:6px 0;">
        <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;color:#991b1b;">Pattern Alert: ${escapeHtml(a.gate)}</p>
        <p style="margin:0;font-size:13px;color:#555;">Failed ${a.consecutive_failures} consecutive times across: ${a.affected_workflows.map(w => "<code>" + escapeHtml(w) + "</code>").join(", ")}</p>
        <p style="margin:4px 0 0;font-size:12px;color:#777;font-style:italic;">${escapeHtml(a.suggestion)}</p>
      </div>`)
            .join("");
        alertsHtml = `
    <div style="margin:12px 0;">
      <p style="margin:0 0 6px 0;font-weight:600;font-size:13px;color:#991b1b;text-transform:uppercase;letter-spacing:0.5px;">Alerts</p>
      ${alertItems}
    </div>`;
    }
    return `
    <!-- System Health -->
    <div style="margin:0 0 24px 0;padding:16px 20px;background:#f0f7ff;border:1px solid #bfdbfe;border-radius:8px;">
      <p style="margin:0 0 12px 0;font-size:14px;color:#2563eb;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">System Health (Last 7 Days)</p>

      <!-- Pipeline success rates -->
      <table style="width:100%;border-collapse:collapse;margin:0 0 8px 0;">
        <tr style="border-bottom:1px solid #e2e8f0;">
          <th style="padding:6px 8px;font-size:12px;color:#64748b;text-align:left;font-weight:600;">Pipeline</th>
          <th style="padding:6px 8px;font-size:12px;color:#64748b;text-align:right;font-weight:600;">Total</th>
          <th style="padding:6px 8px;font-size:12px;color:#64748b;text-align:right;font-weight:600;">1st Pass</th>
          <th style="padding:6px 8px;font-size:12px;color:#64748b;text-align:right;font-weight:600;">Rate</th>
        </tr>
        ${pipelineRows}
      </table>

      ${queueHtml}
      ${alertsHtml}
    </div>`;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildPipelineRow(label, m) {
    const rateColor = m.success_rate === "N/A" ? "#94a3b8" : parseInt(m.success_rate) >= 80 ? "#16a34a" : parseInt(m.success_rate) >= 50 ? "#ca8a04" : "#dc2626";
    return `<tr>
    <td style="padding:6px 8px;font-size:13px;color:#333;">${escapeHtml(label)}</td>
    <td style="padding:6px 8px;font-size:13px;text-align:right;">${m.total}</td>
    <td style="padding:6px 8px;font-size:13px;text-align:right;">${m.first_attempt_pass}</td>
    <td style="padding:6px 8px;font-size:13px;font-weight:600;color:${rateColor};text-align:right;">${m.success_rate}</td>
  </tr>`;
}
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
