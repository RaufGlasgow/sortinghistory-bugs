/**
 * Story 3.1: Observability -- Health Metrics
 *
 * Pure computation functions that take WorkflowState arrays and return
 * aggregate metrics for the daily digest email. No side effects, no API calls.
 *
 * Covers: FR47 (success/failure rates), FR48 (failure pattern detection)
 */
import type { WorkflowState } from "./state.js";
import type { WorkflowType } from "../config.js";
/** Per-pipeline success rate metrics */
export interface PipelineMetrics {
    total: number;
    first_attempt_pass: number;
    success_rate: string;
}
/** Queue depth breakdown */
export interface QueueDepth {
    pending_approval: number;
    in_progress: number;
    stuck: number;
}
/** A detected failure pattern alert */
export interface PatternAlert {
    gate: string;
    consecutive_failures: number;
    affected_workflows: string[];
    suggestion: string;
}
/** GitHub issue label data needed for queue depth "stuck" detection */
export interface IssueLabelData {
    issue_number: number;
    labels: string[];
}
/** Full health metrics output */
export interface HealthMetrics {
    period: string;
    pipelines: {
        content_verification: PipelineMetrics;
        translation_verification: PipelineMetrics;
        bug_fix: PipelineMetrics;
    };
    queue: QueueDepth;
    pattern_alerts: PatternAlert[];
    message: string | null;
}
/**
 * Filter workflows to those created within the last N days.
 * Uses `created_at` field for the date window.
 */
export declare function filterByDateWindow(states: WorkflowState[], windowDays?: number, now?: Date): WorkflowState[];
/**
 * Compute per-pipeline success rates.
 *
 * - Only completed + failed workflows count toward the denominator.
 * - In-progress workflows are excluded.
 * - "First attempt pass" = completed with fix_attempts <= 1.
 * - Returns "N/A" for success_rate when denominator is zero.
 */
export declare function computePipelineMetrics(states: WorkflowState[], pipelineType: WorkflowType): PipelineMetrics;
/**
 * Compute queue depth: pending approval, in progress, and stuck.
 *
 * "Stuck" definition (AC3):
 *   - State status is `escalated`, OR
 *   - GitHub issue has `fix-failed` or `needs-human-review` label
 *   AND `updated_at` is older than 24 hours.
 */
export declare function computeQueueDepth(states: WorkflowState[], issueLabels: IssueLabelData[], now?: Date): QueueDepth;
/**
 * Detect failure pattern alerts: gates that have failed 3+ consecutive times
 * across different workflow runs.
 *
 * Scans `findings[].gates_failed` across all workflows (sorted by created_at desc).
 * For each unique gate name, counts consecutive failures backward from most recent.
 */
export declare function detectPatternAlerts(states: WorkflowState[]): PatternAlert[];
/**
 * Main entry point: compute all health metrics from workflow states.
 *
 * @param states - All workflow state objects (from listWorkflowStates())
 * @param issueLabels - GitHub issue label data for stuck detection
 * @param now - Current time (injectable for testing)
 */
export declare function computeHealthMetrics(states: WorkflowState[], issueLabels?: IssueLabelData[], now?: Date): HealthMetrics;
/**
 * Build the "System Health" HTML section for the daily digest email.
 * Returns an HTML string that should be placed at the TOP of the digest.
 */
export declare function buildHealthSectionHtml(metrics: HealthMetrics): string;
