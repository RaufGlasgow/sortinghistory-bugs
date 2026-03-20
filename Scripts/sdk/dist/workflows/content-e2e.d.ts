/**
 * Story 2.3 + 2.4b + PV2-4.3: Content End-to-End Orchestration
 *
 * Full content pipeline: verification -> approval gate -> fix (with retry loop) -> QA -> PR
 *
 * State machine:
 *   verifying -> awaiting_approval -> fixing -> re_verifying -> complete | escalated
 *
 * Story PV2-4.3 refactor:
 *   - runFixLoop() replaced with call to runRetryLoop() from retry-loop.ts (AC1)
 *   - Content fixes use Content QA profile (QN-1 through QN-5) (AC2)
 *   - Model escalation: Haiku -> Sonnet via content_simple profile (AC3)
 *   - QA feedback included in retry prompts (AC4)
 *   - On exhausted retries: content-specific handoff + comment + label (AC5, AC7)
 *   - createPullRequest() uses safeGitAdd() (AC6, already done in PV2-1.3)
 *
 * Orchestration loop (runContentE2E):
 *   1. Run verifier (content-verify.ts) -> get findings
 *   2. Save state as awaiting_approval with findings, pause session
 *   3. On resume (with approval): run retry loop with content fix subagent
 *   4. Retry loop handles: fix -> QA (content profile) -> quality gate -> model escalation
 *   5. If retry loop succeeds -> create PR via `gh pr create` -> state complete
 *   6. If retry loop fails -> generate handoff, post comment, label issue -> state escalated
 *
 * Resume flow (resumeContentE2E):
 *   1. Load paused workflow state
 *   2. processApproval() -> split approved/rejected
 *   3. runContentRetryLoop() -> retry loop with content context
 *   4. finalizeWorkflow() -> PR or escalation with handoff
 *
 * FR39: No auto-merge -- PR is created for human review only.
 *
 * Exit codes:
 * - 0: Success (workflow completed -- either PR created or escalated)
 * - 1: Failure (could not run pipeline)
 */
import { type ValidationResult } from "../lib/validate-fix.js";
import { type WorkflowStatus } from "../config.js";
import { type WorkflowState, type WorkflowFinding } from "../lib/state.js";
import { type RetryLoopResult } from "../lib/retry-loop.js";
/** Input for the E2E content orchestration */
export interface ContentE2EInput {
    /** Path to the JSON file to verify (absolute or relative to cwd) */
    filePath: string;
    /** Category name (for logging and state) */
    category?: string;
    /** Path to corrections log file */
    correctionsLogPath: string;
    /** Working directory / repo root */
    repoRoot?: string;
    /** If true, skip actual `gh pr create` and log what would happen */
    dryRun?: boolean;
    /** Branch name to use for PR (defaults to auto-generated) */
    branch?: string;
    /** Base branch for the PR (defaults to main) */
    baseBranch?: string;
    /** GitHub issue number that triggered this workflow (AC9) */
    issue_number?: number;
}
/** Result of the E2E orchestration */
export interface ContentE2EResult {
    /** Final workflow status */
    status: WorkflowStatus;
    /** Workflow ID for tracking */
    workflowId: string;
    /** Total findings from initial verification */
    totalFindings: number;
    /** Findings approved by owner */
    approvedFindings: number;
    /** Number of fix attempts made */
    fixAttempts: number;
    /** PR number if created (null if escalated or dry-run) */
    prNumber: number | null;
    /** PR URL if created */
    prUrl: string | null;
    /** Error message if something went wrong */
    error: string | null;
}
/** Simulated approval response (for test and manual runs) */
export interface ApprovalResponse {
    action: "approve" | "reject";
    /** Indices of findings to approve (empty = approve all) */
    approvedIndices?: number[];
    /** Reason for rejection (if action = reject) */
    rejectionReason?: string;
}
/**
 * Story 2.0c: Run validate-fix gate between re-verify and PR creation.
 *
 * AC1/AC2: Called in both resumeContentE2E and resumeTranslationE2E
 * AC3: Captures git diff to temp file before calling validateFix
 * AC9: Direct function call, not subprocess
 * AC10: Logs when validate-fix runs, result, and action taken
 *
 * Returns the validation result. Caller handles failure actions.
 */
