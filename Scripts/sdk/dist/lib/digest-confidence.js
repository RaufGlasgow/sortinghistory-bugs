/**
 * BA-011 Story 3.3: Morning Digest Confidence Integration
 *
 * Reads routing decision log (JSONL) to extract confidence data for the
 * morning digest email. Falls back to label-based detection when the
 * routing log is unavailable.
 *
 * This module is pure logic — no API calls, no side effects.
 * The GitHub Actions workflow calls the CLI entry point (digest-confidence-cli.ts)
 * which invokes these functions and outputs JSON for the bash steps to consume.
 *
 * Covers: FR22, FR23, FR24
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, CONFIDENCE_THRESHOLD, ROUTING } from "../config.js";
// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------
/**
 * Read routing decision log for a given date and return confidence data.
 *
 * Primary source: JSONL file at state/routing-log/YYYY-MM-DD.jsonl
 * Fallback: returns empty result with source="label_fallback" so the
 * workflow can fall back to label-based detection.
 *
 * @param date - YYYY-MM-DD string (defaults to today)
 * @param repoRoot - Repository root directory (defaults to env or cwd)
 */
export function readRoutingLogForDate(date, repoRoot) {
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const root = repoRoot ?? process.env.GITHUB_WORKSPACE ?? process.env.SDK_REPO_ROOT ?? process.cwd();
    const logDir = path.resolve(root, PATHS.ROUTING_LOG_DIR);
    const logFile = path.join(logDir, targetDate + ".jsonl");
    if (!fs.existsSync(logFile)) {
        return {
            date: targetDate,
            source: "label_fallback",
            needs_attention: [],
            normal: [],
            all: [],
        };
    }
    const lines = fs.readFileSync(logFile, "utf-8")
        .split("\n")
        .filter(line => line.trim().length > 0);
    const entries = [];
    for (const line of lines) {
        try {
            entries.push(JSON.parse(line));
        }
        catch {
            // Skip malformed lines — non-fatal
            continue;
        }
    }
    if (entries.length === 0) {
        return {
            date: targetDate,
            source: "label_fallback",
            needs_attention: [],
            normal: [],
            all: [],
        };
    }
    // Deduplicate by issue number (keep latest entry per issue)
    const byIssue = new Map();
    for (const entry of entries) {
        byIssue.set(entry.issue, entry);
    }
    const needsAttention = [];
    const normal = [];
    for (const entry of byIssue.values()) {
        const confidencePct = Math.round(entry.conf * 100);
        const display = entry.cls + " (" + confidencePct + "%)";
        const isLowConfidence = entry.conf < CONFIDENCE_THRESHOLD;
        const isUnknown = entry.gate === "unknown_classification";
        const flagged = isLowConfidence || isUnknown;
        let flagReason = "";
        if (isLowConfidence && isUnknown) {
            flagReason = "Low confidence (" + confidencePct + "%) + unknown classification";
        }
        else if (isLowConfidence) {
            flagReason = "Low confidence (" + confidencePct + "%)";
        }
        else if (isUnknown) {
            flagReason = "Unknown classification";
        }
        const data = {
            issue: entry.issue,
            classification: entry.cls,
            confidence: entry.conf,
            gate: entry.gate,
            labels: entry.labels,
            needs_attention: flagged,
            flag_reason: flagReason,
            display,
        };
        if (flagged) {
            needsAttention.push(data);
        }
        else {
            normal.push(data);
        }
    }
    return {
        date: targetDate,
        source: "routing_log",
        needs_attention: needsAttention,
        normal,
        all: [...needsAttention, ...normal],
    };
}
/**
 * Build label-based fallback confidence data from GitHub labels.
 *
 * Used when the routing log is unavailable. Detects flagged issues
 * by looking for low-confidence and unknown-classification labels.
 *
 * @param issues - Array of {number, labels} from GitHub API
 */
