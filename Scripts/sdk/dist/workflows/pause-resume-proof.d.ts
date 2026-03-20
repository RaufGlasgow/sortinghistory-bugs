/**
 * Story 1.5: Session Pause/Resume Proof
 *
 * Proves that an SDK session can be PAUSED after a subagent produces a finding,
 * the session ID saved to disk, and then a SECOND invocation can RESUME that
 * session with full prior context — the resumed agent knows about the finding
 * without re-reading files.
 *
 * This is the CRITICAL architecture pattern for:
 *   verify -> pause -> human approves -> resume -> fix
 *
 * Two-phase proof:
 *   Phase 1 (PAUSE): Subagent reads USHistory.json, identifies 3rd event,
 *     reports as "finding". Session persisted, state saved as awaiting_approval.
 *   Phase 2 (RESUME): Resumed session asked to recall the finding WITHOUT
 *     re-reading the file. Must correctly report event_title and year.
 *
 * Exit codes:
 *   0: Both phases passed
 *   1: Any validation failed
 */
/**
 * Phase 1: Run subagent, capture finding, save session, pause.
 * Returns the workflow_id for Phase 2 to resume.
 */
export declare function runPausePhase1(): Promise<string>;
/**
 * Phase 2: Resume session, verify context preserved.
 */
export declare function runResumePhase2(workflowId: string): Promise<void>;
/**
 * Combined proof: runs both phases sequentially (for local/CI testing).
 * Phase 1 pauses, then Phase 2 resumes immediately — simulating the
 * human-in-the-loop flow without the actual wait.
 */
export declare function runPauseResumeProof(): Promise<void>;
