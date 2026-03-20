/**
 * BA-011 Story 1.3: Routing Decision Log
 *
 * Append-only JSONL writer for routing decisions.
 * One file per day at state/routing-log/YYYY-MM-DD.jsonl.
 *
 * Fire-and-forget: logging failures are non-fatal (console.error only).
 * decideRoute() remains pure — this is called by the caller (triage.ts), not inside routing.
 *
 * Schema: {ts, issue, cls, conf, action, labels, gate}
 * No sensitive content: issue numbers (integers) and classification metadata only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../config.js";
/**
 * Append a routing decision to the JSONL log.
 *
 * Each line is a self-contained JSON object (JSONL format).
 * This function is fire-and-forget — logging failures are non-fatal.
 */
export function logRoutingDecision(entry) {
    try {
        const repoRoot = process.env.GITHUB_WORKSPACE ?? process.env.SDK_REPO_ROOT ?? process.cwd();
        const dir = path.resolve(repoRoot, PATHS.ROUTING_LOG_DIR);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const filePath = path.join(dir, date + ".jsonl");
        const line = JSON.stringify(entry) + "\n";
        fs.appendFileSync(filePath, line, "utf-8");
    }
    catch (err) {
        // Non-fatal: logging failure must never crash the pipeline
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[routing-log] WARNING: Failed to write routing decision log: " + errMsg);
    }
}
