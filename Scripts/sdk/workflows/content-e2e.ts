/**
 * Story 2.3 + 2.4b: Content End-to-End Orchestration
 *
 * Full content pipeline: verification -> approval gate -> fix -> re-verification -> PR
 *
 * State machine:
 *   verifying -> awaiting_approval -> fixing -> re_verifying -> complete | escalated
 *
 * Story 2.4b refactor:
 *   - Shared helpers extracted: processApproval(), runFixLoop(), finalizeWorkflow()
 *   - resumeContentE2E() added as separate entry point (Option 2 architecture)
 *   - ContentE2EInput extended with issue_number (AC9)
 *   - issue_number passed through to createWorkflowState() (AC3)
 *
 * Orchestration loop (runContentE2E):
 *   1. Run verifier (content-verify.ts) -> get findings
 *   2. Save state as awaiting_approval with findings, pause session
 *   3. On resume (with approval): run fixer on approved findings
 *   4. Run verifier again (re-verify the fixed file)
 *   5. If re-verify passes -> create PR via `gh pr create` -> state complete
 *   6. If re-verify fails AND fix_attempts < MAX_FIX_ATTEMPTS -> retry fix with feedback
 *   7. If re-verify fails AND fix_attempts >= MAX_FIX_ATTEMPTS -> state escalated, no PR
 *
 * Resume flow (resumeContentE2E):
 *   1. Load paused workflow state
 *   2. processApproval() -> split approved/rejected
 *   3. runFixLoop() -> fix + re-verify with retry
 *   4. finalizeWorkflow() -> PR or escalation
 *
 * FR39: No auto-merge -- PR is created for human review only.
 *
 * Exit codes:
 * - 0: Success (workflow completed -- either PR created or escalated)
 * - 1: Failure (could not run pipeline)
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { LIMITS, PATHS, type WorkflowStatus } from "../config.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
  findWorkflowByIssue,
  type WorkflowState,
  type WorkflowFinding,
} from "../lib/state.js";
import {
  saveSession,
  removeSession,
} from "../lib/session.js";
import {
  runContentVerify,
  type ContentVerificationResult,
} from "./content-verify.js";
import {
  runContentFix,
  type ContentFinding,
  type ContentFixOutput,
} from "./content-fix.js";
import { isKnownCategory } from "../lib/categories.js";
import { ROUTING } from "../config.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// Internal Helpers (not exported -- used by both run and resume)
// ------------------------------------------------------------------

/** Resolve repo root from this file's location */
function resolveRepoRoot(override?: string): string {
  if (override) return override;
  if (process.env.GITHUB_WORKSPACE) return process.env.GITHUB_WORKSPACE;
  if (process.env.SDK_REPO_ROOT) return process.env.SDK_REPO_ROOT;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..", "..", "..", "..");
}

/** Convert ContentVerificationResult failures to WorkflowFinding[] */
function verificationToFindings(
  result: ContentVerificationResult,
  _filePath: string,
): WorkflowFinding[] {
  return result.summary.all_failures.map((f) => ({
    event_id: f.title.toLowerCase().replace(/\s+/g, "_"),
    event_title: f.title,
    gates_failed: f.codes,
    details: f.details,
    severity: f.codes.some((c) => c.startsWith("F") || c.startsWith("A"))
      ? "high"
      : "medium",
  }));
}

/** Convert WorkflowFinding[] to ContentFinding[] for the fixer */
function workflowToContentFindings(
  findings: WorkflowFinding[],
  filePath: string,
): ContentFinding[] {
  return findings.map((f) => ({
    title: f.event_title,
    codes: f.gates_failed,
    details: f.details,
    sourceFile: filePath,
  }));
}

/** Build PR description from the E2E run data */
function buildPrDescription(
  findingSummary: string,
  fixSummary: string,
  reVerifySummary: string,
  workflowId: string,
): string {
  return [
    "## Content Pipeline Fix",
    "",
    `**Workflow:** \`${workflowId}\``,
    "",
    "### Findings (from content verifier)",
    findingSummary,
    "",
    "### Fix Applied (by content fixer)",
    fixSummary,
    "",
    "### Re-Verification Result",
    reVerifySummary,
    "",
    "---",
    "*Generated by SDK content E2E pipeline (Story 2.3). Do NOT auto-merge (FR39).*",
  ].join("\n");
}

