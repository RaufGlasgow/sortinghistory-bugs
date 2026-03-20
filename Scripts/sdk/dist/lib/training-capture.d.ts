/**
 * Story 1.4: Training Data Capture
 *
 * Captures per-turn conversation data and workflow summaries in JSONL format
 * for later use in fine-tuning local models (Story 1.5).
 *
 * Output: state/training/raw/td-YYYY-MM-DD.jsonl (one JSON object per line)
 *
 * Three entry types:
 *   - TrainingTurnEntry: per-turn messages, tools, tokens, timing
 *   - TrainingSummaryEntry: per-workflow outcome, totals, files changed
 *   - TrainingVerdictEntry: human verdict (approved/rejected/reworked)
 */
export interface TrainingTurnEntry {
    id: string;
    workflow_id: string;
    workflow_type: string;
    timestamp: string;
    backend: "local" | "claude";
    model: string;
    attempt_number: number;
    turn_number: number;
    messages_in: Array<{
        role: string;
        content: string | null;
        tool_calls?: unknown[];
    }>;
    tools_available: string[];
    response: {
        content: string | null;
        tool_calls?: unknown[];
    };
    tool_results: Array<{
        name: string;
        result: string;
    }>;
    tokens_in: number;
    tokens_out: number;
    duration_ms: number;
    outcome: string | null;
}
export type TrainingOutcome = "compile_passed" | "compile_failed" | "qa_rejected" | "qa_passed" | "timeout" | "error";
export interface TrainingSummaryEntry {
    id: string;
    workflow_id: string;
    outcome: TrainingOutcome;
    total_turns: number;
    total_tokens_in: number;
    total_tokens_out: number;
    total_duration_ms: number;
    files_modified: string[];
    diff_size_bytes: number;
    compile_result: string | null;
    qa_verdict: string | null;
    human_verdict: "approved" | "rejected" | "reworked" | null;
}
export interface TrainingVerdictEntry {
    id: string;
    workflow_id: string;
    type: "verdict_update";
    human_verdict: "approved" | "rejected" | "reworked";
    timestamp: string;
}
export interface TrainingTurnInput {
    workflowId: string;
    workflowType: string;
    backend: "local" | "claude";
    model: string;
    attemptNumber: number;
    turnNumber: number;
    messagesIn: Array<{
        role: string;
        content: string | null;
        tool_calls?: unknown[];
    }>;
    toolsAvailable: string[];
    response: {
        content: string | null;
        tool_calls?: unknown[];
    };
    toolResults: Array<{
        name: string;
        result: string;
    }>;
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
    outcome: string | null;
}
export interface TrainingSummaryInput {
    workflowId: string;
    outcome: TrainingOutcome;
    totalTurns: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalDurationMs: number;
    filesModified: string[];
    diffSizeBytes: number;
    compileResult: string | null;
    qaVerdict: string | null;
    humanVerdict: "approved" | "rejected" | "reworked" | null;
}
/**
 * Read an existing JSONL file and determine the next sequence number.
 * Scans all `id` fields matching `td-{dateStr}-NNN-*` and returns max+1.
 */
export declare function getNextSequenceNumber(dateStr: string): number;
/**
 * Append a training turn entry to today's JSONL file.
 *
 * Uses fs.appendFileSync for atomic appends (single write syscall).
 */
export declare function captureTrainingTurn(data: TrainingTurnInput): void;
/**
 * Append a training summary entry to today's JSONL file.
 */
export declare function writeTrainingSummary(data: TrainingSummaryInput): void;
/**
 * Append a human verdict update to TODAY's file.
 *
 * Always writes to today's file (not the original workflow day's file)
 * so the verdict can be applied asynchronously after human review.
 */
export declare function updateHumanVerdict(workflowId: string, verdict: "approved" | "rejected" | "reworked"): void;
