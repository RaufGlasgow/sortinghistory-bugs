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

### ATT-003: Fix path via GITHUB_WORKSPACE + split PROOF_TOOLS
- **Date:** 2026-02-13
- **Issue:** ATT-002 path still wrong (Scripts/sdk/ instead of repo root) + Bash in read-only verifier
- **What was tried:** See tech spec `docs/tech-specs/TS-SDK-001-path-and-bash-fix.md`
- **Commit:** `7ad9fef`
- **CI Run:** `21979141829` (workflow_dispatch), `21977983771` (scheduled)
- **Result:** PARTIAL — path fix CONFIRMED WORKING, failed on JSON parsing
- **Evidence:**
  - Path: 3 turns (vs 6 in ATT-002), 5.9s (vs 27.8s), tools used: Read only (no Glob, no Bash!)
  - Agent found file on first try, read correct data: "Jamestown Settlement Founded" (1607)
  - FAILURE: Haiku returned narrative text before the JSON code block. Existing parser only handles responses starting with ``` — didn't handle narrative preamble.
- **Lesson:** `GITHUB_WORKSPACE` env var chain works correctly in CI. PROOF_TOOLS (no Bash) works — agent doesn't need Bash when path is correct. However, Haiku doesn't reliably output raw JSON even when instructed — parser must be resilient to narrative wrapping. The old code (ATT-002) only passed JSON parsing because 6 turns of interaction nudged Haiku toward compliance.

### ATT-004: Improve JSON extraction from Haiku response
- **Date:** 2026-02-13
- **Issue:** ATT-003 Haiku returned narrative text around JSON code block, parser only handled responses starting with ```
- **What was tried:** Replaced simple startsWith("```") check with:
  1. Regex extraction of ```json...``` block from anywhere in response
  2. Fallback: find first `{` and last `}` as JSON boundaries
- **Commit:** `12307d1`
- **CI Run:** `21979229305` (workflow_dispatch on main)
- **Result:** PASS
- **Evidence:**
  - All 5 validations passed: subagent success, read-only confirmed, valid JSON, event_count=81, first_event correct
  - 3 turns, 5.7s duration, tools used: [Read, Glob] (no Bash)
  - Cost: $0.0297 (higher than $0.015 target — but this is due to USHistory.json being a large file with 8,176 input tokens, not wasted exploration)
  - JSON parsing succeeded despite Haiku narrative wrapping
- **Lesson:** Input token cost is dominated by the game data file size, not by turn count or path exploration. The $0.015 cost target was unrealistic for a file this size. Actual per-run cost is ~$0.03 for Haiku reading a 100-event JSON file — this is the baseline cost, not reducible further without changing the file or model. Both Codex findings are now resolved: path via GITHUB_WORKSPACE, Bash removed from proof tools, JSON parsing resilient.

### ATT-005: Story 4.1 — Bug Triager subagent (PLANNED)
- **Date:** 2026-02-13
- **Issue:** New workflow — classify bug reports into 6 categories via Haiku subagent
- **What was tried:** New `bug-triage.ts` workflow following proven `proof.ts` pattern. New `TRIAGE_TOOLS` (Read, Glob, Grep — no Bash, no Write). System prompt in `prompts/bug-triager.md`. 5 test fixtures. Orchestrator `triage` command. JSON parsing uses same regex + brace fallback proven in ATT-004.
- **Approach differs from prior attempts:** N/A — this is a new workflow, not a fix. Reuses all lessons from ATT-001 through ATT-004: GITHUB_WORKSPACE for path, no Bash in read-only tools, defensive JSON parsing.
- **Expected outcome:** 5/5 test reports correctly classified. Each result has valid JSON with classification, severity, reasoning, extracted_context. Cost ~$0.03/run x 5 = ~$0.15 total.
- **Commit:** `52b42d5`
- **CI Run:** TBD (awaiting CI dispatch)
- **Result:** IMPLEMENTED — awaiting CI validation

---

## Codex Review Notes (PR context)

Codex reviewed commit `9176c34` (pre-ATT-002 fix) and flagged two issues:

| Codex Finding | Our Assessment | Status |
|---------------|---------------|--------|
| P1: Working directory — proof runs from Scripts/sdk but game-repo is at repo root | CONFIRMED. ATT-002 partially fixed, ATT-003 fixes properly. | ATT-003 planned |
| P1: Bash not counted as write-capable in read-only enforcement | CONFIRMED for defense-in-depth. Addressed by removing Bash from proof tools in ATT-003. Full Bash hook enforcement deferred to Story 2.1. | ATT-003 (partial), Story 2.1 (full) |
