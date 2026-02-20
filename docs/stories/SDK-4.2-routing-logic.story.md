# Story 4.2: Routing Logic

**Epic:** 4 — Bug Triage & Routing
**Prerequisites:** Story 4.1 (Bug Triager) — DONE (CI green, 7/7 fixtures)
**Blocks:** Story 4.3 (Cloudflare Worker Update)
**FRs Covered:** FR5 (Route to appropriate workflow), FR29 (Triage routes correctly), FR32 (Feature requests logged to backlog)

---

## User Story

As a product owner,
I want classified bug reports automatically routed to the correct workflow,
So that content errors flow to the content pipeline and code bugs get queued for my Claude Code sessions.

---

## Acceptance Criteria

### AC-1: content_error routing
**Given** a triage result with classification `content_error`
**When** the routing logic processes it
**Then** it dispatches `repository_dispatch` event `sdk-content-verify` to `sortinghistory-bugs` with `{ workflow_type: "content_verification", category: <extracted_category>, issue_number: <N> }`
**And** if `extracted_category` is missing or empty, it defaults to `"unknown"`

### AC-2: translation_error routing
**Given** a triage result with classification `translation_error`
**When** the routing logic processes it
**Then** it labels the issue `translation-error` and `sdk-routed` on the private repo
**And** it creates a workflow state file with type `translation_verification`
*(Translation pipeline not built yet — Story 3.x. State file reserves the queue slot.)*

### AC-3: ui_bug (simple) routing
**Given** a triage result with classification `ui_bug` and severity P3 or P4
**When** the routing logic processes it
**Then** it dispatches `repository_dispatch` event `approve` to `sortinghistory-bugs` with `{ issue_number: <N> }` (existing auto-fix.yml)

### AC-4: ui_bug (complex) routing
**Given** a triage result with classification `ui_bug` and severity P1 or P2
**When** the routing logic processes it
**Then** it labels the issue `needs-claude-code` and `sdk-routed` on the private repo

### AC-5: gameplay_bug routing
**Given** a triage result with classification `gameplay_bug`
**When** the routing logic processes it
**Then** it labels the issue `needs-claude-code` and `sdk-routed` on the private repo

### AC-6: feature_request routing
**Given** a triage result with classification `feature_request`
**When** the routing logic processes it
**Then** it labels the issue `feature-request` and `sdk-routed` on the private repo

### AC-7: needs_human_review routing
**Given** a triage result with classification `needs_human_review`
**When** the routing logic processes it
**Then** it labels the issue `needs-human-review` and `sdk-routed` on the private repo

### AC-8: CI test passes
**Given** the routing-test harness with mock triage results for all 7 routing paths
**When** CI runs
**Then** all routing decisions are correct (no Anthropic API calls, no GitHub API calls — pure logic test)

### AC-9: Dry-run mode
**Given** `DRY_RUN=true` environment variable
**When** routing logic processes any classification
**Then** it logs the routing decision but does NOT execute GitHub API calls
**And** the log output includes: classification, action type, target, payload

### AC-10: Idempotency — already-routed issues are skipped
**Given** an issue that already has the `sdk-routed` label
**When** the routing logic processes it
**Then** it skips routing entirely and logs "already routed, skipping issue #N"
**And** no GitHub API calls (dispatch or label) are made

### AC-11: Executor throws on API failure
**Given** the routing executor calls the GitHub API
**When** the response status is not 2xx
**Then** it throws an error with the status code and response body
*(Retry logic is NOT in scope — the orchestrator can add retry in a future story.)*

---

## Architecture Reference

**Routing rules:** Architecture Section 5.7 — built into orchestrator dispatch logic, not a separate service.

