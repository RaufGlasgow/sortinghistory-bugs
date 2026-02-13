# TS-SDK-001: Fix Proof Path Resolution + Read-Only Tool Enforcement

**Status:** PLANNED
**Attempt Log:** ATT-003 in `docs/sdk-attempt-log.md`
**Blocked by:** Nothing — can start immediately
**Blocks:** Story 2.1 (content verifier) — same path resolution applies

## Problem Statement

The Story 1.3 Haiku proof works but is fragile and expensive. Two issues:

1. **Path resolution is wrong.** `proof.ts` calculates `repoRoot` using `new URL("../../", import.meta.url).pathname`, which resolves relative to the compiled file at `dist/workflows/proof.js` — landing on `Scripts/sdk/`, not the repo root. The subagent can't find `game-repo/` at the expected relative path and wastes 4 turns exploring the filesystem.

2. **Bash is available to a "read-only" verifier.** `VERIFIER_TOOLS` includes Bash. The proof subagent actively used Bash (confirmed in CI run `21957157747`). While today it's using Bash for read-only exploration (working around issue #1), nothing prevents Bash from writing files, and the `usedWriteTools` flag doesn't check for it.

### Evidence

| Metric | ATT-002 (current) | ATT-003 (target) |
|--------|-------------------|-------------------|
| Turns used | 6 | 1-2 |
| Duration | 27.8s | ~10s |
| Cost | $0.0262 | ~$0.008 |
| Tools used | Read, Glob, Bash | Read only |
| Path correct on first try | No | Yes |

## Changes Required

### Change 1: Fix repoRoot in proof.ts

**File:** `Scripts/sdk/workflows/proof.ts`
**Lines:** 64-65

Replace:
```typescript
// Resolve repo root (two levels up from Scripts/sdk/)
const repoRoot = new URL("../../", import.meta.url).pathname;
```

With:
```typescript
// Resolve repo root: where game-repo/ is checked out.
// - CI: GITHUB_WORKSPACE is set automatically by Actions (not affected by working-directory)
// - Local: SDK_REPO_ROOT override, or run from repo root so process.cwd() is correct
const repoRoot = process.env.GITHUB_WORKSPACE
  ?? process.env.SDK_REPO_ROOT
  ?? process.cwd();
```

**Why this works:**
- `GITHUB_WORKSPACE` is a core GitHub Actions env var, always set to the workspace root (`/home/runner/work/sortinghistory-bugs/sortinghistory-bugs/`). It is NOT affected by the `working-directory` setting on the workflow step. This is the primary path in CI.
- `SDK_REPO_ROOT` is an explicit override for local development or non-standard CI setups.
- `process.cwd()` is the fallback. Locally, you'd run from the repo root. In CI, this would be `Scripts/sdk/` (wrong), but `GITHUB_WORKSPACE` takes priority.

**Why not `import.meta.url` with more `../`?**
Counting directory levels from compiled output is fragile. If the TypeScript build config changes (different `outDir`, flat output), the count breaks silently. Environment variables are explicit and don't depend on file layout.

**Why not change the workflow YAML `working-directory`?**
Other steps (npm ci, tsc, npm run build) correctly need `working-directory: Scripts/sdk`. Removing it only for the proof step works but creates inconsistency. The env var approach requires zero YAML changes.

### Change 2: Add PROOF_TOOLS constant in config.ts

**File:** `Scripts/sdk/config.ts`
**After line 47** (after VERIFIER_TOOLS definition)

Add:
```typescript
/** Minimal tools for proof workflow — truly read-only, no Bash */
export const PROOF_TOOLS = ["Read", "Glob", "Grep"] as const;
```

**Why keep Glob and Grep?**
Even with correct paths, the agent may need Glob to resolve wildcards or Grep to search within files. These are genuinely read-only. Bash is the only tool that can write.

**Why NOT remove Bash from VERIFIER_TOOLS?**
Story 2.1 (content verifier) may need Bash to run `python Scripts/validate_content.py`. That decision belongs to Story 2.1's implementation. We don't want to prematurely remove it and discover the blocker later.

