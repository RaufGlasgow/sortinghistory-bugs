/**
 * Persistent Pipeline Error Logger
 *
 * Append-only JSONL writer for pipeline events: fix attempts, QA failures,
 * max_turns hits, pipeline completion/failure. One file: pipeline-errors.jsonl.
 *
 * Fire-and-forget: logging failures are non-fatal (console.error only).
 * This NEVER throws — callers do not need try/catch.
 *
 * Schema: {ts, workflow_id, issue, event, severity, model?, attempt?,
 *          turns_used?, tokens_in?, tokens_out?, cost_usd?, error_msg?, details?}
 */
/** Severity levels for pipeline log entries */
export type PipelineLogSeverity = "info" | "warn" | "error";
/** Pipeline log entry written as a single JSONL line */
export interface PipelineLogEntry {
    /** ISO 8601 timestamp */
    ts: string;
    /** Workflow ID, e.g. "bf-2026-02-27-001" */
    workflow_id: string;
    /** GitHub issue number */
    issue: number;
    /** Event type */
    event: string;
    /** Severity level */
    severity: PipelineLogSeverity;
    /** Model used (if applicable) */
    model?: string;
    /** Attempt number (if applicable) */
    attempt?: number;
    /** How many turns were consumed (if available) */
    turns_used?: number;
    /** Input tokens */
    tokens_in?: number;
    /** Output tokens */
    tokens_out?: number;
    /** Cost in USD */
    cost_usd?: number;
    /** Error message (truncated to 500 chars) */
    error_msg?: string;
    /** Additional context (truncated to 1000 chars) */
    details?: string;
}
/**
 * Append a pipeline event to the JSONL log.
 *
 * Each line is a self-contained JSON object (JSONL format).
 * Fire-and-forget: this function NEVER throws.
 */
export declare function logPipelineEvent(entry: Omit<PipelineLogEntry, "ts">): void;
