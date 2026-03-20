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
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../config.js";
/**
 * Truncate a string to maxLen characters if it exceeds that length.
 */
function truncate(s, maxLen) {
    if (s === undefined)
        return undefined;
    return s.length > maxLen ? s.slice(0, maxLen) : s;
}
/**
 * Append a pipeline event to the JSONL log.
 *
 * Each line is a self-contained JSON object (JSONL format).
 * Fire-and-forget: this function NEVER throws.
 */
export function logPipelineEvent(entry) {
    try {
        const repoRoot = process.env.GITHUB_WORKSPACE ?? process.env.SDK_REPO_ROOT ?? process.cwd();
        const dir = path.resolve(repoRoot, PATHS.LOG_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, "pipeline-errors.jsonl");
        const full = {
            ts: new Date().toISOString(),
            ...entry,
            error_msg: truncate(entry.error_msg, 500),
            details: truncate(entry.details, 1000),
        };
        const line = JSON.stringify(full) + "\n";
        fs.appendFileSync(filePath, line, "utf-8");
    }
    catch (err) {
        // Non-fatal: logging failure must never crash the pipeline
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[pipeline-log] WARNING: Failed to write pipeline log: " + errMsg);
    }
}
