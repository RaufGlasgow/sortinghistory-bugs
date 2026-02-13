import { MODELS, PATHS, type WorkflowType } from "./config.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
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

/** Parameters for starting a new workflow */
interface WorkflowParams {
  type: WorkflowType;
  category?: string;
  trigger: "scheduled" | "dispatch" | "manual";
}

/** Parameters for resuming after human approval/rejection */
interface ResumeParams {
  workflowId: string;
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

/** Resume a paused workflow after human approval/rejection. */
async function resumeWorkflow(params: ResumeParams): Promise<void> {
  const session = await getSession(params.workflowId);
  if (!session) {
    console.error(`[orchestrator] No paused session found for ${params.workflowId}`);
    process.exit(1);
  }

  const state = await loadWorkflowState(params.workflowId);
  if (!state) {
    console.error(`[orchestrator] No state file found for ${params.workflowId}`);
    process.exit(1);
  }

  console.log(`[orchestrator] Resuming ${params.workflowId} with action=${params.action}`);

  if (params.action === "reject") {
    await updateWorkflowState(params.workflowId, {
      status: "complete",
      rejected_findings: state.findings,
    });
    await removeSession(params.workflowId);
    console.log(`[orchestrator] Workflow ${params.workflowId} rejected and closed`);
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

/** Entry point — invoked from GitHub Actions or CLI */
async function main(): Promise<void> {
  const command = process.argv[2];
  const payload = process.argv[3];

  if (!command) {
    console.error("Usage: orchestrator.ts <run|resume|status|proof|triage-test|pause-resume|pause|resume-test> <payload>");
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
      if (!payload) {
        console.error("resume requires a JSON payload: {workflowId, action, approvedItems?}");
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
      // Story 4.1: Run all 5 triage fixtures and validate classification + severity
      await runTriageTest();
      break;
    }
    default:
      console.error(`Unknown command: ${command}. Use: run, resume, status, proof, triage-test, pause-resume, pause, resume-test`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[orchestrator] Fatal error:", err);
  process.exit(1);
});
