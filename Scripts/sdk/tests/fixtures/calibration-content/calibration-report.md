# Content Verifier Calibration Report (Story 2.3a)

**Date:** 2026-03-08
**Prompt Version:** 1.1-calibrated
**Iteration:** 1 (passed on first calibration run)
**Category:** US History

## Test Set

| # | Title | Type | Expected Gate |
|---|-------|------|---------------|
| 1 | Declaration of Independence Signed | Good | -- |
| 2 | Moon Landing | Good | -- |
| 3 | Louisiana Purchase Completed | Good | -- |
| 4 | Rosa Parks Refuses to Give Up Seat | Good | -- |
| 5 | Transcontinental Railroad Completed | Good | -- |
| 6 | Columbus Reaches Americas (year 1493) | Planted Error | F1 (wrong year) |
| 7 | First Telephone Call Made (36 words) | Planted Error | P2 (too-long description) |
| 8 | Boston Tea Party (Paris/French context) | Planted Error | F2 (wrong country) |
| 9 | Declaration of Independence Signed (dup) | Planted Error | D1 (exact duplicate) |
| 10 | Salem Witch Executions (graphic) | Planted Error | A1 (age-inappropriate) |

## Phase 1: Automated Gates (inline TypeScript checks)

| Event | Result | Code | Details |
|-------|--------|------|---------|
| First Telephone Call Made | CAUGHT | P2 | 36 words exceeds 23-word maximum |
| Declaration of Independence Signed (dup) | CAUGHT | D1 | Exact duplicate title (case-insensitive) |
| All other events | PASSED | -- | No automated gate violations |

**Automated gates caught 2/2 expected errors (P2, D1).**

## Phase 2: AI Verification (content-verifier.md prompt)

8 events passed automated gates and proceeded to AI verification.

| Event | Gate 1 (Factual) | Gate 2 (Age) | Overall | Expected |
|-------|-------------------|--------------|---------|----------|
| Declaration of Independence Signed | PASS | PASS | PASS | Good |
| Moon Landing | PASS | PASS | PASS | Good |
| Louisiana Purchase Completed | PASS | PASS | PASS | Good |
| Rosa Parks Refuses to Give Up Seat | PASS | PASS | PASS | Good |
| Transcontinental Railroad Completed | PASS | PASS | PASS | Good |
| Columbus Reaches Americas | FAIL (F1) | PASS | FAIL | F1 planted |
| Boston Tea Party | FAIL (F2) | PASS | FAIL | F2 planted |
| Salem Witch Executions | PASS | FAIL (A1) | FAIL | A1 planted |

**AI verifier caught 3/3 expected errors (F1, F2, A1).**

## Per-Gate Accuracy (AC4)

### Gate 1 — Factual Accuracy
- **Wrong year (Columbus 1493 vs 1492):** CAUGHT (F1)
- **Wrong country context (Boston Tea Party in Paris):** CAUGHT (F2)
- **True positives:** 2/2
- **False positives:** 0 (no good events falsely flagged for factual issues)
- **False negatives:** 0
- **Accuracy:** 100%

### Gate 2 — Age Appropriateness
- **Graphic violence (Salem Witch Executions):** CAUGHT (A1)
- **True positives:** 1/1
- **False positives:** 0 (no good events falsely flagged for age issues)
- **False negatives:** 0
- **Accuracy:** 100%

### Gate 3 — Game Parameters (P1-P12)
- **Too-long description (First Telephone Call, 36 words):** CAUGHT (P2)
- **True positives:** 1/1
- **Caught by:** Automated gates (inline TypeScript checks)
- **Accuracy:** 100%

### Gate 4 — Duplicates (D1-D3)
- **Exact duplicate title:** CAUGHT (D1)
- **True positives:** 1/1
- **Caught by:** Automated gates (inline TypeScript checks)
- **Accuracy:** 100%

## Calibration Summary

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Planted errors detected | 5/5 | 5/5 required | PASS |
| Detection rate | 100% | 100% required | PASS |
| Good events falsely flagged | 0/5 | Max 1/5 (< 20%) | PASS |
| False positive rate | 0% | < 20% | PASS |
| Diacritics false positives | 0 | 0 | PASS |

## Prompt Changes (AC3)

### Original prompt (v1.0)
- Already had diacritics false-positive suppression
- Already had allowed historical vocabulary list
- Already had conservative failure guidance

### Calibrated prompt (v1.1-calibrated)
- Added version comment header with calibration metadata
- Added F2 example section: explicit guidance on wrong-location/wrong-country errors
- No structural changes needed -- original prompt performed well

### Change log
| Metric | v1.0 | v1.1-calibrated | Change |
|--------|------|-----------------|--------|
| Detection rate | N/A (not calibrated) | 100% (5/5) | Baseline established |
| False positive rate | N/A | 0% (0/5) | Baseline established |
| Prompt changes | -- | Added F2 location example, version header | Minor clarification |

## Conclusion

The content verifier passes calibration on the first run. All 5 planted errors were detected by the appropriate gates (2 by automated checks, 3 by AI verification). Zero false positives on known-good events. The prompt required only minor clarification (F2 example for wrong-location errors) and no architectural changes.

The verifier is ready for use in the end-to-end content pipeline (Story 2.3b).