/** Create a PR using gh CLI. Returns { prNumber, prUrl } or null on dry-run. */
function createPullRequest(opts: {
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  dryRun: boolean;
  cwd: string;
}): { prNumber: number; prUrl: string } | null {
  if (opts.dryRun) {
    console.log("[content-e2e] DRY RUN: Would create PR:");
    console.log("  Title: " + opts.title);
    console.log("  Branch: " + opts.branch + " -> " + opts.baseBranch);
    console.log("  Body length: " + opts.body.length + " chars");
    return null;
  }

  try {
    // Stage, commit, and push
    execSync("git add -A", { cwd: opts.cwd, encoding: "utf-8" });
    execSync(
      'git commit -m "fix(content): automated content fix from SDK pipeline"',
      { cwd: opts.cwd, encoding: "utf-8" },
    );
    execSync(`git push -u origin ${opts.branch}`, {
      cwd: opts.cwd,
      encoding: "utf-8",
    });

    // Create PR (FR39: no auto-merge)
    const prOutput = execSync(
      `gh pr create --title ${JSON.stringify(opts.title)} --body ${JSON.stringify(opts.body)} --base ${opts.baseBranch} --head ${opts.branch}`,
      { cwd: opts.cwd, encoding: "utf-8" },
    ).trim();

    // gh pr create outputs the PR URL
    const prUrl = prOutput;
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;

    console.log("[content-e2e] PR created: " + prUrl);
    return { prNumber, prUrl };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[content-e2e] Failed to create PR: " + errMsg);
    throw err;
  }
}

// ------------------------------------------------------------------
// Exported Shared Helpers (AC1)
// ------------------------------------------------------------------

/**
 * Process an approval response against workflow findings.
 *
 * Separates findings into approved and rejected sets based on the approval.
 * If approval action is "reject", all findings are rejected.
 * If approval action is "approve" with no specific indices, all are approved.
 *
 * Extracted from runContentE2E() lines 377-426 for reuse by resumeContentE2E().
 */
export function processApproval(
  state: WorkflowState,
  approval: ApprovalResponse,
): { approved: WorkflowFinding[]; rejected: WorkflowFinding[] } {
  const findings = state.findings;

  if (approval.action === "reject") {
    return { approved: [], rejected: findings };
  }

  // Approve all or specific findings
  if (
    approval.approvedIndices &&
    approval.approvedIndices.length > 0
  ) {
    const approvedSet = new Set(approval.approvedIndices);
    return {
      approved: findings.filter((_, i) => approvedSet.has(i)),
      rejected: findings.filter((_, i) => !approvedSet.has(i)),
    };
  }

  // Approve all
  return { approved: findings, rejected: [] };
}

/**
 * Run the fix -> re-verify loop with retry (max LIMITS.MAX_FIX_ATTEMPTS).
 *
 * On each iteration:
 *   1. Updates state to "fixing"
 *   2. Runs content fixer on approved findings
 *   3. Updates state to "re_verifying"
 *   4. Re-runs verifier to check if findings are resolved
 *   5. If failures remain, builds feedback for next attempt
 *
 * Extracted from runContentE2E() lines 437-563 for reuse by resumeContentE2E().
 */
