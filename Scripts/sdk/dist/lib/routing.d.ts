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
export type RoutingAction = DispatchAction | LabelAction | LabelAndStateAction | SkipAction;
/**
 * Decide the routing action for a triage result.
 *
 * This is a PURE function: no I/O, no API calls, no randomness.
 * Returns a RoutingAction describing what to do.
 *
 * Throws on unknown classification (defensive).
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
