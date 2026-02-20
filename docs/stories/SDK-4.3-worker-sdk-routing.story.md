# Story 4.3: Worker SDK Routing + Resume Signal Path

**Epic:** 4 — Bug Triage & Routing
**Prerequisites:** Story 4.2 (Routing Logic) — DONE (CI green, 9/9 fixtures)
**FRs Covered:** FR6 (Acknowledge receipt), FR5 (Route to appropriate workflow — Worker leg)

---

## User Story

As a product owner,
I want the Cloudflare Worker to dispatch to SDK workflows for content and translation issues,
So that the new pipelines are triggered automatically when I approve or reject findings.

---

## Context

The Worker at `bug-webhook.emptycupmedia.workers.dev` currently dispatches ALL `/approve` commands to the `approve` event type (auto-fix pipeline), and ALL `/reject` commands on issues close the issue immediately. Story 4.2 built routing logic inside the SDK, but the Worker doesn't know about it yet. This story closes the gap: the Worker checks issue labels and dispatches both `/approve` and `/reject` to the right pipeline.

The existing `sdk-content-pipeline.yml` already listens for `sdk-resume` events (line 5). No new workflow file needed. But the SDK's state library lacks the `issue_number` field needed to map a Worker dispatch back to a paused workflow. This story adds that plumbing.

**Two repos touched:**
- **Private repo** (`Sorting-History`): Worker source at `workers/bug-webhook/src/index.ts`
- **Public repo** (`sortinghistory-bugs`): SDK state library, orchestrator, routing executor, CI

---

## Acceptance Criteria

### AC-1: Worker routes content/translation approvals to SDK
**Given** an `/approve` command on a private repo issue with `content-error` or `translation-error` label
**When** the Worker processes it
**Then** it dispatches `repository_dispatch` event `sdk-resume` to `sortinghistory-bugs` with:
```json
{
  "event_type": "sdk-resume",
  "client_payload": {
    "issue_number": <N>,
    "action": "approve",
    "labels": ["content-error", "sdk-routed"]
  }
}
```

### AC-2: Worker preserves existing behavior for code bugs
**Given** an `/approve` command on an issue WITHOUT `content-error` or `translation-error` labels
**When** the Worker processes it
**Then** it dispatches `approve` event to existing auto-fix pipeline (backward compatible, no change)

### AC-3: Worker posts SDK-specific acknowledgment comment
**Given** an `/approve` that routes to SDK pipeline
**When** the dispatch succeeds
**Then** the Worker posts a comment on the issue:
> "SDK content verification resume triggered for issue #N. The pipeline will process your approval."

(Distinct from the existing auto-fix comment so the owner knows which pipeline is running.)

### AC-4: Worker routes content/translation rejections to SDK
**Given** a `/reject` command on a private repo issue with `content-error` or `translation-error` label
**When** the Worker processes it
**Then** it dispatches `repository_dispatch` event `sdk-resume` to `sortinghistory-bugs` with:
```json
{
  "event_type": "sdk-resume",
  "client_payload": {
    "issue_number": <N>,
    "action": "reject",
    "rejection_reason": "<extracted from comment>",
    "labels": ["content-error", "sdk-routed"]
  }
}
```
**And** it does NOT close the issue (the SDK pipeline decides next steps)
**And** it does NOT add the `rejected` label (the SDK pipeline manages state)

### AC-5: Worker preserves existing /reject behavior for non-SDK issues
**Given** a `/reject` command on an issue WITHOUT `content-error` or `translation-error` labels
**When** the Worker processes it
**Then** it adds the `rejected` label, posts a comment, and closes the issue (existing behavior unchanged)

### AC-6: Worker posts SDK-specific rejection comment
**Given** a `/reject` that routes to SDK pipeline
**When** the dispatch succeeds
**Then** the Worker posts a comment on the issue:
> "SDK pipeline rejection recorded for issue #N. Reason: {reason}. The pipeline will process your feedback."

### AC-7: WorkflowState includes issue_number
**Given** a new `WorkflowState` instance
**When** created by `createWorkflowState()`
**Then** it includes an `issue_number` field (number | null)
**And** the field is populated when the workflow is triggered by a dispatch with an issue number

### AC-8: State lookup by issue number
**Given** a state file with `issue_number: 42`
**When** `findWorkflowByIssue(42)` is called
**Then** it returns the matching `WorkflowState`
**And** if multiple matches exist, it returns the most recent (by `created_at`)
**And** if no match exists, it returns `null`

### AC-9: Orchestrator resume accepts issue number
**Given** the orchestrator `resume` command
**When** called with `{ "issueNumber": 42, "action": "approve" }` (no workflowId)
**Then** it calls `findWorkflowByIssue(42)` to resolve the workflow_id
**And** proceeds with the existing resume logic
**And** if no workflow is found, logs an error and exits with code 1

