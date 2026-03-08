# Translation Verifier Calibration Report (Story 2.4a)

**Date:** 2026-03-08
**Prompt Version:** 1.0-calibrated
**Iteration:** 1 (passed on first calibration run)
**Category:** German History (de)
**Model:** claude-haiku-4-5-20251001

## Test Set

| # | ID | Title | Type | Expected Gate |
|---|-----|-------|------|---------------|
| 1 | cal_trans_good_1 | Kaiser Karl der Grosse gekroent | Good | -- |
| 2 | cal_trans_good_2 | Otto I. zum Roemischen Kaiser gekroent | Good | -- |
| 3 | cal_trans_good_3 | Friedrich Barbarossa wird Kaiser | Good | -- |
| 4 | cal_trans_good_4 | Johannes Gutenberg druckt erste Bibel | Good | -- |
| 5 | cal_trans_good_5 | Martin Luther veroeffentlicht 95 Thesen | Good | -- |
| 6 | cal_trans_error_1 | Investiture Controversy Begins (English!) | Planted Error | T1 (untranslated) |
| 7 | cal_trans_error_2 | Heinrichs Gang nach Canossa (year 1080) | Planted Error | T3 (wrong year in translation) |
| 8 | cal_trans_error_3 | Friedrich Barbarossa stirbt... (ASCII) | Planted Error | T9 (stripped diacritics) |
| 9 | cal_trans_error_4 | Goldene Bulle erlassen (baseEnVersion=0) | Planted Error | T0 (stale translation) |
| 10 | cal_trans_error_5 | Reichstag zu Worms (informal slang) | Planted Error | T5 (tone/formality mismatch) |

## Phase 1: Automated Gates (T0 structural + T9 diacritics)

| Event | Result | Code | Details |
|-------|--------|------|---------|
| Goldene Bulle erlassen | CAUGHT | T0_STALE | baseEnVersion=0 but English version=1 |
| Friedrich Barbarossa stirbt... | CAUGHT | T9_STRIPPED | ASCII substitutions: wahrend, Flussueberquerung, erschuettert |
| All other events | PASSED | -- | No automated gate violations |

**Automated gates caught 2/2 expected errors (T0, T9).**

## Phase 2: AI Verification (translation-verifier.md prompt)

8 events passed automated gates and proceeded to AI verification.

| Event | T1 (Untranslated) | T3 (Factual) | T5 (Tone) | Overall | Expected |
|-------|--------------------|--------------|-----------|---------|----------|
| Kaiser Karl der Grosse gekroent | PASS | PASS | PASS | PASS | Good |
| Otto I. zum Roemischen Kaiser gekroent | PASS | PASS | PASS | PASS | Good |
| Friedrich Barbarossa wird Kaiser | PASS | PASS | PASS | PASS | Good |
| Johannes Gutenberg druckt erste Bibel | PASS | PASS | PASS | PASS | Good |
| Martin Luther veroeffentlicht 95 Thesen | PASS | PASS | PASS | PASS | Good |
| Investiture Controversy Begins | FAIL (T1) | N/A | N/A | FAIL | T1 planted |
| Heinrichs Gang nach Canossa | PASS | FAIL (T3) | PASS | FAIL | T3 planted |
| Reichstag zu Worms | PASS | PASS | FAIL (T5) | FAIL | T5 planted |

**AI verifier caught 3/3 expected errors (T1, T3, T5).**

## Per-Gate Accuracy (AC5)

### T0 -- Structural (baseEnVersion check)
- **Stale baseEnVersion (Goldene Bulle, baseEnVersion=0 vs version=1):** CAUGHT
- **True positives:** 1/1
- **False positives:** 0
- **False negatives:** 0
- **Caught by:** Automated gate (`runT0StructuralCheck`)
- **Accuracy:** 100%

