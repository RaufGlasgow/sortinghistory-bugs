import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS, PATHS, ROUTING, type WorkflowType } from "./config.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
  findWorkflowByIssue,
} from "./lib/state.js";
import { saveSession, getSession, removeSession } from "./lib/session.js";
import { buildHooksConfig } from "./lib/hooks.js";
import { runProof } from "./workflows/proof.js";
import {
  runPauseResumeProof,
  runPausePhase1,
  runResumePhase2,
} from "./workflows/pause-resume-proof.js";
import { runTriageTest } from "./workflows/triage-test.js";
import { runRoutingTest } from "./workflows/routing-test.js";
import { runResumeByIssueTest } from "./workflows/resume-test.js";
import { decideRoute, executeRoute, type RoutingInput } from "./lib/routing.js";
import { runContentVerify, type ContentVerifyInput } from "./workflows/content-verify.js";
import { runContentVerifyTest } from "./workflows/content-verify-test.js";
import { runContentFix, type ContentFixInput } from "./workflows/content-fix.js";
import { runContentFixTest } from "./workflows/content-fix-test.js";
import {
  runContentE2E,
  resumeContentE2E,
  type ContentE2EInput,
  type ApprovalResponse,
} from "./workflows/content-e2e.js";
import { runContentE2ETest } from "./workflows/content-e2e-test.js";
import { runRealTriage } from "./workflows/triage.js";
import { runBugFix, type BugFixInput } from "./workflows/bug-fix.js";
import { categoryToFilePath, isKnownCategory, allCategoryNames } from "./lib/categories.js";

/**
 * Parse a named flag from process.argv.
 * Supports: `--flag value` syntax.
 * Returns the value as a string, or null if not found.
 */