### AC-10: Routing executor passes issue_number when creating state
**Given** the routing executor creates a `label_and_state` action (Story 4.2)
**When** `createWorkflowState()` is called for `translation_error` routing
**Then** the `issue_number` is passed and stored in the state file

### AC-11: CI test for resume-by-issue lookup
**Given** the CI test suite
**When** the resume-by-issue test runs
**Then** it validates:
- `findWorkflowByIssue()` returns correct state when issue exists
- `findWorkflowByIssue()` returns null when no matching issue
- `findWorkflowByIssue()` returns the most recent state when multiple matches
- Orchestrator resume with `issueNumber` resolves correctly

### AC-12: All existing endpoints remain functional
**Given** the Worker with the new routing logic
**When** requests hit `/api/bug` or `/api/commands`
**Then** all existing behavior is preserved (no breaking changes)
**And** HMAC-SHA256 signature validation is unchanged
**And** AUTHORIZED_USERS check is unchanged

---

## Architecture Reference

**Worker routing logic** (Architecture Section 9.3, extended for both commands):
```typescript
// Shared check used by both handleApprove() and handleReject():
function isSDKPipelineIssue(labels) {
  return labels.some(l => l.name === 'content-error' || l.name === 'translation-error');
}

// handleApprove():
if (isSDKPipelineIssue(labels)) {
  await dispatchSDKResume(issueNumber, 'approve', labels);
} else {
  await dispatchAutoFix(issueNumber);  // existing behavior
}

// handleReject():
if (isSDKPipelineIssue(labels)) {
  await dispatchSDKResume(issueNumber, 'reject', labels, rejectionReason);
  // Do NOT close issue — SDK pipeline decides
} else {
  await handleRejectLegacy(issueNumber);  // existing: label + close
}
```

**Why issue_number instead of workflow_id in the dispatch:**
The Worker runs on Cloudflare and has no access to the `state/` directory in `sortinghistory-bugs`. The receiving workflow runs in GitHub Actions where state files are local. The `findWorkflowByIssue()` function bridges the gap — it scans state files to find the workflow associated with a given issue number. This is more robust than having the Worker parse issue comments or call extra APIs.

**Existing workflow already listens for `sdk-resume`:**
`sdk-content-pipeline.yml` line 5: `types: [sdk-content-verify, sdk-resume]`

---

## Technical Design

### 1. Worker Changes (Private Repo)

**File:** `workers/bug-webhook/src/index.ts`

Add a shared helper to check if an issue is SDK-pipeline-routed:

```typescript
/** Check if issue labels indicate an SDK pipeline issue */
function isSDKPipelineIssue(labels: GitHubLabel[]): boolean {
  const labelNames = labels.map(l => l.name);
  return labelNames.includes('content-error') || labelNames.includes('translation-error');
}
```

**Modify `handleApprove()`** (currently line 468) to check labels before dispatching:

```typescript
async function handleApprove(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext,
  labels: GitHubLabel[]  // Already available from payload.issue.labels
): Promise<Response> {
  // 1. Add 'approved' label (unchanged)
  // ...existing code...

  // 2. Check labels to decide dispatch target
  if (isSDKPipelineIssue(labels)) {
    return await dispatchSDKResume(env, issueNumber, 'approve', labels, githubHeaders, ctx);
  } else {
    // Existing auto-fix pipeline (unchanged behavior)
    return await dispatchAutoFix(env, issueNumber, githubHeaders, ctx);
  }
}
```

**Modify `handleReject()`** (currently line 669) — same label check:

```typescript
async function handleReject(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>,
  labels: GitHubLabel[],
  rejectionReason: string
): Promise<Response> {
  if (isSDKPipelineIssue(labels)) {
    // Route to SDK pipeline — do NOT close issue, do NOT add 'rejected' label
    return await dispatchSDKResume(env, issueNumber, 'reject', labels, githubHeaders, ctx, rejectionReason);
  } else {
    // Existing behavior: add 'rejected' label, post comment, close issue
    return await handleRejectLegacy(env, issueNumber, githubHeaders);
  }
}
```

Extract existing reject logic into `handleRejectLegacy()` (pure refactor, no behavior change).

**Shared `dispatchSDKResume()`** — used by both approve and reject:

