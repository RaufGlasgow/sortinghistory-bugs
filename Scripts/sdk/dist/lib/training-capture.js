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
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../config.js";
// ---------------------------------------------------------------------------
// Directory + file helpers
// ---------------------------------------------------------------------------
const TRAINING_RAW_DIR = path.join(PATHS.TRAINING_DATA_DIR ?? "state/training", "raw");
function ensureTrainingDirs() {
    const base = PATHS.TRAINING_DATA_DIR ?? "state/training";
    for (const sub of ["raw", "prepared", "adapters", "merged"]) {
        const dir = path.join(base, sub);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
function todayDateStr() {
    return new Date().toISOString().slice(0, 10);
}
function rawFilePath(dateStr) {
    return path.join(TRAINING_RAW_DIR, `td-${dateStr}.jsonl`);
}
// ---------------------------------------------------------------------------
// Sequence number
// ---------------------------------------------------------------------------
/**
 * Read an existing JSONL file and determine the next sequence number.
 * Scans all `id` fields matching `td-{dateStr}-NNN-*` and returns max+1.
 */
export function getNextSequenceNumber(dateStr) {
    const filePath = rawFilePath(dateStr);
    if (!fs.existsSync(filePath)) {
        return 1;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    let maxSeq = 0;
    const prefix = `td-${dateStr}-`;
    for (const line of lines) {
        try {
            const entry = JSON.parse(line);
            if (entry.id && entry.id.startsWith(prefix)) {
                // id format: td-YYYY-MM-DD-NNN-turn-T or td-YYYY-MM-DD-NNN-summary or td-YYYY-MM-DD-NNN-verdict
                const afterPrefix = entry.id.slice(prefix.length);
                const seqStr = afterPrefix.split("-")[0];
                const seq = parseInt(seqStr, 10);
                if (!isNaN(seq) && seq > maxSeq) {
                    maxSeq = seq;
                }
            }
        }
        catch {
            // Skip malformed lines
        }
    }
    return maxSeq + 1;
}
// ---------------------------------------------------------------------------
// Core capture functions
// ---------------------------------------------------------------------------
/**
 * Append a training turn entry to today's JSONL file.
 *
 * Uses fs.appendFileSync for atomic appends (single write syscall).
 */
export function captureTrainingTurn(data) {
    ensureTrainingDirs();
    const dateStr = todayDateStr();
    const seq = getNextSequenceNumber(dateStr);
    const entry = {
        id: `td-${dateStr}-${String(seq).padStart(3, "0")}-turn-${data.turnNumber}`,
        workflow_id: data.workflowId,
        workflow_type: data.workflowType,
        timestamp: new Date().toISOString(),
        backend: data.backend,
        model: data.model,
        attempt_number: data.attemptNumber,
        turn_number: data.turnNumber,
        messages_in: data.messagesIn,
        tools_available: data.toolsAvailable,
        response: data.response,
        tool_results: data.toolResults,
        tokens_in: data.tokensIn,
        tokens_out: data.tokensOut,
        duration_ms: data.durationMs,
        outcome: data.outcome,
    };
    const filePath = rawFilePath(dateStr);
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    console.log(`[training-capture] Turn entry appended: ${entry.id}`);
}
/**
 * Append a training summary entry to today's JSONL file.
 */
export function writeTrainingSummary(data) {
    ensureTrainingDirs();
    const dateStr = todayDateStr();
    const seq = getNextSequenceNumber(dateStr);
    const entry = {
        id: `td-${dateStr}-${String(seq).padStart(3, "0")}-summary`,
        workflow_id: data.workflowId,
        outcome: data.outcome,
        total_turns: data.totalTurns,
        total_tokens_in: data.totalTokensIn,
        total_tokens_out: data.totalTokensOut,
        total_duration_ms: data.totalDurationMs,
        files_modified: data.filesModified,
        diff_size_bytes: data.diffSizeBytes,
        compile_result: data.compileResult,
        qa_verdict: data.qaVerdict,
        human_verdict: data.humanVerdict,
    };
    const filePath = rawFilePath(dateStr);
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    console.log(`[training-capture] Summary entry appended: ${entry.id}`);
}
/**
 * Append a human verdict update to TODAY's file.
 *
 * Always writes to today's file (not the original workflow day's file)
 * so the verdict can be applied asynchronously after human review.
 */
export function updateHumanVerdict(workflowId, verdict) {
    ensureTrainingDirs();
    const dateStr = todayDateStr();
    const seq = getNextSequenceNumber(dateStr);
    const entry = {
        id: `td-${dateStr}-${String(seq).padStart(3, "0")}-verdict`,
        workflow_id: workflowId,
        type: "verdict_update",
        human_verdict: verdict,
        timestamp: new Date().toISOString(),
    };
    const filePath = rawFilePath(dateStr);
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    console.log(`[training-capture] Verdict entry appended: ${entry.id} (${verdict} for ${workflowId})`);
}
