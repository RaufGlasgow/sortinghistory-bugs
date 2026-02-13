# TS-SDK-003: Session Pause/Resume Proof (Story 1.5)

**Author:** John (PM)
**Date:** 2026-02-13
**Story:** Epic 1, Story 1.5 — Session Pause/Resume Proof
**Repo:** `sortinghistory-bugs`
**Branch:** Create `feature/SDK-story-1.5-pause-resume` from `main` (`6aaf0cb`)
**Attempt Log:** Check `docs/sdk-attempt-log.md` before starting. Add ATT-006 PLANNED entry before implementing.

---

## 1. What This Does

Proves that an SDK session can be **paused** after a subagent produces a finding, the session ID saved to disk, and then a **second invocation** can **resume** that session with full prior context — allowing the resumed agent to know about the finding without re-running verification.

**Why it matters:** This is the CRITICAL architecture pattern for the entire automation system. The human-in-the-loop flow is: verify → pause → human approves → resume → fix. If session resumption doesn't work, every workflow loses its context at the approval gate and the fix agent has to start from scratch — which is exactly what killed the BA-008 pipeline.

---

## 2. SDK API Discovery

The Claude Agent SDK V1 `query()` function already supports session resumption via `Options`:

| Option | Type | Purpose |
|--------|------|---------|
| `persistSession` | `boolean` | Save session to disk for later resumption. Defaults to `true`. Currently set to `false` in `spawnSubagent`. |
| `resume` | `string` | Session ID to resume. Loads conversation history from the specified session. |
| `sessionId` | `string` | Use a specific session ID instead of auto-generated one. |
| `forkSession` | `boolean` | When resuming, fork to a new session ID rather than continuing the old one. |
| `continue` | `boolean` | Continue most recent conversation (mutually exclusive with `resume`). |

There is also a V2 API (`unstable_v2_createSession`, `unstable_v2_resumeSession`) but it is marked `@alpha` and `UNSTABLE`. **Use V1 `query()` with `resume` option.**

The session ID is captured from the `init` message (already implemented in `spawnSubagent` — `result.sessionId`).

---

## 3. Files to Create

| File | Purpose |
|------|---------|
| `Scripts/sdk/workflows/pause-resume-proof.ts` | Two-phase proof workflow |

## 4. Files to Modify

| File | Change |
|------|--------|
| `Scripts/sdk/orchestrator.ts` | Add `pause-resume` command case + import |
| `Scripts/sdk/lib/subagent.ts` | Add `persistSession` and `resume` params to `SubagentParams` |

---

## 5. Architecture

### The Two-Phase Pattern

This is how every production workflow (content verify → approve → fix) will work:

```
Phase 1: VERIFY
  orchestrator.ts run → spawnSubagent(persistSession: true)
    → Haiku reads event file, finds a "problem"
    → Returns finding as JSON
  orchestrator captures session_id from result
  orchestrator writes state file: status=awaiting_approval, findings=[...]
  orchestrator writes session registry: workflow_id → session_id
  orchestrator exits cleanly (process ends)

[TIME PASSES — human reviews findings in GitHub Issue]

Phase 2: RESUME
  orchestrator.ts resume → spawnSubagent(resume: sessionId)
    → Resumed session has full prior context (knows about the finding)
    → Agent receives "owner approved finding X, proceed to fix"
    → Agent can act on the finding without re-verification
  orchestrator updates state file: status=complete
  orchestrator removes session from registry
  orchestrator exits cleanly
```

### What This Proof Tests

The proof is intentionally simple — it isolates the pause/resume mechanism from real workflow complexity:

1. **Phase 1:** Subagent reads a game event file, identifies a specific event, reports it as a "finding"
2. **Phase 2:** Resumed session is asked "What was the finding you reported?" — it must know the answer WITHOUT re-reading the file

If the resumed agent can answer correctly, session context persists across process boundaries. If it can't, the architecture needs re-evaluation.

---

## 6. Implementation Details

### 6.1 `subagent.ts` Changes

Add two optional fields to `SubagentParams`:

```typescript
export interface SubagentParams {
  // ... existing fields ...
  /** Persist session to disk for later resumption (default: false) */
  persistSession?: boolean;
  /** Session ID to resume from a previous run */
  resume?: string;
}
```

Update `spawnSubagent` to pass these through to `Options`:

```typescript
const options: Options = {
  // ... existing fields ...
  persistSession: params.persistSession ?? false,  // Keep default false for non-resume workflows
  resume: params.resume,
};
```

### 6.2 `workflows/pause-resume-proof.ts` Structure