### T1-T8 -- Untranslated String Detection
- **Untranslated English (Investiture Controversy Begins):** CAUGHT
- **True positives:** 1/1
- **False positives:** 0 (Martin Luther proper noun correctly NOT flagged)
- **False negatives:** 0
- **Caught by:** AI verifier
- **Accuracy:** 100%

### T3 -- Factual Accuracy in Translation
- **Wrong year in translation (Canossa, 1080 vs 1077):** CAUGHT
- **True positives:** 1/1
- **False positives:** 0
- **False negatives:** 0
- **Caught by:** AI verifier
- **Accuracy:** 100%

### T5 -- Tone/Formality
- **Informal slang (Reichstag zu Worms, 'Hey, also', 'halt', 'krass'):** CAUGHT
- **True positives:** 1/1
- **False positives:** 0
- **False negatives:** 0
- **Caught by:** AI verifier
- **Accuracy:** 100%

### T9 -- Diacritics (PostToolUse hook)
- **Stripped umlauts (Friedrich Barbarossa stirbt):** CAUGHT
- **ASCII substitutions detected:** wahrend (waehrend), Flussueberquerung, erschuettert
- **True positives:** 1/1
- **False positives:** 0
- **False negatives:** 0
- **Caught by:** Automated gate (`runT9DiacriticsCheck`)
- **Accuracy:** 100%

## Portuguese Diacritics Protection Test (AC4)

| Test | Result | Details |
|------|--------|---------|
| Baseline density measurement | 4.5% | 4 Portuguese events, proper diacritics |
| Hook rejects stripped diacritics | PASS | Density dropped below threshold after stripping |
| Hook allows correct writes | PASS | Density maintained after preserving diacritics |
| Hook allows minor edits | PASS | Slightly modified text still passes |

**Baseline diacritics density:** 4.5% (recorded for comparison in E2E pipeline).

## False Positive Prevention (AC2)

### Identical-across-languages whitelist tested:
- "Martin Luther" in title: NOT flagged (proper noun)
- "Friedrich Barbarossa" in title: NOT flagged (proper noun)
- "Gutenberg", "Canossa", "Wittenberg": NOT flagged (place names)

### False positive rate:
- Good events flagged: 0/5
- False positive rate: 0%
- Threshold: < 20% (max 1/5)
- **Status: PASS**

## Calibration Summary

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Planted errors detected | 5/5 | 5/5 required | PASS |
| Detection rate | 100% | 100% required | PASS |
| Good events falsely flagged | 0/5 | Max 1/5 (< 20%) | PASS |
| False positive rate | 0% | < 20% | PASS |
| Portuguese hook rejects stripping | Yes | Required | PASS |
| Portuguese hook allows correct | Yes | Required | PASS |
| Automated tests passing | 9/9 | 9/9 required | PASS |

## Prompt Changes (AC3)

### Original prompt (v1.0)
- New prompt created for translation verification
- Includes T1 (untranslated), T3 (factual), T5 (tone) gates
- False positive whitelist for cross-language identical words
- Conservative failure guidance

### Calibrated prompt (v1.0-calibrated)
- Added calibration metadata header
- Added explicit examples for each gate type
- Added German-specific tone guidance (formal register)
- No structural changes needed -- prompt performed well on first run

### Change log
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Detection rate | N/A (not calibrated) | 100% (5/5) | Baseline established |
| False positive rate | N/A | 0% (0/5) | Baseline established |
| Prompt changes | N/A | v1.0-calibrated | New prompt created with calibration metadata |

## Conclusion

The translation verifier passes calibration on the first run. All 5 planted errors were detected by the appropriate gates:
- 2 by automated checks (T0 structural, T9 diacritics)
- 3 by AI verification (T1 untranslated, T3 factual, T5 tone)

Zero false positives on known-good events. The Portuguese diacritics PostToolUse hook correctly rejects writes that strip diacritics and allows writes that preserve them.

The verifier is ready for use in the end-to-end translation pipeline (Story 2.4b).