export function buildLabelFallback(issues) {
    const needsAttention = [];
    const normal = [];
    for (const issue of issues) {
        const hasLowConfidence = issue.labels.includes(ROUTING.LABEL_LOW_CONFIDENCE);
        const hasUnknown = issue.labels.includes(ROUTING.LABEL_UNKNOWN_CLASSIFICATION);
        const flagged = hasLowConfidence || hasUnknown;
        // Extract classification from labels (best-effort)
        const classificationLabel = issue.labels.find(l => l === ROUTING.LABEL_CONTENT_ERROR ||
            l === ROUTING.LABEL_TRANSLATION_ERROR ||
            l === ROUTING.LABEL_UI_BUG ||
            l === ROUTING.LABEL_GAMEPLAY_BUG ||
            l === ROUTING.LABEL_CONTENT_DUPLICATE ||
            l === ROUTING.LABEL_PERFORMANCE_ISSUE ||
            l === ROUTING.LABEL_CRASH_BUG ||
            l === ROUTING.LABEL_FEATURE_REQUEST ||
            l === ROUTING.LABEL_NEEDS_HUMAN_REVIEW) ?? "unknown";
        let flagReason = "";
        if (hasLowConfidence && hasUnknown) {
            flagReason = "Low confidence + unknown classification (from labels)";
        }
        else if (hasLowConfidence) {
            flagReason = "Low confidence (from labels)";
        }
        else if (hasUnknown) {
            flagReason = "Unknown classification (from labels)";
        }
        const data = {
            issue: issue.number,
            classification: classificationLabel,
            confidence: -1, // Unknown — label-based fallback
            gate: "unknown",
            labels: issue.labels,
            needs_attention: flagged,
            flag_reason: flagReason,
            display: classificationLabel + " (confidence unknown)",
        };
        if (flagged) {
            needsAttention.push(data);
        }
        else {
            normal.push(data);
        }
    }
    return {
        date: new Date().toISOString().slice(0, 10),
        source: "label_fallback",
        needs_attention: needsAttention,
        normal,
        all: [...needsAttention, ...normal],
    };
}
/**
 * Render the "Needs Attention" HTML section for the digest email.
 *
 * Returns empty string when there are no flagged issues (AC: omit section entirely).
 *
 * @param flaggedIssues - Issues from needs_attention array
 * @param issueUrlBase - Base URL for GitHub issues (e.g., "https://github.com/RaufGlasgow/Sorting-History/issues/")
 */
export function renderNeedsAttentionHtml(flaggedIssues, issueUrlBase) {
    if (flaggedIssues.length === 0) {
        return "";
    }
    let html = "<div style=\"margin-bottom:20px;padding:16px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;\">";
    html += "<h3 style=\"margin:0 0 12px 0;font-size:16px;color:#991b1b;\">Needs Attention</h3>";
    html += "<p style=\"margin:0 0 12px 0;font-size:13px;color:#991b1b;\">These bugs were flagged during triage — review classifications before acting.</p>";
    for (const issue of flaggedIssues) {
        const issueUrl = issueUrlBase + issue.issue;
        html += "<div style=\"margin-bottom:8px;padding:8px 12px;background:#fff;border-radius:4px;border-left:3px solid #dc2626;\">";
        html += "<a href=\"" + issueUrl + "\" style=\"color:#1d4ed8;font-weight:bold;text-decoration:none;\">#" + issue.issue + "</a>";
        html += " &mdash; <code style=\"background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:13px;\">" + issue.display + "</code>";
        if (issue.flag_reason) {
            html += "<br><span style=\"font-size:12px;color:#dc2626;\">" + issue.flag_reason + "</span>";
        }
        html += "</div>";
    }
    html += "</div>";
    return html;
}
/**
 * Format a classification + confidence for inline display in bug cards.
 *
 * Returns: "content_error (92%)" or "content_error (confidence unknown)" for label fallback.
 */
export function formatClassificationDisplay(classification, confidence) {
    if (confidence < 0) {
        return classification + " (confidence unknown)";
    }
    return classification + " (" + Math.round(confidence * 100) + "%)";
}
