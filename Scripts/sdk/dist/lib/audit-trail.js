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
import { updateWorkflowState, loadWorkflowState, } from "./state.js";
import { estimateCost, truncateError } from "../config.js";
// ---------------------------------------------------------------------------
// Subagent attempt logging (AC1)
// ---------------------------------------------------------------------------
/**
 * Log a subagent call to the workflow's attempt_log.
 * Appends a new AttemptLogEntry to the existing array.
 *
 * @param workflowId - The workflow state file to update
 * @param input - Details of the subagent call
 * @returns Updated workflow state
 */
export async function logSubagentAttempt(workflowId, input) {
    const current = await loadWorkflowState(workflowId);
    if (!current) {
        throw new Error(`Workflow state not found: ${workflowId}`);
    }
    const entry = {
        attempt_number: current.attempt_log.length + 1,
        model: input.model,
        approach: input.approach.slice(0, 200), // Keep approach concise
        result: input.result,
        error_output: input.error_output ? truncateError(input.error_output) : null,
        timestamp: new Date().toISOString(),
    };
    return updateWorkflowState(workflowId, {
        attempt_log: [...current.attempt_log, entry],
    });
}
// ---------------------------------------------------------------------------
// Model usage logging (AC2)
// ---------------------------------------------------------------------------
/**
 * Log token usage and cost for a subagent call.
 * Appends a new ModelUsageEntry to the existing array.
 *
 * @param workflowId - The workflow state file to update
 * @param input - Token usage details
 * @returns Updated workflow state
 */
export async function logModelUsage(workflowId, input) {
    const current = await loadWorkflowState(workflowId);
    if (!current) {
        throw new Error(`Workflow state not found: ${workflowId}`);
    }
    const entry = {
        step: input.step,
        model: input.model,
        input_tokens: input.input_tokens,
        output_tokens: input.output_tokens,
        cost_estimate: estimateCost(input.model, input.input_tokens, input.output_tokens),
        timestamp: new Date().toISOString(),
    };
    return updateWorkflowState(workflowId, {
        models_used: [...current.models_used, entry],
    });
}
// ---------------------------------------------------------------------------
// Workflow failure handling (AC4)
// ---------------------------------------------------------------------------
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
export async function handleWorkflowFailure(workflowId, input) {
    return updateWorkflowState(workflowId, {
        status: input.targetStatus,
        error: input.error,
    });
}
// ---------------------------------------------------------------------------
// Workflow resume from failure (AC5)
// ---------------------------------------------------------------------------
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
export async function handleWorkflowResume(workflowId) {
    const current = await loadWorkflowState(workflowId);
    if (!current) {
        return {
            canResume: false,
            escalated: false,
            state: null,
            labelActions: { add: [], remove: [] },
        };
    }
    // Check if max attempts reached
    if (current.fix_attempts >= current.max_fix_attempts) {
        const updated = await updateWorkflowState(workflowId, {
            status: "escalated",
            error: `Max fix attempts (${current.max_fix_attempts}) reached -- escalating to human review`,
        });
        return {
            canResume: false,
            escalated: true,
            state: updated,
            labelActions: {
                add: ["needs-human-review"],
                remove: ["fix-failed", "in-progress"],
            },
        };
    }
    // Resume: increment fix_attempts, set status to fixing, clear error
    const updated = await updateWorkflowState(workflowId, {
        status: "fixing",
        fix_attempts: current.fix_attempts + 1,
        error: null,
    });
    return {
        canResume: true,
        escalated: false,
        state: updated,
        labelActions: {
            add: ["in-progress"],
            remove: ["fix-failed"],
        },
    };
}