function parseFlag(flagName: string): string | null {
  const args = process.argv;
  for (let i = 3; i < args.length; i++) {
    if (args[i] === "--" + flagName && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return null;
}

/**
 * Check for the presence of a boolean flag (e.g., --no-dry-run).
 * Returns true if the flag is present.
 */
function hasFlag(flagName: string): boolean {
  return process.argv.includes("--" + flagName, 3);
}

/**
 * Parse and validate --issue flag as a positive integer (AC7, AC8, AC12).
 * Exits with error if invalid.
 */
function parseIssueFlag(): number {
  const issueStr = parseFlag("issue");
  if (!issueStr) {
    console.error("Command requires --issue <number> flag");
    console.error("Usage: orchestrator.ts <command> --issue 42");
    process.exit(1);
  }

  // AC8/AC13: Validate as numeric to prevent injection
  if (!/^\d+$/.test(issueStr)) {
    console.error("Invalid --issue value: \"" + issueStr + "\". Must be a positive integer.");
    process.exit(1);
  }

  const issueNumber = parseInt(issueStr, 10);
  if (issueNumber <= 0 || !Number.isFinite(issueNumber)) {
    console.error("Invalid --issue value: " + issueNumber + ". Must be a positive integer.");
    process.exit(1);
  }

  return issueNumber;
}

/**
 * Parse and validate --action flag for resume command (AC12).
 * Must be "approve" or "reject".
 */
function parseActionFlag(): "approve" | "reject" {
  const actionStr = parseFlag("action");
  if (!actionStr) {
    console.error("resume requires --action <approve|reject> flag");
    console.error("Usage: orchestrator.ts resume --issue 42 --action approve");
    process.exit(1);
  }

  if (actionStr !== "approve" && actionStr !== "reject") {
    console.error("Invalid --action value: \"" + actionStr + "\". Must be 'approve' or 'reject'.");
    process.exit(1);
  }

  return actionStr;
}

/**
 * Parse and validate --category flag for content-e2e command.
 * Must be a known category name.
 */
function parseCategoryFlag(): string {
  const category = parseFlag("category");
  if (!category) {
    console.error("content-e2e requires --category <name> flag");
    console.error("Usage: orchestrator.ts content-e2e --category \"US History\" --issue 42 --no-dry-run");
    process.exit(1);
  }

  if (!isKnownCategory(category)) {
    console.error("Unknown category: \"" + category + "\"");
    console.error("Valid categories: " + allCategoryNames().join(", "));
    process.exit(1);
  }

  return category;
}

/** Parameters for starting a new workflow */
interface WorkflowParams {
  type: WorkflowType;
  category?: string;
  trigger: "scheduled" | "dispatch" | "manual";
}

/** Parameters for resuming after human approval/rejection */
interface ResumeParams {
  workflowId?: string;
  issueNumber?: number;
  action: "approve" | "reject";
  approvedItems?: string[];
  rejectionReason?: string;
}

/** Start a new workflow. Creates state file, spawns initial subagent. */
async function runWorkflow(params: WorkflowParams): Promise<void> {
  const state = await createWorkflowState(params.type, params.trigger, params.category);
  console.log(`[orchestrator] Created workflow ${state.workflow_id} (${params.type})`);

  // Hooks config applies to all subagent sessions
  const _hooks = buildHooksConfig();

  // Workflow-specific logic implemented in later stories:
  // - Story 2.1: content verification
  // - Story 3.1: translation verification
  // - Story 4.1: bug triage
  console.log(`[orchestrator] Workflow ${state.workflow_id} — not yet implemented for ${params.type}`);
}

/** Resume a paused workflow after human approval/rejection (legacy JSON path). */
async function resumeWorkflow(params: ResumeParams): Promise<void> {
  let workflowId = params.workflowId;

  // Resolve workflowId from issueNumber if not provided directly
  if (!workflowId && params.issueNumber) {
    const foundState = await findWorkflowByIssue(params.issueNumber);
    if (!foundState) {
      console.error(`[orchestrator] No workflow found for issue #${params.issueNumber}`);
      process.exit(1);
    }
    workflowId = foundState.workflow_id;
    console.log(`[orchestrator] Resolved issue #${params.issueNumber} -> ${workflowId}`);
  }

  if (!workflowId) {
    console.error("[orchestrator] resume requires workflowId or issueNumber");
    process.exit(1);
  }

  const session = await getSession(workflowId);
  if (!session) {
    console.error(`[orchestrator] No paused session found for ${workflowId}`);
    process.exit(1);
  }

  const state = await loadWorkflowState(workflowId);
  if (!state) {
    console.error(`[orchestrator] No state file found for ${workflowId}`);
    process.exit(1);
  }

  console.log(`[orchestrator] Resuming ${workflowId} with action=${params.action}`);

  if (params.action === "reject") {
    await updateWorkflowState(workflowId, {
      status: "complete",
      rejected_findings: state.findings,
    });
    await removeSession(workflowId);
    console.log(`[orchestrator] Workflow ${workflowId} rejected and closed`);
    return;
  }

  // Approval flow — Story 1.5 proves pause/resume, Story 2.3 implements full pipeline
  console.log(`[orchestrator] Resume with SDK session ${session.session_id} — not yet implemented`);
}

/** Query the status of a workflow */
async function getStatus(workflowId: string): Promise<void> {
  const state = await loadWorkflowState(workflowId);
  if (!state) {
    console.log(`[orchestrator] Workflow ${workflowId} not found`);
    return;
  }
  console.log(JSON.stringify({
    workflow_id: state.workflow_id,
    status: state.status,
    type: state.workflow_type,
    findings: state.findings.length,
    fix_attempts: state.fix_attempts,
    updated_at: state.updated_at,
  }, null, 2));
}

/**
 * Post a comment on a GitHub issue in the private repo.
 * Uses --body-file to avoid shell backtick command substitution eating markdown code spans.
 */
function postIssueComment(issueNumber: number, comment: string): void {
  const repo = ROUTING.PRIVATE_REPO;
  const tmpFile = join(tmpdir(), "gh-comment-" + issueNumber + "-" + Date.now() + ".md");
  try {
    writeFileSync(tmpFile, comment, "utf-8");
    execSync(
      "gh issue comment " + issueNumber + " --repo " + repo + " --body-file " + tmpFile,
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[orchestrator] Comment posted on " + repo + "#" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[orchestrator] WARNING: Failed to post comment: " + errMsg);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
  }
}

/** Entry point — invoked from GitHub Actions or CLI */
async function main(): Promise<void> {
  const command = process.argv[2];
  const payload = process.argv[3];

  if (!command) {
    console.error("Usage: orchestrator.ts <run|resume|status|proof|triage|triage-test|pause-resume|pause|resume-test|route|routing-test|resume-by-issue-test|content-verify|content-verify-test|content-fix|content-fix-test|content-e2e|content-e2e-test|bug-fix> <payload>");
    process.exit(1);
  }

  switch (command) {
    case "run": {
      if (!payload) {
        console.error("run requires a JSON payload: {type, category?, trigger}");
        process.exit(1);
      }
      const params = JSON.parse(payload) as WorkflowParams;
      await runWorkflow(params);
      break;
    }
    case "resume": {
      // Story 2.4b (AC4, AC12): Flag-based resume command
      // Usage: orchestrator.ts resume --issue <number> --action <approve|reject>
      // Also supports legacy JSON payload for backward compatibility
      if (hasFlag("issue") || hasFlag("action")) {
        // Flag-based path (AC12)
        const issueNumber = parseIssueFlag();
        const action = parseActionFlag();

        console.log("[orchestrator] Resume via flags: issue=#" + issueNumber + " action=" + action);

        // Look up the workflow by issue number (AC14)
        const foundState = await findWorkflowByIssue(issueNumber);
        if (!foundState) {
          console.error("[orchestrator] No paused workflow found for issue #" + issueNumber);

          // AC14: Post comment on issue about missing workflow
          postIssueComment(
            issueNumber,
            "## Resume Failed\n\n" +
              "No paused workflow found for this issue. " +
              "It may have already been completed or was never started.",
          );

          process.exit(1);
        }

        // Call resumeContentE2E (AC2, AC4)
        const result = await resumeContentE2E(
          foundState.workflow_id,
          { action },
          { dryRun: false },  // AC8: explicitly false in CI path
        );

        console.log("[orchestrator] Resume result: " + result.status);
        if (result.error) {
          console.error("[orchestrator] Error: " + result.error);
        }
        if (result.prNumber) {
          console.log("[orchestrator] PR: #" + result.prNumber);
        }

        // Post result comment on the issue
        if (result.status === "complete" && result.prNumber) {
          postIssueComment(
            issueNumber,
            "## Content Fix Complete\n\n" +
              "PR #" + result.prNumber + " created with " +
              result.approvedFindings + " finding(s) fixed.\n\n" +
              "**Workflow:** `" + result.workflowId + "`",
          );
        } else if (result.status === "escalated") {
          postIssueComment(
            issueNumber,
            "## Content Fix Escalated\n\n" +
              "The content fix could not be completed automatically.\n\n" +
              "**Error:** " + (result.error ?? "Unknown") + "\n" +
              "**Workflow:** `" + result.workflowId + "`\n\n" +
              "Manual intervention is required.",
          );
        } else if (result.status === "complete" && action === "reject") {
          postIssueComment(
            issueNumber,
            "## Findings Rejected\n\n" +
              "All findings have been rejected. Workflow closed.\n\n" +
              "**Workflow:** `" + result.workflowId + "`",
          );
        }

        break;
      }

      // Legacy JSON payload path
      if (!payload) {
        console.error("resume requires --issue and --action flags, or a JSON payload");
        console.error("Usage: orchestrator.ts resume --issue 42 --action approve");
        process.exit(1);
      }
      const params = JSON.parse(payload) as ResumeParams;
      await resumeWorkflow(params);
      break;
    }
    case "status": {
      if (!payload) {
        console.error("status requires a workflow ID");
        process.exit(1);
      }
      await getStatus(payload);
      break;
    }
    case "proof": {
      // Story 1.3: Haiku read-only proof — spawns a subagent to read a game event file
      await runProof();
      break;
    }
    case "pause-resume": {
      // Story 1.5: Combined pause/resume proof (both phases sequentially)
      await runPauseResumeProof();
      break;
    }
    case "pause": {
      // Story 1.5: Phase 1 only (pause — for testing phases independently)
      const workflowId = await runPausePhase1();
      console.log(workflowId);
      break;
    }
    case "resume-test": {
      // Story 1.5: Phase 2 only (resume — for testing phases independently)
      if (!payload) {
        console.error("resume-test requires a workflow ID as the second argument");
        process.exit(1);
      }
      await runResumePhase2(payload);
      break;
    }
    case "triage-test": {
      // Story 4.1: Run all 7 triage fixtures and validate classification + severity
      await runTriageTest();
      break;
    }
    case "route": {
      // Story 4.2: Route a triage result — expects JSON payload with RoutingInput fields
      if (!payload) {
        console.error("route requires a JSON payload: {classification, severity, confidence, extracted_context, issue_number, existing_labels?}");
        process.exit(1);
      }
      const routingInput = JSON.parse(payload) as RoutingInput;
      const action = decideRoute(routingInput);
      const dryRun = process.env.DRY_RUN === "true";
      await executeRoute(action, dryRun);
      break;
    }
    case "routing-test": {
      // Story 4.2: Run all 9 routing fixtures — pure logic test, $0.00 cost
      await runRoutingTest();
      break;
    }
    case "resume-by-issue-test": {
      // Story 4.3: Resume-by-issue lookup test — pure logic, $0.00 cost
      await runResumeByIssueTest();
      break;
    }
    case "content-verify": {
      // Story 2.1: Content verifier — runs automated + AI gates on a category file
      if (!payload) {
        console.error("content-verify requires a JSON payload: {filePath, category?}");
        process.exit(1);
      }
      const cvInput = JSON.parse(payload) as ContentVerifyInput;
      await runContentVerify(cvInput);
      break;
    }
    case "content-verify-test": {
      // Story 2.1: Content verifier test — runs fixtures and validates error detection
      await runContentVerifyTest();
      break;
    }
    case "content-fix": {
      // Story 2.2: Content fixer — applies fixes to events based on verifier findings
      if (!payload) {
        console.error("content-fix requires a JSON payload: {findings, correctionsLogPath, repoRoot?}");
        process.exit(1);
      }
      const cfInput = JSON.parse(payload) as ContentFixInput;
      await runContentFix(cfInput);
      break;
    }
    case "content-fix-test": {
      // Story 2.2: Content fixer test — fixes 3 findings, re-verifies, validates logs
      await runContentFixTest();
      break;
    }
    case "content-e2e": {
      // Story 2.3 + 2.4b: Content E2E orchestration
      // Supports both flag-based (CI) and JSON payload (legacy/test) modes
      if (hasFlag("category") || hasFlag("issue") || hasFlag("no-dry-run")) {
        // Flag-based path for CI (Story 2.4b AC5)
        const category = parseCategoryFlag();
        const issueNumber = parseIssueFlag();
        const noDryRun = hasFlag("no-dry-run");

        // Resolve file path from category
        const gameRepoPath = PATHS.GAME_REPO;
        const filePath = categoryToFilePath(category, gameRepoPath);
        if (!filePath) {
          console.error("Could not resolve file path for category: " + category);
          process.exit(1);
        }

        const correctionsLogPath = gameRepoPath + "/Data/corrections/corrections-log.json";

        const e2eInput: ContentE2EInput = {
          filePath,
          category,
          correctionsLogPath,
          repoRoot: gameRepoPath,
          dryRun: !noDryRun,  // AC8: --no-dry-run explicitly sets dryRun: false
          issue_number: issueNumber,  // AC9: pass issue_number
        };

        const result = await runContentE2E(e2eInput);

        // Post findings summary on the issue if we paused
        if (result.status === "awaiting_approval") {
          const findingsText = result.totalFindings + " finding(s) detected.";
          postIssueComment(
            issueNumber,
            "## Content Verification Complete\n\n" +
              findingsText + "\n\n" +
              "**Workflow:** `" + result.workflowId + "`\n\n" +
              "Comment `approve` to fix, or `reject` to dismiss.",
          );
        }

        break;
      }

      // Legacy JSON payload path
      if (!payload) {
        console.error("content-e2e requires flags (--category, --issue, --no-dry-run) or a JSON payload");
        process.exit(1);
      }
      const e2eInput = JSON.parse(payload) as ContentE2EInput & { approval?: ApprovalResponse };
      const e2eApproval = e2eInput.approval;
      await runContentE2E(e2eInput, e2eApproval);
      break;
    }
    case "content-e2e-test": {
      // Story 2.3: Content E2E test — happy path + escalation tests
      await runContentE2ETest();
      break;
    }
    case "triage": {
      // Story 2.4a: Real triage command — fetches issue from private repo, classifies, routes
      const issueNumber = parseIssueFlag();
      await runRealTriage({ issueNumber });
      break;
    }
    case "bug-fix": {
      // Story SDK-BF.1: Bug fix subagent — spawns Opus 4.6 to fix a bug
      // Usage: orchestrator.ts bug-fix --issue <NUM> [--game-repo <path>] [--dry-run]
      const issueNumber = parseIssueFlag();
      const gameRepo = parseFlag("game-repo") ?? PATHS.GAME_REPO;
      const isDryRun = hasFlag("dry-run");

      console.log("[orchestrator] Bug fix: issue=#" + issueNumber + " game-repo=" + gameRepo + " dry-run=" + isDryRun);

      const bugFixResult = await runBugFix({
        issueNumber,
        gameRepoPath: gameRepo,
        dryRun: isDryRun,
      });

      console.log("[orchestrator] Bug fix result: " + (bugFixResult.success ? "success" : "failed"));
      if (bugFixResult.error) {
        console.error("[orchestrator] Error: " + bugFixResult.error);
      }
      if (bugFixResult.summary) {
        console.log("[orchestrator] Files modified: " + bugFixResult.summary.files_modified.length);
        console.log("[orchestrator] Compilation: " + bugFixResult.summary.compilation_result);
        console.log("[orchestrator] Confidence: " + bugFixResult.summary.confidence);
      }

      // Post result comment on the issue
      if (bugFixResult.success && bugFixResult.summary) {
        postIssueComment(
          issueNumber,
          "## Bug Fix Applied\n\n" +
            "**Summary:** " + bugFixResult.summary.fix_summary + "\n" +
            "**Files modified:** " + bugFixResult.summary.files_modified.length + "\n" +
            "**Compilation:** " + bugFixResult.summary.compilation_result + "\n" +
            "**Confidence:** " + bugFixResult.summary.confidence + "\n\n" +
            "**Workflow:** `" + bugFixResult.workflowId + "`",
        );
      } else if (!bugFixResult.success) {
        postIssueComment(
          issueNumber,
          "## Bug Fix Failed\n\n" +
            "The bug fix subagent could not resolve this issue automatically.\n\n" +
            "**Error:** " + (bugFixResult.error ?? "Unknown") + "\n" +
            "**Workflow:** `" + bugFixResult.workflowId + "`\n\n" +
            "Manual intervention is required.",
        );
      }

      break;
    }
    default:
      console.error(`Unknown command: ${command}. Use: run, resume, status, proof, triage, triage-test, pause-resume, pause, resume-test, route, routing-test, resume-by-issue-test, content-verify, content-verify-test, content-fix, content-fix-test, content-e2e, content-e2e-test, bug-fix`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[orchestrator] Fatal error:", err);
  process.exit(1);
});
