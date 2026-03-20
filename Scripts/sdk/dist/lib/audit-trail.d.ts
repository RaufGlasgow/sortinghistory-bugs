/**
 * Story 3.2: Audit Trail Completion and Error Recovery
 *
 * Provides helper functions for logging subagent calls, token usage,
 * handling workflow failures, and resuming from failure points.
 *
 * These functions wrap updateWorkflowState() to append to array fields
 * (attempt_log, models_used) rather than replacing them.
 *
 * Covers: FR44 (audit trail), FR46 (decision history), FR40 (JSON integrity),
 *         FR39 (no auto-merge on error), FR17 (escalation on repeated failure)
 */
import { type WorkflowState } from "./state.js";
/** Input for logging a subagent attempt */
export interface SubagentAttemptInput {
    model: string;
    approach: string;
    result: string;
    error_output: string | null;
}
/** Input for logging model usage */
export interface ModelUsageInput {
    step: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
}
/** Input for handling workflow failure */
export interface WorkflowFailureInput {
    error: string;
    targetStatus: "fix_failed" | "error";
}
/** Result from attempting to resume a workflow */
export interface WorkflowResumeResult {
    canResume: boolean;
    escalated: boolean;
    state: WorkflowState | null;
    /** Label actions the caller should execute via GitHub API */
    labelActions: {
        add: string[];
        remove: string[];
    };
}
/**
 * Log a subagent call to the workflow's attempt_log.
 * Appends a new AttemptLogEntry to the existing array.
 *
 * @param workflowId - The workflow state file to update
 * @param input - Details of the subagent call
 * @returns Updated workflow state
 */
export declare function logSubagentAttempt(workflowId: string, input: SubagentAttemptInput): Promise<WorkflowState>;
/**
 * Log token usage and cost for a subagent call.
 * Appends a new ModelUsageEntry to the existing array.
 *
 * @param workflowId - The workflow state file to update
 * @param input - Token usage details
 * @returns Updated workflow state
 */
export declare function logModelUsage(workflowId: string, input: ModelUsageInput): Promise<WorkflowState>;
/**
 * Handle a workflow failure: update state file with error details and status.
 *
 * The caller is responsible for applying label changes via GitHub API
 * (remove in-progress, add fix-failed).
 *
 * @param workflowId - The workflow state file to update
 * @param input - Failure details
 * @returns Updated workflow state
 */
export declare function handleWorkflowFailure(workflowId: string, input: WorkflowFailureInput): Promise<WorkflowState>;
/**
 * Attempt to resume a failed workflow from its failure point.
 *
 * If fix_attempts < max_fix_attempts:
 *   - Increments fix_attempts
 *   - Sets status back to "fixing"
 *   - Clears error field
 *   - Returns canResume: true
 *
 * If fix_attempts >= max_fix_attempts:
 *   - Sets status to "escalated"
 *   - Returns escalated: true, canResume: false
 *   - Caller should add "needs-human-review" label
 *
 * @param workflowId - The workflow state file to resume
 * @returns Resume result with label actions for the caller
 */
export declare function handleWorkflowResume(workflowId: string): Promise<WorkflowResumeResult>;
