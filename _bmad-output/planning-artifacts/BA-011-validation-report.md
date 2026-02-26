# BA-011 End-to-End Validation Report

**Status:** PENDING — Run `e2e-validation.ts` to populate
**Date:** (auto-populated)
**Branch:** `feature/ba011-triage-intelligence`

## How to Run

```bash
# Dry run (no GitHub side effects — triage API only):
cd sortinghistory-bugs
DRY_RUN=true ANTHROPIC_API_KEY=<key> npx tsx Scripts/sdk/tests/e2e-validation.ts

# Full live run (calls GitHub API to create labels, post comments):
ANTHROPIC_API_KEY=<key> npx tsx Scripts/sdk/tests/e2e-validation.ts
```

## Test Matrix

| # | Bug Description | Expected Classification | Expected Route | Result |
|---|----------------|----------------------|----------------|--------|
| 1 | Moon landing says 1968 instead of 1969 | content_error | dispatch | PENDING |
| 2 | Two copies of Boston Tea Party | content_duplicate | label | PENDING |
| 3 | App slow loading Dutch History | performance_issue | handoff_to_dev | PENDING |
| 4 | German translation 'vereint' should be 'vereinigt' | translation_error | label_and_state | PENDING |
| 5 | Something seems weird but can't describe it | needs_human_review | label (low-conf) | PENDING |

## Post-Test Checklist

- [ ] All 5 bugs have `sdk-routed` label
- [ ] Routing log has 5 entries with correct data
- [ ] Handoff comment exists on bug #3
- [ ] No unexpected dispatch events triggered for bugs #2, #4, #5
- [ ] Morning digest shows all 5 bugs with confidence scores
- [ ] Needs Attention section shows bug #5 (low confidence)
- [ ] Results documented below

## Results

(Paste JSON output from e2e-validation.ts here after running)

## Classification Accuracy Findings

(Document any misclassifications and prompt adjustments here)

## Sign-Off

- [ ] All 5 cases pass or have documented, accepted deviations
- [ ] BA-011 ready for merge
