# SDK Pipeline Attempt Log

Tracks every significant fix, experiment, and configuration change to the SDK pipeline.
Before attempting a fix, **check this log first** to see if it's been tried.

## Format

Each entry records:
- **ID**: Sequential (ATT-001, ATT-002, ...)
- **Date**: When attempted
- **Issue**: What problem was being solved
- **What was tried**: Exact change made
- **CI Run**: GitHub Actions run ID (for log retrieval)
- **Result**: PASS / FAIL / PARTIAL
- **Lesson**: What we learned (especially on failures)

---

## Log

### ATT-001: Initial proof — no cwd, maxTurns=5
- **Date:** 2026-02-12
- **Issue:** Story 1.3 proof subagent couldn't find game-repo/Data/Events/USHistory.json
- **What was tried:** Original implementation. No `cwd` param set on subagent (defaults to `process.cwd()` which is `Scripts/sdk/` due to workflow `working-directory`). maxTurns=5.
- **Commit:** `1d01dfe` (Story 1.3 implementation)
- **CI Run:** `21957083690` (workflow_dispatch on main at `ebbc140`)
- **Result:** FAIL
- **Evidence:** `result/error_max_turns` after 5 turns, 8.7s, $0.0135. Agent couldn't find file within turn budget.
- **Lesson:** `working-directory: Scripts/sdk` in the workflow YAML sets `process.cwd()` to `Scripts/sdk/`, not the repo root. Subagent needs explicit cwd pointing to repo root where `game-repo/` lives.

### ATT-002: Fix cwd via import.meta.url + bump maxTurns to 15
- **Date:** 2026-02-12
- **Issue:** Same as ATT-001 — subagent can't find game content files
- **What was tried:** Added `const repoRoot = new URL("../../", import.meta.url).pathname;` and set `cwd: repoRoot` on the subagent. Bumped maxTurns from 5 to 15.
- **Commit:** `dcb07da` ("fix(Story-1.3): set cwd to repo root and increase maxTurns")
- **CI Run:** `21957157747` (workflow_dispatch on main at `8dbad50`)
- **Result:** PARTIAL (PASS but with known issues)
- **Evidence:** Proof PASSED. But: 6 turns used (should be 1-2), agent used Glob+Bash to self-correct path, 27.8s, $0.0262, tools used: [Read, Glob, Bash].
- **Lesson:** `new URL("../../", import.meta.url).pathname` resolves relative to the COMPILED file at `dist/workflows/proof.js`, landing on `Scripts/sdk/` — NOT the repo root. The agent "worked around it" by exploring the filesystem with Bash/Glob, burning 4 extra turns. The fix masked the bug rather than solving it. Cost is 3x what it should be. This approach is fragile — if a future run has tighter turn limits or the agent doesn't explore, it will fail again.

### ATT-003: Fix path via GITHUB_WORKSPACE + split PROOF_TOOLS (PLANNED)
- **Date:** 2026-02-12 (planned)
- **Issue:** ATT-002 path still wrong (Scripts/sdk/ instead of repo root) + Bash in read-only verifier
- **What will be tried:** See tech spec `docs/tech-specs/TS-SDK-001-path-and-bash-fix.md`
- **Commit:** TBD
- **CI Run:** TBD
- **Result:** TBD
- **Expected outcome:** Proof completes in 1-2 turns, no Bash used, cost ~$0.008, tools used: [Read] only.
- **Success criteria:**
  1. CI proof step passes
  2. `Tools used:` line shows `[Read]` only (no Glob, no Bash)
  3. Subagent turn count <= 3 (visible from assistant/user message pairs in log)
  4. Cost < $0.015

---

## Codex Review Notes (PR context)

Codex reviewed commit `9176c34` (pre-ATT-002 fix) and flagged two issues:

| Codex Finding | Our Assessment | Status |
|---------------|---------------|--------|
| P1: Working directory — proof runs from Scripts/sdk but game-repo is at repo root | CONFIRMED. ATT-002 partially fixed, ATT-003 fixes properly. | ATT-003 planned |
| P1: Bash not counted as write-capable in read-only enforcement | CONFIRMED for defense-in-depth. Addressed by removing Bash from proof tools in ATT-003. Full Bash hook enforcement deferred to Story 2.1. | ATT-003 (partial), Story 2.1 (full) |