export declare function runValidateFixGate(issueNumber: number, issueBody: string, issueLabels: string[], gameRepoPath: string): ValidationResult;
/**
 * Story 2.0c: Handle validate-fix failure -- post comment, add/remove labels.
 *
 * AC4: Post comment with failure details
 * AC5: Add validation-failed label (NOT fix-failed)
 * AC6: Remove fix-in-progress label if present
 */
export declare function handleValidationFailure(issueNumber: number, result: ValidationResult): void;
/**
 * Process an approval response against workflow findings.
 *
 * Separates findings into approved and rejected sets based on the approval.
 * If approval action is "reject", all findings are rejected.
 * If approval action is "approve" with no specific indices, all are approved.
 *
 * Extracted from runContentE2E() lines 377-426 for reuse by resumeContentE2E().
 */
export declare function processApproval(state: WorkflowState, approval: ApprovalResponse): {
    approved: WorkflowFinding[];
    rejected: WorkflowFinding[];
};
/**
 * Finalize a workflow: create PR if fixes passed, escalate with handoff if they failed.
 *
 * PV2-4.3 changes:
 *   - Accepts RetryLoopResult instead of the old fix loop result
 *   - On failure: generates content-specific handoff, posts comment, labels issue (AC5, AC7)
 *   - On success: includes QA summary in PR body
 */
export declare function finalizeWorkflow(state: WorkflowState, gameRepoPath: string, options: {
    dryRun: boolean;
    category: string;
    branch: string;
    baseBranch: string;
    retryResult: RetryLoopResult;
    approvedFindings: WorkflowFinding[];
    issueNumber?: number;
}): Promise<{
    prNumber: number | null;
    prUrl: string | null;
    escalated: boolean;
}>;
/**
 * Run the full content E2E pipeline.
 *
 * This function handles the complete flow:
 * - Initial verification
 * - Approval gate (simulated for local/test runs)
 * - Fix application with retry loop (PV2-4.3: uses runRetryLoop())
 * - QA review via content profile (QN-1 through QN-5)
 * - PR creation or escalation with handoff
 *
 * For real GitHub Actions runs, the approval gate would be implemented via
 * session pause/resume with the sdk-content-resume event type.
 * For local/test runs, approval is simulated (approve all findings).
 */
export declare function runContentE2E(input: ContentE2EInput, simulatedApproval?: ApprovalResponse): Promise<ContentE2EResult>;
/**
 * Resume a paused content E2E workflow from awaiting_approval state.
 *
 * This is the Option 2 architecture: a SEPARATE entry point that loads
 * existing workflow state and calls the shared helpers.
 *
 * PV2-4.3: Uses runContentRetryLoop() instead of the old runFixLoop().
 *
 * Flow:
 *   1. Load workflow state by workflowId or issue_number
 *   2. Validate state is awaiting_approval
 *   3. processApproval() -> approved/rejected findings
 *   4. If reject: update state, clean up session, done
 *   5. If approve: runContentRetryLoop() -> finalizeWorkflow()
 *   6. Clean up session
 *
 * @param workflowId - Direct workflow ID (used when known)
 * @param approval - Approval response (approve/reject)
 * @param options - Override paths for game repo, corrections log, etc.
 */
export declare function resumeContentE2E(workflowId: string, approval: ApprovalResponse, options?: {
    gameRepoPath?: string;
    correctionsLogPath?: string;
    dryRun?: boolean;
    branch?: string;
    baseBranch?: string;
}): Promise<ContentE2EResult>;
