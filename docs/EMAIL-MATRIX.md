# Pipeline Email Matrix

PIPE-007.4 — Complete audit of all email notification paths.

## Email Types

| # | Email | Subject Pattern | Trigger | Sender | Repo |
|---|-------|----------------|---------|--------|------|
| 1 | **Action Needed** | `Urgent: #{N} — {classification}` | Triage routes to label/handoff_to_dev/label_and_state | `triage.ts` → `sendActionNeededEmail()` | public |
| 2 | **PR Created** | `PR Ready: #{N} — {title}` | Fix pipeline creates a PR | `sdk-bug-fix.yml` → `send-pr-email.ts` | public |
| 3 | **Handoff** (amber) | `Handoff: #{N} — Pipeline needs your help` | Fix retry loop exhausts all attempts | `retry-loop.ts` → `sendHandoffEmail()` | public |
| 4 | **Billing Alert** | Billing-related subject | API credit depletion detected | `retry-loop.ts` → `sendBillingAlertEmail()` | public |
| 5 | **Digest** | `SortingHistory: {N} bug(s)...` or `All clear` | Cron 3x daily + manual dispatch | `daily-analysis-digest.yml` via curl | public |
| 6 | **Translation Failure** | `Pipeline Failed: Translation fix crashed for #{N}` | Translation pipeline step fails | `sdk-translation-pipeline.yml` via curl | public |

## Email Flow by Bug Type

### Code Bug (ui_bug, gameplay_bug, crash_bug, performance_issue)

```
Bug submitted → Triage → shouldSendEmail() = true → [1] Action Needed email
User /approve → dispatch-to-bugs.yml → sdk-bug-fix.yml
  → Success → [2] PR Created email
  → Failure (all attempts) → [3] Handoff email
  → fix-failed label → visible in [5] Digest
```

### Translation Error

```
Bug submitted → Triage → routing type = "dispatch" → shouldSendEmail() = false → NO email
  → sdk-translation-pipeline.yml runs automatically
  → Success → PR created (no email — GAP)
  → Failure → [6] Translation Failure email + translation-fix-failed label
User /approve → dispatch-to-bugs.yml → sdk-translation-resume (PIPE-007.2 fix)
  → Success → applies translation
  → Failure → [6] Translation Failure email
```

### Content Error

```
Bug submitted → Triage → routing type = "dispatch" → shouldSendEmail() = false → NO email
  → Content pipeline runs automatically (separate flow)
```

### Feature Request

```
Bug submitted → Triage → shouldSendEmail() = false → NO email (backlogged)
```

### Needs Human Review

```
Bug submitted → Triage → shouldSendEmail() = true → [1] Action Needed email
  → Issue visible in [5] Digest with needs-human-review label
```

## Issue #145 Investigation

**Why no triage email?** Issue #145 was classified as `translation_error`. The routing type for translation errors is `"dispatch"` (not `"label_and_state"`). The `shouldSendEmail()` function returns `false` for `"dispatch"` actions. This is by design — the translation pipeline is supposed to handle the issue automatically.

**The gap:** Translation issues that are auto-dispatched don't get an "Action Needed" email. The user only learns about them from the digest (if they appear) or the translation failure email (if it crashes). Before PIPE-007.1, `sdk-routed` issues were filtered OUT of the digest, making them completely invisible.

**After PIPE-007.1:** Translation issues with `sdk-routed` label now appear in the digest with action buttons. This closes the visibility gap.

## Known Gaps

1. **Translation success has no email.** When `sdk-translation-pipeline.yml` successfully applies a fix, there is no PR Created email equivalent. The fix is committed directly to the public repo and the state file is updated, but no notification is sent. The digest will show the issue until it's manually closed or labels are updated.

2. **Orchestrator crash before retry-loop completes.** If the orchestrator crashes with an unhandled error before the retry loop's `sendHandoffEmail()` fires (e.g., config parse error, missing dependency), no failure email is sent. The `fix-failed` label is still applied by the YAML failure handler, so the issue appears in the digest and the pipeline health section.

## PIPE-007 Changes Summary

| Story | What Changed | Impact |
|-------|-------------|--------|
| PIPE-007.1 | Digest queries `sdk-routed` issues, removed from skip filter | Translation issues now visible in digest |
| PIPE-007.2 | `/approve` routes translation issues to `sdk-translation-resume` | Translation fixes go to correct pipeline |
| PIPE-007.3 | Removed YAML failure email from `sdk-bug-fix.yml` | Single failure email (Handoff) instead of 2 |
| PIPE-007.4 | This document | Complete email path documentation |