```typescript
async function dispatchSDKResume(
  env: Env,
  issueNumber: number,
  action: 'approve' | 'reject',
  labels: GitHubLabel[],
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext,
  rejectionReason?: string
): Promise<Response> {
  const labelNames = labels.map(l => l.name);
  const dispatchResponse = await fetch(
    `https://api.github.com/repos/${env.BUGS_REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'sdk-resume',
        client_payload: {
          issue_number: issueNumber,
          action: action,
          labels: labelNames,
          ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
        },
      }),
    }
  );
  // ... error handling + action-specific confirmation comment ...
}
```

**Key behavioral difference for `/reject` on SDK issues:**
- Current behavior: adds `rejected` label + closes issue immediately
- New behavior: dispatches `sdk-resume` with `action: "reject"` — does NOT close, does NOT add `rejected` label. The SDK pipeline decides what to do (retry, escalate, or close).

**CRITICAL:** The `labels` array is already available in the webhook payload at `payload.issue.labels`. No extra API call needed. The existing code already reads labels (line 450-451). We just need to pass them through to `handleApprove()` and `handleReject()`.

**Note on `/reject` comment parsing:** The existing `handleFixRejection()` (line 571) already parses `/reject reason: X` and `/reject X` formats. The same parsing logic applies here — extract the rejection reason from the comment body before routing.

### 2. SDK State Library Changes (Public Repo)

**File:** `Scripts/sdk/lib/state.ts`

Add `issue_number` to `WorkflowState`:
```typescript
export interface WorkflowState {
  // ... existing fields ...
  issue_number: number | null;  // NEW: links workflow to GitHub issue
}
```

Update `createWorkflowState()` signature:
```typescript
export async function createWorkflowState(
  type: WorkflowType,
  trigger: "scheduled" | "dispatch" | "manual",
  category?: string,
  issueNumber?: number,  // NEW
): Promise<WorkflowState>
```

Add lookup function:
```typescript
/** Find the most recent workflow state for a given issue number. Returns null if none found. */
export async function findWorkflowByIssue(issueNumber: number): Promise<WorkflowState | null> {
  const allStates = await listWorkflowStates();
  const matching = allStates
    .filter(s => s.issue_number === issueNumber)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return matching[0] ?? null;
}
```

### 3. Routing Executor Update (Public Repo)

**File:** `Scripts/sdk/lib/routing.ts`

Update `label_and_state` handler in `executeRoute()` to pass issue_number:
```typescript
case "label_and_state":
  await githubLabel(action.repo, action.issue_number, action.labels);
  await createWorkflowState(action.workflow_type, "dispatch", action.category, action.issue_number);
  break;
```

### 4. Orchestrator Resume Update (Public Repo)

**File:** `Scripts/sdk/orchestrator.ts`

Extend `ResumeParams` to accept either `workflowId` or `issueNumber`:
```typescript
interface ResumeParams {
  workflowId?: string;       // Direct ID (existing)
  issueNumber?: number;      // Lookup by issue (new)
  action: "approve" | "reject";
  approvedItems?: string[];
  rejectionReason?: string;
}
```

Update `resumeWorkflow()`:
```typescript
async function resumeWorkflow(params: ResumeParams): Promise<void> {
  let workflowId = params.workflowId;

  if (!workflowId && params.issueNumber) {
    const state = await findWorkflowByIssue(params.issueNumber);
    if (!state) {
      console.error(`[orchestrator] No workflow found for issue #${params.issueNumber}`);
      process.exit(1);
    }
    workflowId = state.workflow_id;
    console.log(`[orchestrator] Resolved issue #${params.issueNumber} → ${workflowId}`);
  }

  if (!workflowId) {
    console.error("[orchestrator] resume requires workflowId or issueNumber");
    process.exit(1);
  }
  // ... existing resume logic ...
}
```

---

## Files to Modify

### Private Repo (Sorting-History) — Worker
| File | Change |
|------|--------|
| `workers/bug-webhook/src/index.ts` | Add `isSDKPipelineIssue()` helper, label-based routing in `handleApprove()` and `handleReject()`, extract `dispatchAutoFix()` and `handleRejectLegacy()`, add shared `dispatchSDKResume()`, pass labels through, action-specific confirmation comments |

### Public Repo (sortinghistory-bugs) — SDK
| File | Change |
|------|--------|
| `Scripts/sdk/lib/state.ts` | Add `issue_number` to `WorkflowState`, update `createWorkflowState()`, add `findWorkflowByIssue()` |
| `Scripts/sdk/lib/routing.ts` | Pass `issue_number` in `label_and_state` executor |
| `Scripts/sdk/orchestrator.ts` | Extend `ResumeParams` with `issueNumber`, update `resumeWorkflow()` to do issue-based lookup |
| `Scripts/sdk/tests/routing-fixtures.ts` | Update fixtures to include `issue_number` in expected state creation |
| `Scripts/sdk/workflows/resume-test.ts` | NEW: Test harness for resume-by-issue lookup |
| `.github/workflows/sdk-content-pipeline.yml` | Add resume-by-issue CI step |

---

## Test Plan

### Test Harness: `resume-test.ts`

Pure logic test — $0.00 (no API calls):

| Test | Description | Expected |
|------|-------------|----------|
| resume-1 | Create state with issue_number=42, call `findWorkflowByIssue(42)` | Returns matching state |
| resume-2 | Call `findWorkflowByIssue(999)` (no match) | Returns null |
| resume-3 | Create 2 states for issue_number=42, call `findWorkflowByIssue(42)` | Returns the more recent one |
| resume-4 | Create state with issue_number=null, call `findWorkflowByIssue(42)` | Returns null (null doesn't match) |

### CI Step

Add to `sdk-content-pipeline.yml` after routing test:
```yaml
- name: "Story 4.3: Resume-by-issue lookup test"
  working-directory: Scripts/sdk
  run: node dist/orchestrator.js resume-by-issue-test
  timeout-minutes: 1