```typescript
import { MODELS, PROOF_TOOLS, PATHS } from "../config.js";
import { spawnSubagent, type SubagentResult } from "../lib/subagent.js";
import { createWorkflowState, updateWorkflowState, loadWorkflowState } from "../lib/state.js";
import { saveSession, getSession, removeSession } from "../lib/session.js";

/**
 * Phase 1: Run subagent, capture finding, save session, pause.
 * Returns the workflow_id for phase 2 to resume.
 */
export async function runPausePhase1(): Promise<string> {
  console.log("=== Story 1.5: Pause/Resume Proof — Phase 1 (PAUSE) ===");

  // 1. Create workflow state
  const state = await createWorkflowState("content_verification", "manual");

  // 2. Resolve repo root
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  // 3. Spawn subagent with persistSession: true
  const prompt = [
    `Read the file at ${PATHS.GAME_REPO}/Data/Events/USHistory.json.`,
    `Find the THIRD event in the array.`,
    `Report it as a "finding" — output JSON:`,
    `{ "finding": { "event_title": "<title>", "year": <year>, "position": 3 } }`,
  ].join("\n");

  const systemPrompt = [
    "You are a verification agent conducting a content check.",
    "Read the requested file, extract the requested event, and report it as a finding.",
    "Output ONLY the JSON result. No markdown code blocks, no explanation.",
  ].join(" ");

  const result: SubagentResult = await spawnSubagent({
    model: MODELS.VERIFIER,
    tools: [...PROOF_TOOLS],
    prompt,
    systemPrompt,
    cwd: repoRoot,
    maxTurns: 10,
    persistSession: true,  // KEY: save session for resumption
  });

  // 4. Validate phase 1 result
  if (!result.success || !result.sessionId) {
    console.error("FAIL: Phase 1 subagent did not complete or no session ID");
    process.exit(1);
  }

  // 5. Parse finding from response (same JSON extraction as proof.ts)
  // ... extract finding ...

  // 6. Save state as awaiting_approval
  await updateWorkflowState(state.workflow_id, {
    status: "awaiting_approval",
    session_id: result.sessionId,
    findings: [{ event_id: "us_3", event_title: finding.event_title, ... }],
  });

  // 7. Save session to registry
  await saveSession(state.workflow_id, result.sessionId, "fix_approved_findings");

  console.log(`PASS: Phase 1 complete. Session ${result.sessionId} saved.`);
  console.log(`Workflow ID: ${state.workflow_id}`);
  console.log(`State: awaiting_approval`);
  console.log("");
  console.log("=== PAUSED — Simulating human approval gate ===");

  return state.workflow_id;
}

/**
 * Phase 2: Resume session, verify context preserved.
 */
export async function runResumePhase2(workflowId: string): Promise<void> {
  console.log("=== Story 1.5: Pause/Resume Proof — Phase 2 (RESUME) ===");

  // 1. Load state and session
  const state = await loadWorkflowState(workflowId);
  const session = await getSession(workflowId);

  if (!state || !session) {
    console.error("FAIL: Could not load state or session for resume");
    process.exit(1);
  }

  console.log(`Resuming session: ${session.session_id}`);
  console.log(`State status: ${state.status}`);

  // 2. Resolve repo root
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  // 3. Resume session — THE CRITICAL TEST
  const resumePrompt = [
    "The owner has approved your finding.",
    "WITHOUT re-reading any files, answer: What was the event title and year of the finding you reported?",
    "Output JSON: { \"recalled_title\": \"<title>\", \"recalled_year\": <year> }",
  ].join("\n");

  const result: SubagentResult = await spawnSubagent({
    model: MODELS.VERIFIER,
    tools: [...PROOF_TOOLS],
    prompt: resumePrompt,
    cwd: repoRoot,
    maxTurns: 5,
    persistSession: false,  // No need to persist the resumed session
    resume: session.session_id,  // KEY: resume from saved session
  });

  // 4. Validate phase 2 result
  if (!result.success) {
    console.error("FAIL: Phase 2 resumed session did not complete");
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log("PASS: Resumed session completed successfully");

  // 5. Parse recalled data
  // ... extract recalled_title and recalled_year from response ...

  // 6. Compare to original finding
  const originalFinding = state.findings[0];
  if (recalled_title === originalFinding.event_title && recalled_year === originalFinding.year) {
    console.log("PASS: Resumed session correctly recalled the finding");
  } else {
    console.error("FAIL: Resumed session did NOT recall the correct finding");
    console.error(`Original: "${originalFinding.event_title}" (${originalFinding.year})`);
    console.error(`Recalled: "${recalled_title}" (${recalled_year})`);
    process.exit(1);
  }

  // 7. Update state to complete
  await updateWorkflowState(workflowId, { status: "complete" });
  await removeSession(workflowId);

  console.log("");
  console.log("=== Story 1.5 PAUSE/RESUME PROOF PASSED ===");
  console.log("Session context persists across process boundaries.");
}

/**
 * Combined proof: runs both phases sequentially (for local/CI testing).
 */
export async function runPauseResumeProof(): Promise<void> {
  const workflowId = await runPausePhase1();
  console.log("");
  await runResumePhase2(workflowId);
}
```

### 6.3 `orchestrator.ts` Change

Add case in `main()` switch:

```typescript
case "pause-resume": {
  // Story 1.5: Combined pause/resume proof
  await runPauseResumeProof();
  break;
}
case "pause": {
  // Phase 1 only (for testing phases independently)
  const workflowId = await runPausePhase1();
  console.log(workflowId);
  break;
}
case "resume-test": {
  // Phase 2 only (for testing phases independently)
  if (!payload) {
    console.error("resume-test requires a workflow ID");
    process.exit(1);
  }
  await runResumePhase2(payload);
  break;
}
```