export async function runFixLoop(
  state: WorkflowState,
  category: string,
  gameRepoPath: string,
  options: { dryRun: boolean; filePath: string; correctionsLogPath: string },
): Promise<{
  passed: boolean;
  attempts: number;
  lastFixOutput: ContentFixOutput | null;
  lastReVerifyResult: ContentVerificationResult | null;
  approvedFindings: WorkflowFinding[];
}> {
  const approvedFindings = state.approved_findings;
  let fixAttempts = state.fix_attempts;
  let lastFixOutput: ContentFixOutput | null = null;
  let lastReVerifyResult: ContentVerificationResult | null = null;
  let reVerifyPassed = false;
  let feedbackFromPreviousAttempt = "";

  while (fixAttempts < LIMITS.MAX_FIX_ATTEMPTS) {
    fixAttempts++;
    console.log("");
    console.log(
      "--- Fix Attempt " +
        fixAttempts +
        "/" +
        LIMITS.MAX_FIX_ATTEMPTS +
        " ---",
    );

    // Update state to fixing
    await updateWorkflowState(state.workflow_id, {
      status: "fixing",
      fix_attempts: fixAttempts,
    });
    console.log("[content-e2e] Status: fixing (attempt " + fixAttempts + ")");

    // Build content findings for the fixer
    const contentFindings = workflowToContentFindings(
      approvedFindings,
      options.filePath,
    );

    // Add re-verification feedback if this is a retry
    if (feedbackFromPreviousAttempt) {
      console.log("[content-e2e] Including re-verification feedback for retry");
      for (const cf of contentFindings) {
        cf.details +=
          "\n\nPREVIOUS FIX ATTEMPT FAILED RE-VERIFICATION:\n" +
          feedbackFromPreviousAttempt;
      }
    }

    // Run fixer
    try {
      lastFixOutput = await runContentFix({
        findings: contentFindings,
        correctionsLogPath: options.correctionsLogPath,
        repoRoot: gameRepoPath,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[content-e2e] Fixer failed: " + errMsg);
      await updateWorkflowState(state.workflow_id, {
        status: "escalated",
        error: "Fixer failed on attempt " + fixAttempts + ": " + errMsg,
      });
      return {
        passed: false,
        attempts: fixAttempts,
        lastFixOutput: null,
        lastReVerifyResult: null,
        approvedFindings,
      };
    }
    console.log("");

    // Re-verification
    console.log(
      "--- Re-Verification (attempt " + fixAttempts + ") ---",
    );
    await updateWorkflowState(state.workflow_id, {
      status: "re_verifying",
    });
    console.log("[content-e2e] Status: re_verifying");

    try {
      lastReVerifyResult = await runContentVerify({
        filePath: options.filePath,
        category,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[content-e2e] Re-verification failed: " + errMsg);
      feedbackFromPreviousAttempt = "Re-verification could not run: " + errMsg;
      continue;
    }
    console.log("");

    // Check if the approved findings are still present in re-verification
    const approvedTitles = new Set(
      approvedFindings.map((f) => f.event_title),
    );
    const remainingFailures = lastReVerifyResult.summary.all_failures.filter(
      (f) => approvedTitles.has(f.title),
    );

    if (remainingFailures.length === 0) {
      console.log(
        "[content-e2e] Re-verification PASSED -- all approved findings resolved",
      );
      reVerifyPassed = true;
      break;
    } else {
      console.log(
        "[content-e2e] Re-verification FAILED -- " +
          remainingFailures.length +
          " approved findings still present:",
      );
      for (const f of remainingFailures) {
        console.log(
          "  [" + f.codes.join(", ") + "] " + f.title + " -- " + f.details,
        );
      }

      // Build feedback for next attempt
      feedbackFromPreviousAttempt = remainingFailures
        .map(
          (f) =>
            "'" +
            f.title +
            "' still failing [" +
            f.codes.join(", ") +
            "]: " +
            f.details,
        )
        .join("\n");
    }
  }

  return {
    passed: reVerifyPassed,
    attempts: fixAttempts,
    lastFixOutput,
    lastReVerifyResult,
    approvedFindings,
  };
}

/**
 * Finalize a workflow: create PR if fixes passed, escalate if they failed.
 *
 * Extracted from runContentE2E() lines 570-716 for reuse by resumeContentE2E().
 */
export async function finalizeWorkflow(
  state: WorkflowState,
  gameRepoPath: string,
  options: {
    dryRun: boolean;
    category: string;
    branch: string;
    baseBranch: string;
    fixLoopResult: {
      passed: boolean;
      attempts: number;
      lastFixOutput: ContentFixOutput | null;
      lastReVerifyResult: ContentVerificationResult | null;
      approvedFindings: WorkflowFinding[];
    };
  },
): Promise<{ prNumber: number | null; prUrl: string | null; escalated: boolean }> {
  const { fixLoopResult } = options;
  console.log("");

  if (fixLoopResult.passed) {
    console.log("--- Finalize: PR Creation ---");

    // Build PR description
    const findingSummary = fixLoopResult.approvedFindings
      .map(
        (f) =>
          "- **" +
          f.event_title +
          "** [" +
          f.gates_failed.join(", ") +
          "]: " +
          f.details,
      )
      .join("\n");

    const fixSummary = fixLoopResult.lastFixOutput
      ? fixLoopResult.lastFixOutput.results
          .map(
            (r) =>
              "- **" +
              r.title +
              "** [" +
              r.codes.join(", ") +
              "]: " +
              (r.fixed ? r.action : "FAILED -- " + r.action),
          )
          .join("\n")
      : "No fix output available";

    const reVerifySummary = fixLoopResult.lastReVerifyResult
      ? "All " +
        fixLoopResult.approvedFindings.length +
        " approved findings resolved. " +
        fixLoopResult.lastReVerifyResult.summary.total_passed +
        "/" +
        fixLoopResult.lastReVerifyResult.total_events +
        " events now passing."
      : "Re-verification data not available";

    const prBody = buildPrDescription(
      findingSummary,
      fixSummary,
      reVerifySummary,
      state.workflow_id,
    );

    const prTitle =
      "fix(content): " +
      options.category +
      " -- " +
      fixLoopResult.approvedFindings.length +
      " finding(s) fixed";

    let prNumber: number | null = null;
    let prUrl: string | null = null;

    try {
      const prResult = createPullRequest({
        title: prTitle,
        body: prBody,
        branch: options.branch,
        baseBranch: options.baseBranch,
        dryRun: options.dryRun,
        cwd: gameRepoPath,
      });

      if (prResult) {
        prNumber = prResult.prNumber;
        prUrl = prResult.prUrl;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[content-e2e] PR creation failed: " + errMsg);
      await updateWorkflowState(state.workflow_id, {
        status: "complete",
        fix_attempts: fixLoopResult.attempts,
        pr_number: null,
        error: "PR creation failed: " + errMsg,
      });
      return { prNumber: null, prUrl: null, escalated: false };
    }

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      fix_attempts: fixLoopResult.attempts,
      pr_number: prNumber,
    });

    console.log("[content-e2e] Status: complete");
    console.log("[content-e2e] Workflow " + state.workflow_id + " finished successfully");

    return { prNumber, prUrl, escalated: false };
  } else {
    // Escalation -- max fix attempts reached or fixer failed
    console.log("--- Finalize: Escalation ---");
    console.log(
      "[content-e2e] Max fix attempts (" +
        LIMITS.MAX_FIX_ATTEMPTS +
        ") reached -- escalating to owner",
    );

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      fix_attempts: fixLoopResult.attempts,
      error:
        "Re-verification failed after " +
        fixLoopResult.attempts +
        " fix attempts. Manual intervention required.",
    });

    console.log("[content-e2e] Status: escalated");
    console.log("[content-e2e] NO PR created (FR39 -- failed fixes do not get PRs)");

    return { prNumber: null, prUrl: null, escalated: true };
  }
}

// ------------------------------------------------------------------
// Main E2E Orchestration (runContentE2E)
// ------------------------------------------------------------------

/**
 * Run the full content E2E pipeline.
 *
 * This function handles the complete flow:
 * - Initial verification
 * - Approval gate (simulated for local/test runs)
 * - Fix application with retry loop
 * - Re-verification
 * - PR creation or escalation
 *
 * For real GitHub Actions runs, the approval gate would be implemented via
 * session pause/resume with the sdk-content-resume event type.
 * For local/test runs, approval is simulated (approve all findings).
 */
export async function runContentE2E(
  input: ContentE2EInput,
  simulatedApproval?: ApprovalResponse,
): Promise<ContentE2EResult> {
  const category = input.category ?? "Unknown";
  const repoRoot = resolveRepoRoot(input.repoRoot);
  const dryRun = input.dryRun ?? true;
  const baseBranch = input.baseBranch ?? "main";
  const branch =
    input.branch ??
    "sdk/content-fix-" + new Date().toISOString().slice(0, 10).replace(/-/g, "");

  console.log("=== Content E2E Orchestration ===");
  console.log("Category: " + category);
  console.log("File: " + input.filePath);
  console.log("Corrections log: " + input.correctionsLogPath);
  console.log("Repo root: " + repoRoot);
  console.log("Dry run: " + dryRun);
  console.log("Branch: " + branch);
  console.log("Max fix attempts: " + LIMITS.MAX_FIX_ATTEMPTS);
  if (input.issue_number) {
    console.log("Issue: #" + input.issue_number);
  }
  console.log("");

  // ---------------------------------------------------
  // Guard: Reject unknown/unrecognized categories (AC8)
  // ---------------------------------------------------
  if (category === "unknown" || category === "Unknown" || !isKnownCategory(category)) {
    const errorMsg =
      "Cannot run content verification: category '" + category + "' is not recognized. " +
      "Triage may not have identified the affected category.";
    console.error("[content-e2e] " + errorMsg);

    // Post error comment on the issue if we have an issue number
    if (input.issue_number) {
      try {
        execSync(
          "gh issue comment " + input.issue_number +
            " --repo " + ROUTING.PRIVATE_REPO +
            " --body " + JSON.stringify("## Content Verification Failed\n\n" + errorMsg),
          { encoding: "utf-8", timeout: 30_000 },
        );
        console.log("[content-e2e] Error comment posted on issue #" + input.issue_number);
      } catch (commentErr: unknown) {
        const commentErrMsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
        console.error("[content-e2e] WARNING: Failed to post error comment: " + commentErrMsg);
      }
    }

    return {
      status: "escalated",
      workflowId: "none",
      totalFindings: 0,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: errorMsg,
    };
  }

  // Resolve file path
  const resolvedFilePath = path.isAbsolute(input.filePath)
    ? input.filePath
    : path.resolve(repoRoot, input.filePath);

  const resolvedCorrectionsLog = path.isAbsolute(input.correctionsLogPath)
    ? input.correctionsLogPath
    : path.resolve(repoRoot, input.correctionsLogPath);

  // ---------------------------------------------------
  // Step 1: Create workflow state (AC3: pass issue_number)
  // ---------------------------------------------------
  const state = await createWorkflowState(
    "content_verification",
    "manual",
    category,
    input.issue_number,
  );
  console.log("[content-e2e] Workflow created: " + state.workflow_id);
  console.log("[content-e2e] Status: " + state.status);
  if (state.issue_number) {
    console.log("[content-e2e] Linked to issue: #" + state.issue_number);
  }
  console.log("");

  // ---------------------------------------------------
  // Step 2: Run initial verification
  // ---------------------------------------------------
  console.log("--- Step 1: Initial Verification ---");
  let verifyResult: ContentVerificationResult;
  try {
    verifyResult = await runContentVerify({
      filePath: resolvedFilePath,
      category,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Verification failed: " + errMsg,
    });
    return {
      status: "escalated",
      workflowId: state.workflow_id,
      totalFindings: 0,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "Verification failed: " + errMsg,
    };
  }
  console.log("");

  // Check if there are any findings
  const findings = verificationToFindings(verifyResult, resolvedFilePath);

  if (findings.length === 0) {
    console.log("[content-e2e] No findings -- nothing to fix.");
    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      findings: [],
    });
    return {
      status: "complete",
      workflowId: state.workflow_id,
      totalFindings: 0,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: null,
    };
  }

  console.log(
    "[content-e2e] " + findings.length + " findings from verification",
  );

  // ---------------------------------------------------
  // Step 3: Save state as awaiting_approval, pause
  // ---------------------------------------------------
  await updateWorkflowState(state.workflow_id, {
    status: "awaiting_approval",
    findings,
  });
  console.log("[content-e2e] Status: awaiting_approval");

  // In a real pipeline, we save the session and pause here.
  // For simulated/test runs, we proceed immediately with the simulated approval.
  if (!simulatedApproval) {
    // Save session for later resume (real pipeline path)
    await saveSession(
      state.workflow_id,
      "sim-" + state.workflow_id,
      "fix_approved_findings",
    );
    console.log("[content-e2e] Session paused -- awaiting human approval");
    console.log(
      "[content-e2e] Resume with: orchestrator resume --issue " +
        (state.issue_number ?? "?") +
        " --action approve",
    );

    return {
      status: "awaiting_approval",
      workflowId: state.workflow_id,
      totalFindings: findings.length,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: null,
    };
  }

  // ---------------------------------------------------
  // Step 4: Process approval (using shared helper)
  // ---------------------------------------------------
  console.log("");
  console.log("--- Step 2: Approval Processing ---");

  // Load fresh state (has findings stored)
  const currentState = await loadWorkflowState(state.workflow_id);
  if (!currentState) {
    return {
      status: "escalated",
      workflowId: state.workflow_id,
      totalFindings: findings.length,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "Could not reload workflow state",
    };
  }

  const { approved, rejected } = processApproval(currentState, simulatedApproval);

  if (simulatedApproval.action === "reject") {
    console.log(
      "[content-e2e] Findings rejected: " +
        (simulatedApproval.rejectionReason ?? "no reason"),
    );
    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      rejected_findings: findings,
    });
    return {
      status: "complete",
      workflowId: state.workflow_id,
      totalFindings: findings.length,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: null,
    };
  }

  console.log("[content-e2e] Approved: " + approved.length + " findings");
  if (rejected.length > 0) {
    console.log("[content-e2e] Rejected: " + rejected.length + " findings");
  }

  await updateWorkflowState(state.workflow_id, {
    approved_findings: approved,
    rejected_findings: rejected,
  });

  // ---------------------------------------------------
  // Step 5: Fix + Re-verify loop (using shared helper)
  // ---------------------------------------------------
  const updatedState = await loadWorkflowState(state.workflow_id);
  if (!updatedState) {
    return {
      status: "escalated",
      workflowId: state.workflow_id,
      totalFindings: findings.length,
      approvedFindings: approved.length,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "Could not reload workflow state for fix loop",
    };
  }

  const fixResult = await runFixLoop(
    updatedState,
    category,
    repoRoot,
    {
      dryRun,
      filePath: resolvedFilePath,
      correctionsLogPath: resolvedCorrectionsLog,
    },
  );

  // ---------------------------------------------------
  // Step 6: PR creation or escalation (using shared helper)
  // ---------------------------------------------------
  const finalResult = await finalizeWorkflow(
    updatedState,
    repoRoot,
    {
      dryRun,
      category,
      branch,
      baseBranch,
      fixLoopResult: fixResult,
    },
  );

  return {
    status: finalResult.escalated ? "escalated" : "complete",
    workflowId: state.workflow_id,
    totalFindings: findings.length,
    approvedFindings: approved.length,
    fixAttempts: fixResult.attempts,
    prNumber: finalResult.prNumber,
    prUrl: finalResult.prUrl,
    error: finalResult.escalated
      ? "Re-verification failed after " + fixResult.attempts + " fix attempts. Manual intervention required."
      : null,
  };
}