```

### Existing Tests Must Still Pass

All existing CI steps must remain green:
- Story 1.3: Haiku proof
- Story 4.2: Routing test (9/9)
- Story 4.1: Triage test (7/7)
- Story 1.5: Pause-resume

### Worker Manual Test

Worker changes cannot be tested in SDK CI. Manual test via `wrangler dev`:

1. Start local Worker: `cd workers/bug-webhook && wrangler dev`
2. `/approve` + `content-error` label → verify dispatch is `sdk-resume` with `action: "approve"`
3. `/approve` + no SDK labels → verify dispatch is `approve` (backward compatible)
4. `/reject reason: wrong date` + `translation-error` label → verify dispatch is `sdk-resume` with `action: "reject"` and `rejection_reason: "wrong date"`
5. `/reject` + no SDK labels → verify issue closed + `rejected` label (existing behavior)
6. `/reject reason: bad fix` on a PR → verify dispatch is `reject-fix` (existing PR rejection, unchanged)

**Deploy after verification:** `wrangler deploy`

---

## Cost Estimate

- **CI test:** $0.00 (pure logic, no API calls)
- **Worker change:** $0.00 (routing is deterministic code, not AI)
- **Production Worker execution:** $0.00 (Cloudflare Workers free tier)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Worker breaks existing `/approve` flow | Low | HIGH | Extract existing logic into `dispatchAutoFix()` first (pure refactor), then add SDK branch. Test both paths. |
| Worker breaks existing `/reject` flow | Low | HIGH | Extract existing logic into `handleRejectLegacy()` first (pure refactor), then add SDK branch. Test: non-SDK reject still closes issue. |
| SDK `/reject` accidentally closes issue | Low | HIGH | The `dispatchSDKResume()` path deliberately skips the close-issue call. Manual test verifies issue stays open. |
| State file missing `issue_number` on existing files | Medium | Low | `issue_number` defaults to `null`. `findWorkflowByIssue()` handles null safely. |
| Multiple workflows for same issue | Low | Medium | `findWorkflowByIssue()` returns most recent by `created_at`. |
| Worker deploy fails | Low | Medium | `wrangler deploy` is idempotent. Current Worker stays live if deploy fails. |
| Routing test regression from state.ts changes | Medium | Medium | Run existing routing-test after changes to verify 9/9 still pass. |

---

## What This Story Does NOT Build

| Item | Deferred To |
|------|-------------|
| Content verification pipeline | Story 2.1 |
| Translation verification pipeline | Story 3.x |
| Actual SDK resume executing useful work | Story 2.1/2.3 (orchestrator stub says "not yet implemented") |
| Wrangler deploy automation (CD) | Not planned (manual deploy for now) |

---

## Implementation Notes

**Two-repo change — implementation order matters:**
1. **SDK changes first** (public repo) — state library, orchestrator, routing, tests
2. **Push + CI green** on public repo
3. **Worker changes second** (private repo) — label routing in handleApprove
4. **Manual test** with `wrangler dev`
5. **Deploy** with `wrangler deploy`

The SDK changes are safe to merge independently — they add capabilities without breaking existing behavior. The Worker change depends on the SDK dispatch target already existing (it does — `sdk-resume` is already registered in the workflow).

**Worker change is in the private repo (`Sorting-History`) on the `feature/bug-automation-work` branch.** This requires a separate PR to that repo, not to `sortinghistory-bugs`.

---

## Reference Documents

| Document | Purpose |
|----------|---------|
| `docs/architecture-automation-system.md` Section 6.2 | Dispatch payload format |
| `docs/architecture-automation-system.md` Section 9.3 | Worker routing logic |
| `docs/epics-automation-system.md` lines 604-636 | Story 4.3 acceptance criteria |
| `workers/bug-webhook/src/index.ts` | Current Worker source (879 lines) |
| `Scripts/sdk/lib/state.ts` | WorkflowState interface + state management |
| `Scripts/sdk/orchestrator.ts` | Resume command (lines 49-77) |
| `Scripts/sdk/lib/routing.ts` | Routing executor (Story 4.2) |
| `docs/sdk-attempt-log.md` | CHECK FIRST before implementing |
