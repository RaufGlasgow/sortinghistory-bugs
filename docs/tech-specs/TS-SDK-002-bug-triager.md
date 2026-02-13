# TS-SDK-002: Bug Triager Subagent

**Story:** 4.1 — Bug Triager
**Attempt Log:** ATT-005
**Status:** IMPLEMENTED (merged to main at `0386f9e`, CI step added in ATT-007)
**Date:** 2026-02-13

---

## Purpose

Classify incoming bug reports into one of 6 categories via a Haiku subagent, enabling automated routing to the correct pipeline (content verification, translation team, developer review, or manual triage queue).

## What It Does

1. Accepts a bug report as plain text input
2. Spawns a Haiku subagent with read-only triage tools (Read, Glob, Grep -- no Bash, no Write)
3. The subagent reads a system prompt that defines 6 classification types, severity scale, context extraction rules, and confidence thresholds
4. If the report mentions specific events/dates, the subagent can search game data files to verify
5. If the report describes UI/gameplay issues, the subagent can reference the architecture registry for relevant source files
6. Returns structured JSON with: classification, confidence, severity, reasoning, extracted_context, routing_recommendation

## Classification Types

| Type | Description |
|------|-------------|
| `content_error` | Wrong date, fact, category, or factual inaccuracy in event data |
| `translation_error` | Mistranslation, missing translation, wrong language variant |
| `ui_bug` | Visual, layout, animation, or navigation issues |
| `gameplay_bug` | Affects game logic, scoring, ordering, or causes crashes/data loss |
| `feature_request` | User asking for something that doesn't exist |
| `needs_human_review` | Confidence < 0.7 or ambiguous classification |

## Severity Scale

- **P1:** Critical -- crashes, data loss, blocks gameplay
- **P2:** High -- major feature broken, no workaround
- **P3:** Medium -- minor issue, workaround exists
- **P4:** Low -- cosmetic, enhancement, feature requests

## Files Created

| File | Purpose |
|------|---------|
| `Scripts/sdk/workflows/bug-triage.ts` | Main triage workflow -- spawns subagent, validates response |
| `Scripts/sdk/prompts/bug-triager.md` | System prompt defining classifications, severity, context rules |
| `Scripts/sdk/tests/triage-fixtures.ts` | 5 test fixtures with expected classifications and severity ranges |
| `Scripts/sdk/workflows/triage-test.ts` | Test harness -- runs all fixtures, validates results (added in ATT-007) |

## Files Modified

| File | Change |
|------|--------|
| `Scripts/sdk/config.ts` | Added `TRIAGE_TOOLS` constant (Read, Glob, Grep) |
| `Scripts/sdk/orchestrator.ts` | Added `triage-test` command |
| `.github/workflows/sdk-content-pipeline.yml` | Added triage-test CI step (ATT-007) |

## Model

**Haiku 4.5** (`claude-haiku-4-5-20251001`) -- same as proof and verification workflows. Read-only, no write capability needed.

## Tool Set

`TRIAGE_TOOLS = ["Read", "Glob", "Grep"]`

No Bash (proven unnecessary in ATT-003 when paths are correct). No Write/Edit (read-only workflow).

## JSON Parsing Approach

Uses the shared `extractJson()` utility (consolidated in ATT-007 to `Scripts/sdk/lib/json-extract.ts`):

1. **Try regex**: Extract ` ```json ... ``` ` code block from anywhere in response
2. **Fallback**: Find first `{` and last `}` as JSON boundaries
3. **Pass-through**: If response already starts with `{`, use as-is

This is the proven pattern from ATT-004 that handles Haiku's tendency to wrap JSON in narrative text.

After extraction, the result is validated against required fields:
- `classification` must be one of 6 valid values
- `confidence` must be 0.0-1.0
- `severity` must be P1-P4
- `reasoning` must be non-empty string
- `extracted_context` must be an object
- `routing_recommendation` must be non-empty string

## Test Fixtures

| ID | Report | Expected Classification | Expected Severity |
|----|--------|------------------------|-------------------|
| test-A | "The year for the moon landing says 1968 instead of 1969" | content_error | P2/P3 |
| test-B | "In German, 'Ancient Egypt' is translated wrong" | translation_error | P2/P3 |
| test-C | "The help bubble doesn't show on first launch" | ui_bug | P3/P4 |
| test-D | "Game crashes when sorting more than 10 events quickly" | gameplay_bug | P1/P2 |
| test-E | "Please add a dark mode option" | feature_request | P4 |

## Pass Criteria

- All 5 fixtures correctly classified (classification matches expected)
- Severity within expected range for each fixture
- Valid JSON returned for all 5
- No write tools used (read-only enforcement)
- Total suite cost < $0.20

## Architecture Decisions

1. **Separate TRIAGE_TOOLS constant** rather than reusing PROOF_TOOLS -- even though both are currently identical (Read, Glob, Grep), they serve different purposes and may diverge
2. **System prompt in markdown file** (`prompts/bug-triager.md`) rather than inline -- keeps prompts editable and version-controlled separately from code
3. **No `process.exit(1)` in test harness** for individual fixture failures -- the harness collects all results and reports at the end, exiting only after all fixtures have run
4. **`runTriage()` still calls `process.exit(1)` on subagent failures** -- a subagent crash is a hard failure, not a classification disagreement

## Cost

Expected: ~$0.03 per fixture (Haiku reading small bug reports, no large file reads needed for most fixtures). Total suite: ~$0.15.

Content error fixture (test-A) may cost more if the subagent searches event data files to verify the claim.