| Classification | Route To | Dispatch |
|---------------|----------|----------|
| content_error | SDK content verification pipeline | `repository_dispatch: sdk-content-verify` to sortinghistory-bugs |
| translation_error | Translation queue (state file + label) | Label issue, create state |
| ui_bug (P3/P4) | Existing auto-fix pipeline | `repository_dispatch: approve` to sortinghistory-bugs |
| ui_bug (P1/P2) | Manual queue for Claude Code session | Label `needs-claude-code` |
| gameplay_bug | Manual queue | Label `needs-claude-code` |
| feature_request | Backlog | Label `feature-request` |
| needs_human_review | Manual triage queue | Label `needs-human-review` |

**Simple vs complex UI bug determination (MVP):**
- P1/P2 severity → complex (high severity = needs human diagnosis)
- P3/P4 severity → simple (route to auto-fix)
- This is deliberately simple. Can be refined with extracted_context analysis in a future story.

---

## Technical Design

### 1. Pure Routing Decision Function

`Scripts/sdk/lib/routing.ts` — zero side effects, fully testable:

```typescript
export interface RoutingInput {
  classification: string;
  severity: string;
  confidence: number;
  extracted_context: Record<string, unknown>;
  issue_number: number;
}

export type RoutingAction =
  | { type: "dispatch"; event_type: string; repo: string; payload: Record<string, unknown> }
  | { type: "label"; repo: string; issue_number: number; labels: string[] }
  | { type: "label_and_state"; repo: string; issue_number: number; labels: string[]; workflow_type: WorkflowType; category?: string };

export function decideRoute(input: RoutingInput): RoutingAction { ... }
```

The `decideRoute` function is a pure switch on `classification` + `severity`. No I/O, no API calls, no randomness. Returns a `RoutingAction` describing what to do.

### 2. Routing Executor

`Scripts/sdk/workflows/route-triage.ts` — executes RoutingAction against GitHub API:

```typescript
export async function executeRoute(action: RoutingAction, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log(`[routing] DRY RUN: ${JSON.stringify(action)}`);
    return;
  }
  switch (action.type) {
    case "dispatch":
      await githubDispatch(action.repo, action.event_type, action.payload);
      break;
    case "label":
      await githubLabel(action.repo, action.issue_number, action.labels);
      break;
    case "label_and_state":
      await githubLabel(action.repo, action.issue_number, action.labels);
      await createWorkflowState(action.workflow_type, "dispatch", action.category);
      break;
  }
}
```

### 3. GitHub API Calls

Use native `fetch()` (Node 20+) with PAT auth. No new npm dependencies.

```typescript
const GITHUB_TOKEN = process.env.PRIVATE_REPO_PAT ?? process.env.GH_TOKEN;
const PRIVATE_REPO = "RaufGlasgow/Sorting-History";
const PUBLIC_REPO = "RaufGlasgow/sortinghistory-bugs";
```

**For dispatch:**
```
POST https://api.github.com/repos/{repo}/dispatches
Authorization: Bearer {PAT}
Body: { "event_type": "...", "client_payload": { ... } }
```

**For labels:**
```
POST https://api.github.com/repos/{repo}/issues/{issue_number}/labels
Authorization: Bearer {PAT}
Body: { "labels": ["needs-claude-code", "sdk-routed"] }
```

**CRITICAL:** `github.token` CANNOT trigger `repository_dispatch` — MUST use `PRIVATE_REPO_PAT`. This is a proven lesson (CLAUDE.md rule).

### 4. All Labels Added by Routing

| Label | When Applied | Purpose |
|-------|-------------|---------|
| `sdk-routed` | Always (every routed issue) | Idempotency marker — skip if already present |
| `content-error` | content_error classification | Filter for content pipeline |
| `translation-error` | translation_error classification | Filter for translation queue |
| `needs-claude-code` | complex ui_bug / gameplay_bug | Manual queue for Claude Code sessions |
| `feature-request` | feature_request classification | Backlog tracking |
| `needs-human-review` | needs_human_review classification | Manual triage queue |

**Idempotency:** Before routing, check if issue already has `sdk-routed` label. If yes, skip (already processed). This prevents double-routing if the workflow reruns.

---

## Files to Create

