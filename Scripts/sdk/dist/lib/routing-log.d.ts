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
/** Routing decision log entry (NFR4 schema) */
export interface RoutingDecisionLogEntry {
    /** ISO 8601 timestamp */
    ts: string;
    /** GitHub issue number (integer only — no title/body) */
    issue: number;
    /** Classification string */
    cls: string;
    /** Confidence score (0.0-1.0) */
    conf: number;
    /** Action type taken */
    action: string;
    /** Labels applied */
    labels: string[];
    /** Which gate determined the route */
    gate: "confidence" | "unknown_classification" | "idempotency" | "classification_route";
}
/**
 * Append a routing decision to the JSONL log.
 *
 * Each line is a self-contained JSON object (JSONL format).
 * This function is fire-and-forget — logging failures are non-fatal.
 */
export declare function logRoutingDecision(entry: RoutingDecisionLogEntry): void;
