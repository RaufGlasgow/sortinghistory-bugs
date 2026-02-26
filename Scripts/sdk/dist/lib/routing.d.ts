/**
 * Story 4.2: Routing Logic
 *
 * Pure routing decision function + GitHub API executor.
 *
 * decideRoute() is a PURE function — zero side effects. Takes a RoutingInput
 * and returns a RoutingAction describing what to do.
 *
 * executeRoute() is the side-effect layer — calls GitHub API via native fetch().
 * Supports DRY_RUN mode: logs but does not execute.
 *
 * Idempotency: issues with `sdk-routed` label are skipped entirely.
 *
 * CRITICAL: Uses PRIVATE_REPO_PAT for all GitHub API calls.
 * github.token CANNOT trigger repository_dispatch (proven lesson — CLAUDE.md rule).
 */
import { type WorkflowType } from "../config.js";
/** Input to the routing decision function */
export interface RoutingInput {
    classification: string;
    severity: string;
    confidence: number;
    extracted_context: Record<string, unknown>;
    issue_number: number;
    /** Labels already on the issue — used for idempotency check */
    existing_labels?: string[];
    /** Issue title — needed for handoff_to_dev routes (BA-011 Story 2.4) */
    issue_title?: string;
    /** Issue body — needed for handoff_to_dev routes (BA-011 Story 2.4) */
    issue_body?: string;
    /** Triage reasoning — needed for handoff_to_dev routes */
    reasoning?: string;
}
/** Dispatch action — triggers a repository_dispatch event */
interface DispatchAction {
    type: "dispatch";
    event_type: string;
    repo: string;
    payload: Record<string, unknown>;
    /** Optional: labels to apply on the source issue (private repo) before dispatch (HIGH-4 fix) */
    issue_labels?: {
        repo: string;
        issue_number: number;
        labels: string[];
    };
}
/** Label action — adds labels to an issue */
interface LabelAction {
    type: "label";
    repo: string;
    issue_number: number;
    labels: string[];
}
/** Label + state file action — adds labels and creates workflow state */
interface LabelAndStateAction {
    type: "label_and_state";
    repo: string;
    issue_number: number;
    labels: string[];
    workflow_type: WorkflowType;
    category?: string;
}
/** Skip action — issue already routed */
interface SkipAction {
    type: "skip";
    reason: string;
    issue_number: number;
}
/** Handoff-to-dev action — generates structured handoff and posts to private repo (BA-011 ARCH-2) */
interface HandoffAction {
    type: "handoff_to_dev";
    repo: string;
    issue_number: number;
    labels: string[];
    triage_data: {
        classification: string;
        confidence: number;
        severity: string;
        reasoning: string;
        extracted_context: Record<string, unknown>;
        issue_title: string;
        issue_body: string;
    };
}
export type RoutingAction = DispatchAction | LabelAction | LabelAndStateAction | SkipAction | HandoffAction;
/**
 * Decide the routing action for a triage result.
 *
 * This is a PURE function: no I/O, no API calls, no randomness.
 * Returns a RoutingAction describing what to do.
 *
 * 3-gate system (BA-011):
 *   Gate 1: Low confidence → safe label (S4, AC3)
 *   Gate 2: Unknown classification → safe label (S1)
 *   Route: Known classification → routeByClassification()
 */
export declare function decideRoute(input: RoutingInput): RoutingAction;
/**
 * Execute a routing action against the GitHub API.
 *
 * When dryRun is true, logs the action but does NOT make API calls (AC-9).
 * Throws on non-2xx API responses (AC-11).
 */
export declare function executeRoute(action: RoutingAction, dryRun: boolean): Promise<void>;
export {};