| File | Purpose |
|------|---------|
| `Scripts/sdk/lib/routing.ts` | Pure routing decision function + GitHub API executor |
| `Scripts/sdk/tests/routing-fixtures.ts` | 7 mock TriageResult fixtures (one per routing path) |
| `Scripts/sdk/workflows/routing-test.ts` | Test harness — validates all routing decisions |

## Files to Modify

| File | Change |
|------|--------|
| `Scripts/sdk/orchestrator.ts` | Add `route` and `routing-test` commands + imports |
| `Scripts/sdk/config.ts` | Add `ROUTING` constants (repos, labels, dispatch event types) |
| `.github/workflows/sdk-content-pipeline.yml` | Add routing-test CI step |

---

## Test Plan

### Test Harness: `routing-test.ts`

Runs 7 mock triage results through `decideRoute()` and validates the returned `RoutingAction`:

| Fixture | Classification | Severity | Expected Action |
|---------|---------------|----------|-----------------|
| route-1 | content_error | P2 | dispatch `sdk-content-verify` to public repo |
| route-2 | translation_error | P3 | label `translation-error` + `sdk-routed`, create state |
| route-3 | ui_bug | P4 | dispatch `approve` to public repo |
| route-4 | ui_bug | P1 | label `needs-claude-code` + `sdk-routed` |
| route-5 | gameplay_bug | P2 | label `needs-claude-code` + `sdk-routed` |
| route-6 | feature_request | P4 | label `feature-request` + `sdk-routed` |
| route-7 | needs_human_review | P3 | label `needs-human-review` + `sdk-routed` |
| route-8 | content_error | P2 | **skip** — issue already has `sdk-routed` label |
| route-9 | content_error (no category) | P3 | dispatch with `category: "unknown"` |

**No Anthropic API calls.** No GitHub API calls. Pure logic test. Cost: $0.00.

### CI Step

Add to `sdk-content-pipeline.yml` after the existing triage-test step:

```yaml
- name: "Story 4.2: Routing logic test"
  working-directory: Scripts/sdk
  run: node dist/orchestrator.js routing-test
  timeout-minutes: 1
```

### Pass Criteria

- All 9 routing fixtures produce correct `RoutingAction` (7 paths + idempotency skip + category fallback)
- `decideRoute()` throws on unknown classification (defensive)
- DRY_RUN mode logs actions without executing
- TypeScript compiles with zero errors
- No new npm dependencies added

---

## Cost Estimate

- **CI test:** $0.00 (pure logic, no API calls)
- **Production routing per bug:** $0.00 (routing is deterministic code, not AI)
- **GitHub API calls:** Free within rate limits

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Labels don't exist on private repo | Medium | API returns 422 | Create labels via `gh label create` before first run (one-time setup) |
| PAT missing or expired | Low | Dispatch fails silently | Check `PRIVATE_REPO_PAT` exists at startup, fail loud |
| Double-routing on workflow rerun | Medium | Duplicate dispatches | `sdk-routed` label check before routing (idempotency) |
| auto-fix.yml dispatch format changed | Low | Simple UI bugs fail | Test with a real dispatch before merging |

---

## What This Story Does NOT Build

| Item | Deferred To |
|------|-------------|
| Full content verification pipeline | Story 2.1 |
| Translation verification pipeline | Story 3.x |
| Worker receiving triage results | Story 4.3 |
| Comment on issue acknowledging receipt | Story 4.3 (FR6) |
| Complex vs simple using AI analysis | Future story |
| Label creation automation | One-time manual setup |

---

## Reference Documents

| Document | Purpose |
|----------|---------|
| `docs/architecture-automation-system.md` Section 5.7 | Routing rules table |
| `docs/architecture-automation-system.md` Section 6.2 | Dispatch payload format |
| `docs/epics-automation-system.md` lines 566-601 | Story 4.2 acceptance criteria |
| `Scripts/sdk/workflows/bug-triage.ts` | TriageResult interface (input to router) |
| `Scripts/sdk/lib/state.ts` | createWorkflowState (for translation queue) |
| `docs/sdk-attempt-log.md` | CHECK FIRST before implementing |
