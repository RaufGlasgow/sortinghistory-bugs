/** A single session entry mapping a workflow to an SDK session */
export interface SessionEntry {
    session_id: string;
    status: "active" | "paused" | "completed";
    paused_at: string | null;
    resume_step: string | null;
}
/** The session registry file — maps workflow IDs to SDK session IDs */
export interface SessionRegistry {
    sessions: Record<string, SessionEntry>;
}
/** Save a session entry when a workflow pauses for human approval */
export declare function saveSession(workflowId: string, sessionId: string, resumeStep: string): Promise<void>;
/** Look up a session for a workflow. Returns null if not found. */
export declare function getSession(workflowId: string): Promise<SessionEntry | null>;
/** Remove a session entry after workflow completes or session expires */
export declare function removeSession(workflowId: string): Promise<void>;
/** Mark a session as completed */
export declare function completeSession(workflowId: string): Promise<void>;
/** List all paused sessions (for digest generation) */
export declare function listPausedSessions(): Promise<Record<string, SessionEntry>>;