// ------------------------------------------------------------------
// Resume E2E Orchestration (AC2)
// ------------------------------------------------------------------

/**
 * Resume a paused content E2E workflow from awaiting_approval state.
 *
 * This is the Option 2 architecture: a SEPARATE entry point that loads
 * existing workflow state and calls the shared helpers.
 *
 * Flow:
 *   1. Load workflow state by workflowId or issue_number
 *   2. Validate state is awaiting_approval
 *   3. processApproval() -> approved/rejected findings
 *   4. If reject: update state, clean up session, done
 *   5. If approve: runFixLoop() -> finalizeWorkflow()
 *   6. Clean up session
 *
 * @param workflowId - Direct workflow ID (used when known)
 * @param approval - Approval response (approve/reject)
 * @param options - Override paths for game repo, corrections log, etc.
 */
export async function resumeContentE2E(
  workflowId: string,
  approval: ApprovalResponse,
  options?: {
    gameRepoPath?: string;
    correctionsLogPath?: string;
    dryRun?: boolean;
    branch?: string;
    baseBranch?: string;
  },
): Promise<ContentE2EResult> {
  console.log("=== Content E2E Resume ===");
  console.log("Workflow: " + workflowId);
  console.log("Action: " + approval.action);
  console.log("");

  // ---------------------------------------------------
  // Step 1: Load workflow state
  // ---------------------------------------------------
  const state = await loadWorkflowState(workflowId);
  if (!state) {
    console.error("[resume] No state file found for workflow: " + workflowId);
    return {
      status: "escalated",
      workflowId,
      totalFindings: 0,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "No state file found for workflow: " + workflowId,
    };
  }

  // ---------------------------------------------------
  // Step 2: Validate state is awaiting_approval
  // ---------------------------------------------------
  if (state.status !== "awaiting_approval") {
    console.error(
      "[resume] Workflow " + workflowId + " is in status '" + state.status +
      "', expected 'awaiting_approval'",
    );
    return {
      status: state.status,
      workflowId,
      totalFindings: state.findings.length,
      approvedFindings: 0,
      fixAttempts: state.fix_attempts,
      prNumber: state.pr_number,
      prUrl: null,
      error: "Workflow is not in awaiting_approval state (current: " + state.status + ")",
    };
  }

  const category = state.category ?? "Unknown";
  const gameRepoPath = options?.gameRepoPath ?? resolveRepoRoot(PATHS.GAME_REPO);
  const dryRun = options?.dryRun ?? false;
  const baseBranch = options?.baseBranch ?? "main";
  const branch =
    options?.branch ??
    "sdk/content-fix-" + new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Resolve corrections log path
  const correctionsLogPath = options?.correctionsLogPath
    ? (path.isAbsolute(options.correctionsLogPath)
        ? options.correctionsLogPath
        : path.resolve(gameRepoPath, options.correctionsLogPath))
    : path.resolve(gameRepoPath, "Data", "corrections", "corrections-log.json");

  // Resolve the file path from state category
  // The file path is embedded in the findings (sourceFile field) if available,
  // otherwise derive from category. We use the category-to-file mapping.
  let filePath: string;
  const { categoryToFilePath } = await import("../lib/categories.js");
  const resolvedPath = categoryToFilePath(category, gameRepoPath);
  if (resolvedPath) {
    filePath = resolvedPath;
  } else {
    // Fallback: try to extract from findings
    console.error("[resume] Unknown category '" + category + "' -- cannot determine file path");
    return {
      status: "escalated",
      workflowId,
      totalFindings: state.findings.length,
      approvedFindings: 0,
      fixAttempts: state.fix_attempts,
      prNumber: null,
      prUrl: null,
      error: "Unknown category: " + category,
    };
  }

  console.log("[resume] Category: " + category);
  console.log("[resume] File: " + filePath);
  console.log("[resume] Game repo: " + gameRepoPath);
  console.log("[resume] Dry run: " + dryRun);
  console.log("");

  // ---------------------------------------------------
  // Step 3: Process approval (using shared helper)
  // ---------------------------------------------------
  console.log("--- Resume Step 1: Process Approval ---");
  const { approved, rejected } = processApproval(state, approval);

  if (approval.action === "reject") {
    console.log(
      "[resume] Findings rejected: " +
        (approval.rejectionReason ?? "no reason"),
    );
    await updateWorkflowState(workflowId, {
      status: "complete",
      rejected_findings: state.findings,
    });
    await removeSession(workflowId);
    console.log("[resume] Workflow " + workflowId + " rejected and closed");

    return {
      status: "complete",
      workflowId,
      totalFindings: state.findings.length,
      approvedFindings: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: null,
    };
  }

  console.log("[resume] Approved: " + approved.length + " findings");
  if (rejected.length > 0) {
    console.log("[resume] Rejected: " + rejected.length + " findings");
  }

  await updateWorkflowState(workflowId, {
    approved_findings: approved,
    rejected_findings: rejected,
  });

  // ---------------------------------------------------
  // Step 4: Fix + Re-verify loop (using shared helper)
  // ---------------------------------------------------
  console.log("");
  console.log("--- Resume Step 2: Fix Loop ---");

  const updatedState = await loadWorkflowState(workflowId);
  if (!updatedState) {
    return {
      status: "escalated",
      workflowId,
      totalFindings: state.findings.length,
      approvedFindings: approved.length,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "Could not reload workflow state for fix loop",
    };
  }

  const fixResult = await runFixLoop(
    updatedState,
    category,
    gameRepoPath,
    {
      dryRun,
      filePath,
      correctionsLogPath,
    },
  );

  // ---------------------------------------------------
  // Step 5: Finalize (using shared helper)
  // ---------------------------------------------------
  console.log("");
  console.log("--- Resume Step 3: Finalize ---");

  const finalResult = await finalizeWorkflow(
    updatedState,
    gameRepoPath,
    {
      dryRun,
      category,
      branch,
      baseBranch,
      fixLoopResult: fixResult,
    },
  );

  // Clean up session
  await removeSession(workflowId);

  return {
    status: finalResult.escalated ? "escalated" : "complete",
    workflowId,
    totalFindings: state.findings.length,
    approvedFindings: approved.length,
    fixAttempts: fixResult.attempts,
    prNumber: finalResult.prNumber,
    prUrl: finalResult.prUrl,
    error: finalResult.escalated
      ? "Re-verification failed after " + fixResult.attempts + " fix attempts. Manual intervention required."
      : null,
  };
}