### Change 3: Use PROOF_TOOLS in proof.ts

**File:** `Scripts/sdk/workflows/proof.ts`
**Line 20:** Change import

Replace:
```typescript
import { MODELS, VERIFIER_TOOLS, PATHS } from "../config.js";
```

With:
```typescript
import { MODELS, PROOF_TOOLS, PATHS } from "../config.js";
```

**Line 37:** Update log line

Replace:
```typescript
console.log(`Tools: [${VERIFIER_TOOLS.join(", ")}]`);
```

With:
```typescript
console.log(`Tools: [${PROOF_TOOLS.join(", ")}]`);
```

**Line 69-70:** Update subagent spawn

Replace:
```typescript
    tools: [...VERIFIER_TOOLS],
```

With:
```typescript
    tools: [...PROOF_TOOLS],
```

## What This Does NOT Change

- **Workflow YAML** — no changes to `sdk-content-pipeline.yml`
- **VERIFIER_TOOLS** — stays as-is with Bash for Story 2.1
- **subagent.ts** — no changes to write detection logic (deferred to Story 2.1)
- **hooks.ts** — no changes (Bash hook enforcement is a Story 2.1 concern)
- **orchestrator.ts** — no changes
- **Any other orchestrator commands** (run, resume, status) — unaffected

## Testing Plan

### Step 1: Local smoke test (before push)
```bash
cd sortinghistory-bugs/Scripts/sdk
npm run build  # Must compile without errors
```

### Step 2: Push and trigger CI
```bash
git push origin main
gh workflow run "SDK Content Pipeline" --repo RaufGlasgow/sortinghistory-bugs
```

### Step 3: Verify against success criteria
Check CI logs for the "Story 1.3: Haiku read-only proof" step:

| Criterion | How to verify | Pass condition |
|-----------|--------------|----------------|
| Proof passes | Exit code 0 | `=== Story 1.3 PROOF PASSED ===` in logs |
| Correct tools | `Tools:` log line at start | Shows `[Read, Glob, Grep]` (no Bash) |
| No exploration needed | `Tools used:` log line at end | Shows `[Read]` only (no Glob, no Bash) |
| Low turn count | Count `assistant message` log lines | 3 or fewer |
| Cost reduction | `Cost:` log line | < $0.015 |
| Path resolved first try | No "file not found" errors in subagent | No retry/exploration behavior |

### Step 4: Update attempt log
After CI completes, update ATT-003 in `docs/sdk-attempt-log.md`:
- Fill in commit hash, CI run ID
- Record actual result (PASS/FAIL)
- If FAIL: record what went wrong, add ATT-004 with next approach
- If PASS: mark status as DONE

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `GITHUB_WORKSPACE` not set | Very low (core Actions var) | Proof fails in CI | Falls through to `SDK_REPO_ROOT` then `process.cwd()` |
| Proof fails without Bash (can't explore) | Low if path is correct | CI step fails | Path fix is the primary change; if agent still can't find file, path is still wrong — debug from there |
| `GITHUB_WORKSPACE` has trailing slash causing double-slash in paths | Low | Agent might construct `//home/runner/...` | Claude SDK Read tool handles this; if not, add `path.resolve()` normalization |
| Removing Bash breaks something we didn't anticipate in the proof | Very low — proof only reads one file | Proof fails | Easy rollback: change PROOF_TOOLS back to VERIFIER_TOOLS |

## Deferred to Story 2.1

The following are NOT addressed by this spec and belong in Story 2.1:

1. **Bash write enforcement for verifiers.** When VERIFIER_TOOLS is used (with Bash), add a PreToolUse hook that inspects Bash commands and blocks write patterns (`>`, `>>`, `rm`, `mv`, `sed -i`, `chmod`, etc.).
2. **Bash detection in `usedWriteTools`.** Either add Bash to `writeToolNames` with command inspection, or rely on hooks to prevent writes and keep detection simple.
3. **Path resolution for verifier workflows.** The `repoRoot` fix in proof.ts should be extracted to a shared utility (e.g., `lib/paths.ts`) so all workflows use the same resolution. Don't duplicate the env var chain in every workflow file.