And add imports at top:
```typescript
import { runPauseResumeProof, runPausePhase1, runResumePhase2 } from "./workflows/pause-resume-proof.js";
```

---

## 7. Risk: Session Persistence in CI

The `persistSession: true` option saves sessions to `~/.claude/projects/` on disk. In GitHub Actions:
- The home directory is `/home/runner/`
- Session files will be at `/home/runner/.claude/projects/...`
- Between Phase 1 and Phase 2 (in the same job), these files persist
- Between separate workflow runs, these files are LOST (ephemeral runner)

**For Story 1.5 proof:** Both phases run in the same job, so session files persist. This is fine for the proof.

**For production workflows (Story 2.3+):** Phase 1 and Phase 2 run in separate workflow dispatches (days apart). Session files will NOT persist between runs. Solutions:
1. Cache `~/.claude/` directory as GitHub Actions artifact between runs
2. Use the V2 API if it offers server-side session storage
3. Store session transcript in the state file and replay it

This is a **known future problem** for Story 2.3. Story 1.5 only needs to prove the mechanism works within a single job.

---

## 8. Test Execution

### Local Testing

```bash
cd Scripts/sdk
npm run build

# Combined (both phases):
node dist/orchestrator.js pause-resume

# Or separately:
WORKFLOW_ID=$(node dist/orchestrator.js pause)
node dist/orchestrator.js resume-test "$WORKFLOW_ID"
```

Requires `ANTHROPIC_API_KEY` and `SDK_GAME_REPO` or `SDK_REPO_ROOT` set.

### CI Testing

Add to the existing `sdk-content-pipeline.yml` proof job or as a separate step:

```yaml
- name: Story 1.5 — Pause/Resume Proof
  working-directory: Scripts/sdk
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: node dist/orchestrator.js pause-resume
```

---

## 9. Pass Criteria (from Epics Doc + Architecture)

### Phase 1 (Pause)
- Subagent reads event file and produces a finding
- Session ID is captured and non-null
- State file created with `status: "awaiting_approval"` and findings array
- Session registry updated with `session_id`, `status: "paused"`, `resume_step`
- Process exits cleanly (exit code 0)

### Phase 2 (Resume)
- Resumed session loads with `resume: sessionId`
- Agent correctly recalls the finding from Phase 1 WITHOUT re-reading the file
- Recalled `event_title` and `year` match the original finding
- State file updated to `status: "complete"`
- Session removed from registry
- Process exits cleanly (exit code 0)

### Combined
- Both phases pass in sequence
- Total execution < 60 seconds
- Cost < $0.10 (2 Haiku sessions)

---

## 10. Cost Estimate

- Phase 1: ~$0.03 (Haiku reads USHistory.json, same as proof)
- Phase 2: ~$0.03 (Haiku resumes, answers from context)
- Total: ~$0.06 per full proof run

---

## 11. Failure Modes & Fallbacks

| Failure | What Happens | Fallback |
|---------|-------------|----------|
| `persistSession: true` doesn't save to disk in CI | Phase 2 can't find session | Check `~/.claude/` directory exists. Try `sessionId` option to force path. |
| Resumed session doesn't have prior context | Agent re-reads file or says "I don't know" | This means the architecture pattern is broken — STOP and report to Ra'uf. Do not paper over this. |
| Session ID format changes between SDK versions | `resume` option rejects the ID | Pin SDK version in package.json. |
| Haiku forgets context even with resume (model limitation) | Recalled data doesn't match | Try Sonnet for the resumed session — if Sonnet works but Haiku doesn't, it's a model capability issue, not SDK. |

**CRITICAL: If Phase 2 fails to recall context, this is an architecture-level problem.** Do not work around it. Report findings honestly. The entire human-in-the-loop design depends on this working.

---

## 12. What NOT to Build (Deferred)

| Item | Deferred To |
|------|-------------|
| Cross-job session persistence | Story 2.3 |
| Human approval via GitHub Issue comments | Story 2.3 |
| Cloudflare Worker resume dispatch | Story 4.3 |
| Session cleanup/expiration | Future story |

---

## 13. Reference Documents

| Document | Purpose |
|----------|---------|
| `docs/architecture-automation-system.md` Section 6.3 | SDK Session API usage pattern |
| `docs/architecture-automation-system.md` Section 4.3 | Session registry schema |
| `docs/epics-automation-system.md` lines 239-268 | Story 1.5 acceptance criteria |
| `Scripts/sdk/lib/subagent.ts` | Current subagent implementation (needs `persistSession`/`resume`) |
| `Scripts/sdk/lib/session.ts` | Session registry (already implemented in Story 1.4) |
| `Scripts/sdk/lib/state.ts` | Workflow state (already implemented in Story 1.4) |
| SDK types: `Options.resume`, `Options.persistSession` | V1 API session resumption |
| SDK types: `unstable_v2_resumeSession` | V2 API (do NOT use — alpha/unstable) |
| `docs/sdk-attempt-log.md` | CHECK FIRST |
