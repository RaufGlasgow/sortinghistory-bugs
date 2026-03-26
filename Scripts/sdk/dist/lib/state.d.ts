import { type WorkflowType, type WorkflowStatus } from "../config.js";
/** A single finding from a verification pass */
export interface WorkflowFinding {
    event_id: string;
    event_title: string;
    gates_failed: string[];
    details: string;
    severity: string;
}
/** Log entry for a single fix attempt (Story PV2-2.4) */
export interface AttemptLogEntry {
    /** 1-based attempt number */
    attempt_number: number;
    /** Model ID used for this attempt */
    model: string;
    /** Description of the fix approach taken */
    approach: string;
    /** Outcome: "success", "compilation_error", "qa_rejected", "qa_needs_revision", "quality_gate_fail", "timeout", "error" */
    result: string;
    /** Compiler or runtime error output, if any */
    error_output: string | null;
    /** ISO 8601 timestamp */
    timestamp: string;
}
/** QA verdict for a single attempt (Story PV2-2.4) */
export interface QAVerdictEntry {
    /** 1-based attempt number this verdict applies to */
    attempt_number: number;
    /** QA verdict: "pass", "fail", "partial" */
    verdict: string;
    /** Array of specific findings from QA review */
    findings: string[];
    /** Human-readable summary of QA review */
    summary: string;
    /** ISO 8601 timestamp */
    timestamp: string;
}
/** Token usage and cost tracking per SDK call (Story PV2-2.4) */
export interface ModelUsageEntry {
    /** Pipeline step (e.g. "fix_attempt_1", "qa_review_1", "triage") */
    step: string;
    /** Model ID used */
    model: string;
    /** Input tokens consumed */
    input_tokens: number;
    /** Output tokens consumed */
    output_tokens: number;
    /** Estimated cost in USD */
    cost_estimate: number;
    /** ISO 8601 timestamp */
    timestamp: string;
}
/** Workflow instance state — persists between SDK sessions across approval gates */
export interface WorkflowState {
    workflow_id: string;
    workflow_type: WorkflowType;
    status: WorkflowStatus;
    session_id: string | null;
    created_at: string;
    updated_at: string;
    trigger: "scheduled" | "dispatch" | "manual";
    category: string | null;
    findings: WorkflowFinding[];
    approved_findings: WorkflowFinding[];
    rejected_findings: WorkflowFinding[];
    fix_attempts: number;
    max_fix_attempts: number;
    fix_results: unknown[];
    pr_number: number | null;
    error: string | null;
    issue_number: number | null;
    /** Detailed log of each fix attempt (PV2-2.4) */
    attempt_log: AttemptLogEntry[];
    /** QA review results per attempt (PV2-2.4) */
    qa_results: QAVerdictEntry[];
    /** Token/cost tracking per SDK call (PV2-2.4) */
    models_used: ModelUsageEntry[];
    /** Stale translation detection results (FR43) */
    stale_translations: unknown | null;
}
/** Create a new workflow state file */
export declare function createWorkflowState(type: WorkflowType, trigger: "scheduled" | "dispatch" | "manual", category?: string, issueNumber?: number): Promise<WorkflowState>;
/** Update an existing workflow state file (partial update) */
export declare function updateWorkflowState(workflowId: string, updates: Partial<WorkflowState>): Promise<WorkflowState>;
/** Load a workflow state file by ID. Returns null if not found.
 *  Backward compatible: old state files missing PV2-2.4 fields get empty-array defaults. */
export declare function loadWorkflowState(workflowId: string): Promise<WorkflowState | null>;
/** List all workflow state files, optionally filtered by status */
export declare function listWorkflowStates(statusFilter?: WorkflowStatus): Promise<WorkflowState[]>;
/** Find the most recent workflow state for a given issue number. Returns null if none found. */
export declare function findWorkflowByIssue(issueNumber: number): Promise<WorkflowState | null>;
