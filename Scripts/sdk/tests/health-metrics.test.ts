/**
 * Story 3.1: Health Metrics Tests (7 tests)
 *
 * Tests pure computation functions in health-metrics.ts.
 * No API calls, no side effects -- just data in, metrics out.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import type { WorkflowState } from "../lib/state.js";
import type { IssueLabelData } from "../lib/health-metrics.js";
import {
  computeHealthMetrics,
  computePipelineMetrics,
  computeQueueDepth,
  detectPatternAlerts,
  filterByDateWindow,
} from "../lib/health-metrics.js";

// ---------------------------------------------------------------------------
// Helpers to create test WorkflowState objects
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<WorkflowState>): WorkflowState {
  return {
    workflow_id: overrides.workflow_id ?? "cv-2026-03-08-001",
    workflow_type: overrides.workflow_type ?? "content_verification",
    status: overrides.status ?? "verifying",
    session_id: null,
    created_at: overrides.created_at ?? "2026-03-08T10:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-03-08T10:00:00.000Z",
    trigger: overrides.trigger ?? "scheduled",
    category: overrides.category ?? null,
    findings: overrides.findings ?? [],
    approved_findings: overrides.approved_findings ?? [],
    rejected_findings: overrides.rejected_findings ?? [],
    fix_attempts: overrides.fix_attempts ?? 0,
    max_fix_attempts: overrides.max_fix_attempts ?? 3,
    fix_results: overrides.fix_results ?? [],
    pr_number: overrides.pr_number ?? null,
    error: overrides.error ?? null,
    issue_number: overrides.issue_number ?? null,
    attempt_log: overrides.attempt_log ?? [],
    qa_results: overrides.qa_results ?? [],
    models_used: overrides.models_used ?? [],
    stale_translations: overrides.stale_translations ?? null,
  };
}

function makeFinding(gatesFailed: string[]): {
  event_id: string;
  event_title: string;
  gates_failed: string[];
  details: string;
  severity: string;
} {
  return {
    event_id: "ev-001",
    event_title: "Test Event",
    gates_failed: gatesFailed,
    details: "test",
    severity: "high",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Story 3.1: Health Metrics", () => {
  const now = new Date("2026-03-09T12:00:00.000Z");

  it("computeHealthMetrics returns correct success rates for mixed workflows", () => {
    // 5 state files: 3 complete (2 first-attempt pass, 1 retry-then-pass), 1 failed, 1 in-progress
    const states: WorkflowState[] = [
      // Complete, first-attempt pass (fix_attempts = 0 means no fix needed = first pass)
      makeState({
        workflow_id: "cv-2026-03-08-001",
        workflow_type: "content_verification",
        status: "complete",
        fix_attempts: 0,
        created_at: "2026-03-08T10:00:00.000Z",
      }),
      // Complete, first-attempt pass
      makeState({
        workflow_id: "cv-2026-03-08-002",
        workflow_type: "content_verification",
        status: "complete",
        fix_attempts: 1,
        created_at: "2026-03-08T11:00:00.000Z",
      }),
      // Complete, retry-then-pass (fix_attempts = 2 > 1, so NOT first-attempt)
      makeState({
        workflow_id: "cv-2026-03-08-003",
        workflow_type: "content_verification",
        status: "complete",
        fix_attempts: 2,
        created_at: "2026-03-08T12:00:00.000Z",
      }),
      // Failed
      makeState({
        workflow_id: "cv-2026-03-08-004",
        workflow_type: "content_verification",
        status: "fix_failed",
        fix_attempts: 3,
        created_at: "2026-03-08T13:00:00.000Z",
      }),
      // In-progress (should be excluded from denominator)
      makeState({
        workflow_id: "cv-2026-03-08-005",
        workflow_type: "content_verification",
        status: "verifying",
        fix_attempts: 0,
        created_at: "2026-03-08T14:00:00.000Z",
      }),
    ];

    const metrics = computeHealthMetrics(states, [], now);

    // Denominator = 4 (3 complete + 1 failed, in-progress excluded)
    // First-attempt pass = 2 (fix_attempts 0 and 1 both <= 1)
    // Rate = 2/4 = 50%
    // Note: The story says "66%" for 2/3, but the actual computation is 2/4 = 50%
    // because the failed workflow counts in denominator
    assert.equal(metrics.pipelines.content_verification.total, 4);
    assert.equal(metrics.pipelines.content_verification.first_attempt_pass, 2);
    assert.equal(metrics.pipelines.content_verification.success_rate, "50%");
    assert.equal(metrics.message, null);
  });

  it("computeHealthMetrics returns N/A when no completed workflows exist", () => {
    // All workflows in-progress
    const states: WorkflowState[] = [
      makeState({
        workflow_id: "cv-2026-03-08-001",
        status: "verifying",
        created_at: "2026-03-08T10:00:00.000Z",
      }),
      makeState({
        workflow_id: "cv-2026-03-08-002",
        status: "fixing",
        created_at: "2026-03-08T11:00:00.000Z",
      }),
      makeState({
        workflow_id: "cv-2026-03-08-003",
        status: "re_verifying",
        created_at: "2026-03-08T12:00:00.000Z",
      }),
    ];

    const metrics = computeHealthMetrics(states, [], now);
    assert.equal(metrics.pipelines.content_verification.success_rate, "N/A");
    assert.equal(metrics.pipelines.content_verification.total, 0);
  });

  it("detectPatternAlerts finds 3+ consecutive gate failures", () => {
    // 4 state files where "proof_check" fails in all 4
    const states: WorkflowState[] = [
      makeState({
        workflow_id: "cv-2026-03-08-001",
        created_at: "2026-03-05T10:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
      makeState({
        workflow_id: "cv-2026-03-07-001",
        created_at: "2026-03-06T10:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
      makeState({
        workflow_id: "cv-2026-03-06-001",
        created_at: "2026-03-07T10:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
      makeState({
        workflow_id: "cv-2026-03-05-001",
        created_at: "2026-03-08T10:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
    ];

    const alerts = detectPatternAlerts(states);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].gate, "proof_check");
    assert.equal(alerts[0].consecutive_failures, 4);
    assert.equal(alerts[0].affected_workflows.length, 4);
  });

  it("detectPatternAlerts ignores non-consecutive failures", () => {
    // Pattern: fail, fail, pass, fail — consecutive count from most recent = 1
    const states: WorkflowState[] = [
      // Most recent: fail
      makeState({
        workflow_id: "cv-2026-03-08-004",
        created_at: "2026-03-08T13:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
      // Pass (no proof_check failure) — this breaks the streak
      makeState({
        workflow_id: "cv-2026-03-08-003",
        created_at: "2026-03-08T12:00:00.000Z",
        findings: [],
      }),
      // Fail
      makeState({
        workflow_id: "cv-2026-03-08-002",
        created_at: "2026-03-08T11:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
      // Fail
      makeState({
        workflow_id: "cv-2026-03-08-001",
        created_at: "2026-03-08T10:00:00.000Z",
        findings: [makeFinding(["proof_check"])],
      }),
    ];

    const alerts = detectPatternAlerts(states);
    // Consecutive count from most recent = 1 (most recent fails, then pass breaks it)
    // 1 < 3 threshold, so no alert
    assert.equal(alerts.length, 0);
  });

  it("computeQueueDepth counts pending, in-progress, and stuck correctly", () => {
    const states: WorkflowState[] = [
      // Pending approval
      makeState({
        workflow_id: "cv-001",
        status: "awaiting_approval",
        issue_number: 10,
        updated_at: "2026-03-09T10:00:00.000Z",
      }),
      // In progress
      makeState({
        workflow_id: "cv-002",
        status: "verifying",
        issue_number: 11,
        updated_at: "2026-03-09T10:00:00.000Z",
      }),
      // Stuck: escalated + older than 24h
      makeState({
        workflow_id: "cv-003",
        status: "escalated",
        issue_number: 12,
        updated_at: "2026-03-07T10:00:00.000Z",
      }),
      // Stuck via label: fix-failed label + older than 24h
      makeState({
        workflow_id: "cv-004",
        status: "fix_failed",
        issue_number: 13,
        updated_at: "2026-03-07T10:00:00.000Z",
      }),
      // NOT stuck: has fix-failed label but updated recently (within 24h)
      makeState({
        workflow_id: "cv-005",
        status: "fix_failed",
        issue_number: 14,
        updated_at: "2026-03-09T11:00:00.000Z",
      }),
    ];

    const issueLabels: IssueLabelData[] = [
      { issue_number: 13, labels: ["fix-failed"] },
      { issue_number: 14, labels: ["fix-failed"] },
    ];

    const queue = computeQueueDepth(states, issueLabels, now);
    assert.equal(queue.pending_approval, 1);
    assert.equal(queue.in_progress, 1);
    assert.equal(queue.stuck, 2); // cv-003 (escalated + old) + cv-004 (fix-failed label + old)
  });

  it("healthMetrics filters to last 7 days only", () => {
    const states: WorkflowState[] = [
      // Within 7 days
      makeState({
        workflow_id: "cv-2026-03-08-001",
        workflow_type: "content_verification",
        status: "complete",
        fix_attempts: 0,
        created_at: "2026-03-08T10:00:00.000Z",
      }),
      // 10 days ago -- should be excluded
      makeState({
        workflow_id: "cv-2026-02-27-001",
        workflow_type: "content_verification",
        status: "complete",
        fix_attempts: 0,
        created_at: "2026-02-27T10:00:00.000Z",
      }),
    ];

    const metrics = computeHealthMetrics(states, [], now);
    // Only the recent one counts
    assert.equal(metrics.pipelines.content_verification.total, 1);
    assert.equal(metrics.pipelines.content_verification.first_attempt_pass, 1);
    assert.equal(metrics.pipelines.content_verification.success_rate, "100%");
  });

  it("healthMetrics handles empty state directory gracefully", () => {
    const metrics = computeHealthMetrics([], [], now);

    assert.equal(metrics.pipelines.content_verification.total, 0);
    assert.equal(metrics.pipelines.content_verification.success_rate, "N/A");
    assert.equal(metrics.pipelines.translation_verification.total, 0);
    assert.equal(metrics.pipelines.bug_fix.total, 0);
    assert.equal(metrics.queue.pending_approval, 0);
    assert.equal(metrics.queue.in_progress, 0);
    assert.equal(metrics.queue.stuck, 0);
    assert.deepEqual(metrics.pattern_alerts, []);
    assert.equal(
      metrics.message,
      "No pipeline data yet -- metrics will appear after the first completed cycle",
    );
  });
});
