/**
 * Story 2.3: Content End-to-End Orchestration
 *
 * Full content pipeline: verification -> approval gate -> fix -> re-verification -> PR
 *
 * State machine:
 *   verifying -> awaiting_approval -> fixing -> re_verifying -> complete | escalated
 *
 * Orchestration loop:
 *   1. Run verifier (content-verify.ts) -> get findings
 *   2. Save state as awaiting_approval with findings, pause session
 *   3. On resume (with approval): run fixer on approved findings
 *   4. Run verifier again (re-verify the fixed file)
 *   5. If re-verify passes -> create PR via `gh pr create` -> state complete
 *   6. If re-verify fails AND fix_attempts < MAX_FIX_ATTEMPTS -> retry fix with feedback
 *   7. If re-verify fails AND fix_attempts >= MAX_FIX_ATTEMPTS -> state escalated, no PR
 *
 * FR39: No auto-merge -- PR is created for human review only.
 *
 * Exit codes:
 * - 0: Success (workflow completed -- either PR created or escalated)
 * - 1: Failure (could not run pipeline)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { MODELS, LIMITS, PATHS, type WorkflowStatus } from "../config.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
  type WorkflowState,
  type WorkflowFinding,
} from "../lib/state.js";
import {
  saveSession,
  getSession,
  completeSession,
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
// Helpers
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
  filePath: string,
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
// Main E2E Orchestration
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

  console.log("=== Story 2.3: Content E2E Orchestration ===");
  console.log("Category: " + category);
  console.log("File: " + input.filePath);
  console.log("Corrections log: " + input.correctionsLogPath);
  console.log("Repo root: " + repoRoot);
  console.log("Dry run: " + dryRun);
  console.log("Branch: " + branch);
  console.log("Max fix attempts: " + LIMITS.MAX_FIX_ATTEMPTS);
  console.log("");

  // Resolve file path
  const resolvedFilePath = path.isAbsolute(input.filePath)
    ? input.filePath
    : path.resolve(repoRoot, input.filePath);

  const resolvedCorrectionsLog = path.isAbsolute(input.correctionsLogPath)
    ? input.correctionsLogPath
    : path.resolve(repoRoot, input.correctionsLogPath);

  // ---------------------------------------------------
  // Step 1: Create workflow state
  // ---------------------------------------------------
  const state = await createWorkflowState(
    "content_verification",
    "manual",
    category,
  );
  console.log("[content-e2e] Workflow created: " + state.workflow_id);
  console.log("[content-e2e] Status: " + state.status);
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

  // In a real pipeline, we would save the session and pause here.
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
      "[content-e2e] Resume with: orchestrator resume '{\"workflowId\": \"" +
        state.workflow_id +
        "\", \"action\": \"approve\"}'",
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
  // Step 4: Process approval
  // ---------------------------------------------------
  console.log("");
  console.log("--- Step 2: Approval Processing ---");

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

  // Approve all or specific findings
  let approvedFindings: WorkflowFinding[];
  let rejectedFindings: WorkflowFinding[];

  if (
    simulatedApproval.approvedIndices &&
    simulatedApproval.approvedIndices.length > 0
  ) {
    const approvedSet = new Set(simulatedApproval.approvedIndices);
    approvedFindings = findings.filter((_, i) => approvedSet.has(i));
    rejectedFindings = findings.filter((_, i) => !approvedSet.has(i));
  } else {
    // Approve all
    approvedFindings = findings;
    rejectedFindings = [];
  }

  console.log("[content-e2e] Approved: " + approvedFindings.length + " findings");
  if (rejectedFindings.length > 0) {
    console.log("[content-e2e] Rejected: " + rejectedFindings.length + " findings");
  }

  await updateWorkflowState(state.workflow_id, {
    approved_findings: approvedFindings,
    rejected_findings: rejectedFindings,
  });

  // ---------------------------------------------------
  // Step 5: Fix + Re-verify loop
  // ---------------------------------------------------
  let fixAttempts = 0;
  let lastFixOutput: ContentFixOutput | null = null;
  let lastReVerifyResult: ContentVerificationResult | null = null;
  let reVerifyPassed = false;
  let feedbackFromPreviousAttempt = "";

  while (fixAttempts < LIMITS.MAX_FIX_ATTEMPTS) {
    fixAttempts++;
    console.log("");
    console.log(
      "--- Step 3." +
        fixAttempts +
        ": Fix Attempt " +
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
      resolvedFilePath,
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
        correctionsLogPath: resolvedCorrectionsLog,
        repoRoot,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[content-e2e] Fixer failed: " + errMsg);
      await updateWorkflowState(state.workflow_id, {
        status: "escalated",
        error: "Fixer failed on attempt " + fixAttempts + ": " + errMsg,
      });
      return {
        status: "escalated",
        workflowId: state.workflow_id,
        totalFindings: findings.length,
        approvedFindings: approvedFindings.length,
        fixAttempts,
        prNumber: null,
        prUrl: null,
        error: "Fixer failed: " + errMsg,
      };
    }
    console.log("");

    // ---------------------------------------------------
    // Step 6: Re-verification
    // ---------------------------------------------------
    console.log(
      "--- Step 4." + fixAttempts + ": Re-Verification (attempt " + fixAttempts + ") ---",
    );
    await updateWorkflowState(state.workflow_id, {
      status: "re_verifying",
    });
    console.log("[content-e2e] Status: re_verifying");

    try {
      lastReVerifyResult = await runContentVerify({
        filePath: resolvedFilePath,
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

  // ---------------------------------------------------
  // Step 7: PR creation or escalation
  // ---------------------------------------------------
  console.log("");

  if (reVerifyPassed) {
    console.log("--- Step 5: PR Creation ---");

    // Build PR description with finding summary, fix applied, re-verify result
    const findingSummary = approvedFindings
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

    const fixSummary = lastFixOutput
      ? lastFixOutput.results
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

    const reVerifySummary = lastReVerifyResult
      ? "All " +
        approvedFindings.length +
        " approved findings resolved. " +
        lastReVerifyResult.summary.total_passed +
        "/" +
        lastReVerifyResult.total_events +
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
      category +
      " -- " +
      approvedFindings.length +
      " finding(s) fixed";

    let prNumber: number | null = null;
    let prUrl: string | null = null;

    try {
      const prResult = createPullRequest({
        title: prTitle,
        body: prBody,
        branch,
        baseBranch,
        dryRun,
        cwd: repoRoot,
      });

      if (prResult) {
        prNumber = prResult.prNumber;
        prUrl = prResult.prUrl;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[content-e2e] PR creation failed: " + errMsg);
      // Don't escalate -- the fix is applied, PR just failed
      await updateWorkflowState(state.workflow_id, {
        status: "complete",
        fix_attempts: fixAttempts,
        pr_number: null,
        error: "PR creation failed: " + errMsg,
      });
      return {
        status: "complete",
        workflowId: state.workflow_id,
        totalFindings: findings.length,
        approvedFindings: approvedFindings.length,
        fixAttempts,
        prNumber: null,
        prUrl: null,
        error: "PR creation failed: " + errMsg,
      };
    }

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      fix_attempts: fixAttempts,
      pr_number: prNumber,
    });

    console.log("[content-e2e] Status: complete");
    console.log("[content-e2e] Workflow " + state.workflow_id + " finished successfully");

    return {
      status: "complete",
      workflowId: state.workflow_id,
      totalFindings: findings.length,
      approvedFindings: approvedFindings.length,
      fixAttempts,
      prNumber,
      prUrl,
      error: null,
    };
  } else {
    // Escalation -- max fix attempts reached
    console.log("--- Step 5: Escalation ---");
    console.log(
      "[content-e2e] Max fix attempts (" +
        LIMITS.MAX_FIX_ATTEMPTS +
        ") reached -- escalating to owner",
    );

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      fix_attempts: fixAttempts,
      error:
        "Re-verification failed after " +
        fixAttempts +
        " fix attempts. Manual intervention required.",
    });

    console.log("[content-e2e] Status: escalated");
    console.log("[content-e2e] NO PR created (FR39 -- failed fixes do not get PRs)");

    return {
      status: "escalated",
      workflowId: state.workflow_id,
      totalFindings: findings.length,
      approvedFindings: approvedFindings.length,
      fixAttempts,
      prNumber: null,
      prUrl: null,
      error:
        "Re-verification failed after " +
        fixAttempts +
        " fix attempts. Manual intervention required.",
    };
  }
}
