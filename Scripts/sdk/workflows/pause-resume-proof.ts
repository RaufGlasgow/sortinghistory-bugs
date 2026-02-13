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

import { MODELS, PROOF_TOOLS, PATHS } from "../config.js";
import { spawnSubagent, type SubagentResult } from "../lib/subagent.js";
import { extractJson } from "../lib/json-extract.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
} from "../lib/state.js";
import { saveSession, getSession, removeSession } from "../lib/session.js";

/** Shape of the Phase 1 finding response */
interface FindingResponse {
  finding: {
    event_title: string;
    year: number;
    position: number;
  };
}

/** Shape of the Phase 2 recall response */
interface RecallResponse {
  recalled_title: string;
  recalled_year: number;
}

/**
 * Phase 1: Run subagent, capture finding, save session, pause.
 * Returns the workflow_id for Phase 2 to resume.
 */
export async function runPausePhase1(): Promise<string> {
  console.log("=== Story 1.5: Pause/Resume Proof -- Phase 1 (PAUSE) ===");
  console.log("");

  // 1. Create workflow state
  const state = await createWorkflowState("content_verification", "manual");
  console.log(`[phase1] Workflow created: ${state.workflow_id}`);

  // 2. Resolve repo root (proven pattern from ATT-003)
  const repoRoot =
    process.env.GITHUB_WORKSPACE ??
    process.env.SDK_REPO_ROOT ??
    process.cwd();
  console.log(`[phase1] Repo root: ${repoRoot}`);

  // 3. Spawn subagent with persistSession: true
  const prompt = [
    `Read the file at ${PATHS.GAME_REPO}/Data/Events/USHistory.json.`,
    `Find the THIRD event in the array (index 2, position 3).`,
    `Report it as a "finding" -- output JSON:`,
    `{ "finding": { "event_title": "<title>", "year": <year>, "position": 3 } }`,
  ].join("\n");

  const systemPrompt = [
    "You are a verification agent conducting a content check.",
    "Read the requested file, extract the requested event, and report it as a finding.",
    "Output ONLY the JSON result. No markdown code blocks, no explanation.",
  ].join(" ");

  console.log(`[phase1] Spawning subagent with persistSession=true`);
  const result: SubagentResult = await spawnSubagent({
    model: MODELS.VERIFIER,
    tools: [...PROOF_TOOLS],
    prompt,
    systemPrompt,
    cwd: repoRoot,
    maxTurns: 10,
    persistSession: true,
  });

  // 4. Validate Phase 1 subagent result
  if (!result.success) {
    console.error("FAIL: Phase 1 subagent did not complete successfully");
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log("PASS: Phase 1 subagent completed successfully");

  if (!result.sessionId) {
    console.error("FAIL: No session ID returned from Phase 1 subagent");
    process.exit(1);
  }
  console.log(`PASS: Session ID captured: ${result.sessionId}`);

  // 5. Parse finding from response (defensive JSON extraction from ATT-004)
  if (!result.responseText) {
    console.error("FAIL: No response text from Phase 1 subagent");
    process.exit(1);
  }

  let finding: FindingResponse["finding"];
  try {
    const parsed = JSON.parse(extractJson(result.responseText)) as FindingResponse;
    finding = parsed.finding;
    if (!finding || typeof finding.event_title !== "string" || typeof finding.year !== "number") {
      throw new Error(`Invalid finding structure: ${JSON.stringify(parsed)}`);
    }
  } catch (err: unknown) {
    console.error("FAIL: Could not parse finding from Phase 1 response");
    console.error(`Raw response: ${result.responseText}`);
    console.error(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`PASS: Finding parsed: "${finding.event_title}" (${finding.year})`);

  // 6. Save state as awaiting_approval with findings
  await updateWorkflowState(state.workflow_id, {
    status: "awaiting_approval",
    session_id: result.sessionId,
    findings: [
      {
        event_id: `us_${finding.position}`,
        event_title: finding.event_title,
        gates_failed: ["proof_check"],
        details: `Third event in USHistory.json: "${finding.event_title}" (${finding.year})`,
        severity: "info",
      },
    ],
  });
  console.log(`PASS: State updated to awaiting_approval`);

  // 7. Save session to registry
  await saveSession(state.workflow_id, result.sessionId, "fix_approved_findings");
  console.log(`PASS: Session saved to registry`);

  // 8. Log metrics
  console.log("");
  console.log("=== Phase 1 Metrics ===");
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Input tokens: ${result.inputTokens}`);
  console.log(`Output tokens: ${result.outputTokens}`);
  console.log(`Duration: ${result.durationMs}ms`);
  console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  console.log(`Tools used: [${result.toolsUsed.join(", ")}]`);
  console.log("");
  console.log("=== PAUSED -- Simulating human approval gate ===");
  console.log(`Workflow ID: ${state.workflow_id}`);

  return state.workflow_id;
}

/**
 * Phase 2: Resume session, verify context preserved.
 */
export async function runResumePhase2(workflowId: string): Promise<void> {
  console.log("=== Story 1.5: Pause/Resume Proof -- Phase 2 (RESUME) ===");
  console.log("");

  // 1. Load state and session
  const state = await loadWorkflowState(workflowId);
  if (!state) {
    console.error(`FAIL: Could not load state for workflow ${workflowId}`);
    process.exit(1);
  }

  const session = await getSession(workflowId);
  if (!session) {
    console.error(`FAIL: Could not load session for workflow ${workflowId}`);
    process.exit(1);
  }

  console.log(`[phase2] Resuming session: ${session.session_id}`);
  console.log(`[phase2] State status: ${state.status}`);
  console.log(`[phase2] Original finding: "${state.findings[0]?.event_title}" (from state)`);

  // 2. Resolve repo root
  const repoRoot =
    process.env.GITHUB_WORKSPACE ??
    process.env.SDK_REPO_ROOT ??
    process.cwd();

  // 3. Resume session -- THE CRITICAL TEST
  const resumePrompt = [
    "The owner has approved your finding.",
    "WITHOUT re-reading any files, answer: What was the event title and year of the finding you reported?",
    'Output JSON: { "recalled_title": "<title>", "recalled_year": <year> }',
  ].join("\n");

  console.log(`[phase2] Spawning resumed subagent with resume=${session.session_id}`);
  const result: SubagentResult = await spawnSubagent({
    model: MODELS.VERIFIER,
    tools: [...PROOF_TOOLS],
    prompt: resumePrompt,
    cwd: repoRoot,
    maxTurns: 5,
    persistSession: false,
    resume: session.session_id,
  });

  // 4. Validate Phase 2 result
  if (!result.success) {
    console.error("FAIL: Phase 2 resumed session did not complete");
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log("PASS: Resumed session completed successfully");

  // 5. Parse recalled data
  if (!result.responseText) {
    console.error("FAIL: No response text from Phase 2 resumed session");
    process.exit(1);
  }

  let recalledTitle: string;
  let recalledYear: number;
  try {
    const parsed = JSON.parse(extractJson(result.responseText)) as RecallResponse;
    recalledTitle = parsed.recalled_title;
    recalledYear = parsed.recalled_year;
    if (typeof recalledTitle !== "string" || typeof recalledYear !== "number") {
      throw new Error(`Invalid recall structure: ${JSON.stringify(parsed)}`);
    }
  } catch (err: unknown) {
    console.error("FAIL: Could not parse recall from Phase 2 response");
    console.error(`Raw response: ${result.responseText}`);
    console.error(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`[phase2] Recalled: "${recalledTitle}" (${recalledYear})`);

  // 6. Compare to original finding from state
  const originalFinding = state.findings[0];
  if (!originalFinding) {
    console.error("FAIL: No original finding in state to compare against");
    process.exit(1);
  }

  // Extract the original year from the details string (format: "... (YEAR)")
  // The year is stored in the details field since WorkflowFinding doesn't have a year field
  const yearMatch = originalFinding.details.match(/\((\d{4})\)/);
  const originalYear = yearMatch ? parseInt(yearMatch[1], 10) : NaN;

  if (
    recalledTitle === originalFinding.event_title &&
    recalledYear === originalYear
  ) {
    console.log("PASS: Resumed session correctly recalled the finding");
    console.log(`  Original: "${originalFinding.event_title}" (${originalYear})`);
    console.log(`  Recalled: "${recalledTitle}" (${recalledYear})`);
  } else {
    console.error("FAIL: Resumed session did NOT recall the correct finding");
    console.error(`  Original: "${originalFinding.event_title}" (${originalYear})`);
    console.error(`  Recalled: "${recalledTitle}" (${recalledYear})`);
    process.exit(1);
  }

  // 7. Update state to complete and clean up session
  await updateWorkflowState(workflowId, { status: "complete" });
  await removeSession(workflowId);
  console.log("PASS: State updated to complete, session removed from registry");

  // 8. Log metrics
  console.log("");
  console.log("=== Phase 2 Metrics ===");
  console.log(`Session ID: ${result.sessionId}`);
  console.log(`Input tokens: ${result.inputTokens}`);
  console.log(`Output tokens: ${result.outputTokens}`);
  console.log(`Duration: ${result.durationMs}ms`);
  console.log(`Cost: $${result.costUsd.toFixed(4)}`);
  console.log(`Tools used: [${result.toolsUsed.join(", ")}]`);

  console.log("");
  console.log("=== Story 1.5 PAUSE/RESUME PROOF PASSED ===");
  console.log("Session context persists across process boundaries.");
}

/**
 * Combined proof: runs both phases sequentially (for local/CI testing).
 * Phase 1 pauses, then Phase 2 resumes immediately — simulating the
 * human-in-the-loop flow without the actual wait.
 */
export async function runPauseResumeProof(): Promise<void> {
  const workflowId = await runPausePhase1();
  console.log("");
  await runResumePhase2(workflowId);
}
