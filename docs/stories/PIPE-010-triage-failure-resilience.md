# PIPE-010: Triage Failure Resilience — No Silent Failures

**Priority:** P0 — Pipeline integrity
**Points:** 5
**Branch:** `sortinghistory-bugs/main` (worker changes on `SortingHistory/feature/engagement-retention`)
**Created:** 2026-03-19
**Principle:** No bug report should EVER be invisible. The failsafe is ALWAYS human visibility with actionable buttons (View on GitHub, Fix Locally, Retry Triage).

---

## Problem Statement

The bug pipeline was designed to give one person (the owner) total confidence that every user-submitted bug is triaged, tracked, and actionable. After 3 months and $75 invested in the pipeline, a real user bug (issue #162, submitted by the owner's wife) was completely invisible for over 24 hours because three independent systems failed silently at the same time:

1. **Triage failed** because Anthropic API credits were depleted.
2. **The failure handler failed** because the `triage-failed` label did not exist in the repo, and the `gh label` command was swallowed by `2>/dev/null || true`.
3. **The digest email silently skipped the issue** — both the triage-failed path and the "pending" path called `continue` in the bash loop, rendering zero cards for untriaged issues. The only signal was a one-line yellow footnote ("1 bug(s) still awaiting AI analysis") with no buttons.
4. **The billing alert email** was sent via Resend but was never received by the owner (delivery/spam issue unverified).

The owner only found out because his wife told him in person. This is unacceptable. The pipeline exists to prevent exactly this scenario.

---

## Incident Report (2026-03-17)

### Timeline

| Time | Event |
|------|-------|
| ~2026-03-17 afternoon | Owner's wife submits bug report via in-app form. Issue #162 created in `RaufGlasgow/Sorting-History` with `from-app` + `needs-triage` labels. |
| ~2026-03-17 afternoon | `bug-analysis.yml` triggers. SDK triage calls Anthropic API. API returns billing error ("Credit balance is too low"). Tokens: 0/0. |
| Same run | `subagent.ts` billing detection (lines 471-482) fires. Subagent returns `success: false, error: "API billing error: ..."`. Triage step exits non-zero. |
| Same run | `Notify on failure` step fires. Resend sends branded "Triage Pipeline Crashed" email to OWNER_EMAIL. **Owner never receives it** (delivery/spam/wrong address — unverified). |
| Same run | `Label triage failure` step fires. Runs `gh label create "triage-failed"` — but the label does not exist. The `2>/dev/null \|\| true` suppresses the error output, and `gh issue edit --add-label "triage-failed"` **also fails** silently because the label still does not exist in the repo. Issue #162 has NO failure label. |
| Next digest (10am/2pm/6pm UTC) | `daily-analysis-digest.yml` queries open `from-app` issues. Finds #162. Checks for analysis comment — none. Checks for `triage-failed` label — not present (label creation failed). Both code paths (`triage-failed` card and `awaiting-triage` card) were unreachable — the bash logic used `continue` for untriaged issues, skipping card generation entirely. Only a footnote counter was incremented. |
| Digest email delivered | Owner sees "1 bug(s) still awaiting AI analysis" as a yellow one-liner at the bottom. No title, no description, no View/Retry buttons. Not actionable. Easy to miss. |
| ~2026-03-18 | Owner's wife tells him verbally. He discovers the issue manually. |

### Root Causes

1. **Missing label (bootstrapping gap):** The `triage-failed` label was never created in the private repo. The failure handler assumed it existed. The `2>/dev/null || true` pattern — used defensively — became the enemy by hiding the real error.
2. **Digest rendering gap:** Untriaged issues with no analysis comment were treated as "not ready yet" and skipped entirely in the card loop. They incremented a counter but rendered no card, no title, no buttons — just a footnote.
3. **Email delivery unverified:** The billing alert email to OWNER_EMAIL was sent (Resend API returned 200) but was never received. Possible causes: spam filter, wrong email address in secrets, Resend domain verification issue. Never tested end-to-end.
4. **No redundant signal:** There was no secondary notification path. If the email fails, nothing else alerts the owner.

### Impact

- One real user bug was invisible for 24+ hours.
- Owner's trust in the pipeline is damaged — the $75 pipeline cost is only justified if it actually catches everything.
- If the owner's wife had not mentioned it verbally, the bug could have been invisible indefinitely.

---

## What Was Already Fixed

All items below are committed to `sortinghistory-bugs/main` and pushed, unless noted otherwise.

### 1. Digest renders untriaged/triage-failed issues as full cards (DONE)

**File:** `.github/workflows/daily-analysis-digest.yml`

- Issues with no analysis comment and no `triage-failed` label now render as **amber cards** ("Awaiting Triage") with View on GitHub and Fix Locally buttons, plus a note: "This bug has not been triaged yet. If it stays here for more than one digest cycle, something may be stuck."
- Issues with `triage-failed` label render as **red cards** ("Triage Failed") with Retry Triage, View on GitHub, and Fix Locally buttons.
- The `continue` statements that skipped untriaged issues have been removed. Every open `from-app` issue now renders a card, period.

### 2. Failure handler creates label before applying it (DONE)

**File:** `.github/workflows/bug-analysis.yml` (lines 204-216)

- The `Label triage failure` step now runs `gh label create "triage-failed" --color "dc2626" --description "Triage pipeline failed" 2>/dev/null || true` before `gh issue edit --add-label "triage-failed"`. The create is idempotent (fails silently if label exists). The edit then succeeds because the label is guaranteed to exist.

### 3. `triage-failed` label created in private repo (DONE)

- Label manually created in `RaufGlasgow/Sorting-History` with color `#dc2626`.

### 4. Retry Triage route added to worker (CODE COMPLETE, NOT DEPLOYED)

**File:** `workers/bug-webhook/src/index.ts` (line 2707)

- `/api/pipeline/retry-triage` aliased to `/api/pipeline/redo` (same `handlePipelineRedo` handler).
- GET shows a branded confirmation page. POST dispatches the `bug-analysis.yml` workflow with the issue number and removes the `triage-failed` label.
- This code exists on `feature/engagement-retention` branch but has NOT been deployed to Cloudflare.

---

## User Stories

### US-1: Worker deployment with retry-triage route
**As** the pipeline owner,
**I want** the retry-triage route deployed to Cloudflare production,
**so that** the Retry Triage button in digest emails actually works.

### US-2: Billing alert email verification
**As** the pipeline owner,
**I want** to verify that Resend billing alert emails actually reach my inbox,
**so that** I know the primary notification channel works.

### US-3: API credit depletion banner in digest
**As** the pipeline owner,
**I want** the digest email to show a prominent red banner when the pipeline is non-functional due to API billing errors,
**so that** even if I miss the individual failure email, the next digest makes it unmissable.

### US-4: Billing error detection reliability
**As** a pipeline developer,
**I want** the billing error detection in `subagent.ts` to be robust against false positives and false negatives,
**so that** real billing errors are always caught and normal responses are never misclassified.

### US-5: End-to-end failure simulation test
**As** the pipeline owner,
**I want** to be able to simulate a triage failure and verify the full chain (label applied, digest card rendered, retry button works),
**so that** I can prove the failsafe works before the next real incident.

---

## Acceptance Criteria (numbered, testable)

### AC-1: Worker deployment
1. The `bug-webhook` worker is deployed to Cloudflare with the `retry-triage` route live.
2. Hitting `https://sortinghistory.com/api/pipeline/retry-triage?issue=162&token=VALID_TOKEN` returns the branded confirmation page (HTTP 200, contains "Retry Triage" button).
3. Submitting the confirmation form dispatches the `bug-analysis.yml` workflow for the given issue number (verify via `gh run list`).

### AC-2: Billing alert email delivery
4. Send a test email from Resend using the same `from` address (`bugs@sortinghistory.com`) and same `to` address (`OWNER_EMAIL` secret) — confirm it arrives in inbox (not spam).
5. If the email does not arrive: check Resend domain verification status, check OWNER_EMAIL secret value, check spam filters. Document the fix.
6. After the fix, trigger a real failure (or use the Resend API directly) and confirm the branded "Triage Pipeline Crashed" email arrives within 5 minutes.

### AC-3: API credit depletion banner in digest
7. The digest workflow checks whether any open `from-app` issue has the `triage-failed` label, regardless of issue age.
8. If any such issues exist, the digest email includes a prominent red banner at the TOP of the email (before the regular bug cards) with: "API Pipeline Non-Functional" heading, text explaining likely cause (Anthropic credits depleted), link to Anthropic billing dashboard (`https://console.anthropic.com/settings/billing`), count of affected issues.
9. The banner is rendered even if there are zero successfully-triaged issues in the digest (the digest must never be a blank heartbeat when issues are stuck).
10. The banner is dismissed only when ALL open `triage-failed` issues are closed or relabeled. If no open issues carry the `triage-failed` label, the banner is NOT shown.

### AC-4: Billing error detection reliability
11. The `KNOWN_API_ERRORS` array in `subagent.ts` (line 472) includes at least: `"Credit balance is too low"`, `"insufficient_quota"`, `"billing"`, `"rate_limit"`.
12. The detection only fires when BOTH conditions are true: (a) `inputTokens === 0 && outputTokens === 0`, AND (b) `responseText` matches a known error string. This prevents false positives on legitimate zero-token responses (e.g., empty content).
13. When billing error is detected, the subagent result includes `error` field starting with `"API billing error:"` — this string is used downstream by the failure handler.
14. Add a unit test in `Scripts/sdk/tests/` that verifies: (a) billing error IS detected when tokens=0/0 and responseText contains "Credit balance is too low", (b) billing error is NOT detected when tokens > 0 even if responseText contains the string, (c) billing error is NOT detected when tokens=0/0 but responseText does not match any known error.

### AC-5: End-to-end failure simulation
15. A manual test procedure exists (documented in this story's Testing Plan) that can be executed by the owner to simulate a triage failure end-to-end.
16. The simulation confirms: (a) `triage-failed` label is applied to the test issue, (b) the next digest email renders a red card for the issue with Retry Triage button, (c) clicking Retry Triage dispatches a new triage workflow run, (d) if the API credit depletion banner is applicable, it appears at the top of the digest.

### AC-6: No silent failures — defense in depth
17. The `bug-analysis.yml` failure handler NEVER uses `2>/dev/null || true` on the `gh issue edit --add-label` command. The label creation can be suppressed (idempotent), but the label application must either succeed or fail the step visibly.
18. The digest rendering loop NEVER uses `continue` to skip an open `from-app` issue. Every open issue renders a card (red, amber, or standard).
19. If the `Notify on failure` email send fails (Resend returns non-200), the step logs the HTTP status and response body. It does NOT exit silently.

---

## Technical Design

### TD-1: Worker deployment

The worker source is at `workers/bug-webhook/src/index.ts` in the `SortingHistory` repo. The `retry-triage` route (line 2707) is already coded — it aliases to `handlePipelineRedo` (line 886).

**Deployment command:**
```bash
cd workers/bug-webhook
npx wrangler deploy
```

The worker is deployed to `sortinghistory.com` via Cloudflare Workers. No new secrets or bindings are needed — `AUTH_TOKEN`, `GITHUB_REPO`, and `BUGS_REPO_PAT` are already configured.

### TD-2: Billing alert email verification

Steps:
1. Read the current `OWNER_EMAIL` secret: `gh secret list --repo RaufGlasgow/sortinghistory-bugs` (confirm it exists).
2. Send a test email via Resend API:
   ```bash
   curl -X POST https://api.resend.com/emails \
     -H "Authorization: Bearer $RESEND_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"from":"bugs@sortinghistory.com","to":["OWNER_EMAIL_HERE"],"subject":"Pipeline Email Test","html":"<p>If you see this, billing alerts work.</p>"}'
   ```
3. Check inbox. If not received, check: Resend dashboard for delivery status, domain DNS (SPF/DKIM for sortinghistory.com), spam folder.

### TD-3: API credit depletion banner

**File to modify:** `.github/workflows/daily-analysis-digest.yml`

Add a new step after the issue query step (`id: query`) and before the card-building loop:

```yaml
- name: Check for pipeline health (billing errors)
  id: pipeline_health
  env:
    GH_TOKEN: ${{ secrets.PRIVATE_REPO_PAT }}
  run: |
    # Check if ANY open from-app issues have triage-failed label (no age cutoff)
    FAILED_ISSUES=$(gh api "repos/RaufGlasgow/Sorting-History/issues?labels=triage-failed,from-app&state=open&per_page=100" \
      --jq '.[].number' 2>/dev/null || echo "")
    FAILED_COUNT=$(echo "$FAILED_ISSUES" | grep -c '[0-9]' || echo "0")

    if [ "$FAILED_COUNT" -gt 0 ]; then
      echo "pipeline_degraded=true" >> "$GITHUB_OUTPUT"
      echo "failed_count=${FAILED_COUNT}" >> "$GITHUB_OUTPUT"
      BANNER="<div style=\"margin-bottom:24px;padding:20px;background:#7f1d1d;border-radius:12px;border:2px solid #dc2626;\">"
      BANNER="${BANNER}<h2 style=\"margin:0 0 8px 0;color:#fca5a5;font-size:18px;\">API Pipeline Non-Functional</h2>"
      BANNER="${BANNER}<p style=\"margin:0 0 12px 0;color:#fecaca;font-size:14px;line-height:1.5;\">Triage failed for ${FAILED_COUNT} open issue(s). This usually means <strong>Anthropic API credits are depleted</strong>.</p>"
      BANNER="${BANNER}<p style=\"margin:0 0 16px 0;color:#fecaca;font-size:14px;\">No new bugs will be triaged until credits are replenished.</p>"
      BANNER="${BANNER}<a href=\"https://console.anthropic.com/settings/billing\" style=\"display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:bold;\">Check Anthropic Billing</a>"
      BANNER="${BANNER}</div>"
      echo "$BANNER" > /tmp/pipeline_health_banner.html
    else
      echo "pipeline_degraded=false" >> "$GITHUB_OUTPUT"
      echo "failed_count=0" >> "$GITHUB_OUTPUT"
      echo "" > /tmp/pipeline_health_banner.html
    fi
```

Then inject `$(cat /tmp/pipeline_health_banner.html)` at the top of the email body, before any bug cards or the confidence attention section.

### TD-4: Billing error detection hardening

**File:** `Scripts/sdk/lib/subagent.ts` (lines 471-482)

Current detection is sound but could be tightened:

```typescript
// Current
const KNOWN_API_ERRORS = ["Credit balance is too low", "insufficient_quota", "billing"];

// Proposed — add rate_limit, keep the dual-condition guard
const KNOWN_API_ERRORS = [
  "Credit balance is too low",
  "insufficient_quota",
  "billing",
  "rate_limit",
  "exceeded your current quota",
];
```

The dual-condition guard (`tokens === 0/0 AND responseText matches`) is already correct and prevents false positives. No structural change needed — just expand the string list.

**Unit test file:** `Scripts/sdk/tests/subagent-billing.test.ts` (new file)

Test cases:
1. `tokens=0, responseText="Credit balance is too low"` => detected
2. `tokens=100/50, responseText="Credit balance is too low"` => NOT detected
3. `tokens=0, responseText="Here is my analysis of the bug..."` => NOT detected
4. `tokens=0, responseText="exceeded your current quota"` => detected

Since `spawnClaudeSubagent` is not exported directly, the test should extract the detection logic into a testable pure function (e.g., `detectBillingError(inputTokens, outputTokens, responseText): string | null`) and test that.

### TD-5: Failure handler hardening

**File:** `.github/workflows/bug-analysis.yml`

In the `Notify on failure` step, change the curl from:
```bash
curl -sf -X POST ... || echo "Email send failed (non-fatal)"
```
to:
```bash
HTTP_STATUS=$(curl -s -o /tmp/resend-response.txt -w "%{http_code}" -X POST ...)
if [ "$HTTP_STATUS" != "200" ] && [ "$HTTP_STATUS" != "201" ]; then
  echo "::warning::Resend email failed with HTTP $HTTP_STATUS"
  cat /tmp/resend-response.txt
fi
```

This ensures the failure is logged as a GitHub Actions warning (visible in the UI) rather than silently eaten.

In the `Label triage failure` step, the current code is already correct post-fix (label create is idempotent, label apply is not suppressed). Verify the `gh issue edit --add-label` does NOT have `2>/dev/null || true` on it — it currently does not (confirmed in code review).

---

## Deployment Checklist

This is ordered. Steps must be completed sequentially.

- [ ] **1. Deploy worker to Cloudflare**
  ```bash
  cd /Users/raufglagsow/AI\ Projects\ M4/Trivia\ Game/SortingHistory/workers/bug-webhook
  npx wrangler deploy
  ```
  Verify: `curl -s https://sortinghistory.com/api/pipeline/retry-triage?issue=1&token=test` returns HTML (not 404).

- [ ] **2. Verify billing alert email delivery**
  Send test email via Resend. Confirm arrival in inbox. If not received, debug Resend domain verification and OWNER_EMAIL secret.

- [ ] **3. Add `rate_limit` and `exceeded your current quota` to KNOWN_API_ERRORS**
  File: `Scripts/sdk/lib/subagent.ts` line 472.

- [ ] **4. Extract billing detection into testable function + add unit tests**
  New file: `Scripts/sdk/tests/subagent-billing.test.ts`. Run `npm test` to confirm.

- [ ] **5. Add pipeline health banner to digest workflow**
  File: `.github/workflows/daily-analysis-digest.yml`. Add step after `id: query`, inject banner HTML before bug cards.

- [ ] **6. Harden failure email logging in bug-analysis.yml**
  Replace `curl -sf ... || echo` with status-code-capturing version per TD-5.

- [ ] **7. Run end-to-end simulation**
  Follow Testing Plan below. All checks must pass.

- [ ] **8. Push all changes**
  - `sortinghistory-bugs/main` — digest workflow + SDK changes
  - `SortingHistory/feature/engagement-retention` — worker deployment (already deployed by step 1)

---

## Testing Plan

### Test 1: Retry Triage button (AC-1)

1. Open `https://sortinghistory.com/api/pipeline/retry-triage?issue=162&token=VALID_AUTH_TOKEN` in a browser.
2. Confirm: branded confirmation page appears with "Retry Triage" button and "Issue #162".
3. Click "Retry Triage".
4. Confirm: redirected to success page.
5. Run `gh run list --workflow=bug-analysis.yml --repo RaufGlasgow/sortinghistory-bugs --limit 3` and confirm a new run was dispatched for issue 162.

### Test 2: Email delivery (AC-2)

1. Send test email via Resend API (see TD-2 command).
2. Check inbox within 5 minutes.
3. If not received: check Resend dashboard (https://resend.com/emails), check spam folder, verify OWNER_EMAIL value.
4. Document result: received / not received + fix applied.

### Test 3: End-to-end failure simulation (AC-5)

**Preparation:**
1. Create a test issue in the private repo:
   ```bash
   gh issue create --repo RaufGlasgow/Sorting-History \
     --title "[TEST] Triage failure simulation — safe to close" \
     --label "from-app,needs-triage" \
     --body "This is a test issue for PIPE-010 failure simulation. Close after testing."
   ```
2. Note the issue number (e.g., #170).

**Simulate triage failure:**
3. Manually apply `triage-failed` label:
   ```bash
   gh issue edit 170 --repo RaufGlasgow/Sorting-History --add-label "triage-failed"
   ```

**Verify digest rendering:**
4. Trigger digest manually:
   ```bash
   gh workflow run daily-analysis-digest.yml --repo RaufGlasgow/sortinghistory-bugs
   ```
5. Wait for digest email. Confirm:
   - Red card appears for issue #170 with "Triage Failed" header.
   - Retry Triage button is present and links to `/api/pipeline/retry-triage?issue=170&token=...`.
   - If the pipeline health banner is implemented: it appears at the top of the email.

**Verify retry works:**
6. Click Retry Triage button in the email.
7. Confirm confirmation page appears, click the button.
8. Confirm `bug-analysis.yml` run is dispatched.

**Cleanup:**
9. Close the test issue:
   ```bash
   gh issue close 170 --repo RaufGlasgow/Sorting-History --comment "PIPE-010 test complete."
   ```

### Test 4: Billing detection unit tests (AC-4)

```bash
cd /path/to/sortinghistory-bugs/Scripts/sdk
npm test -- --grep "billing"
```

All 4 test cases must pass.

---

## Dependencies

| Dependency | Status | Blocking? |
|------------|--------|-----------|
| Cloudflare Workers access (`wrangler` auth) | Available | Yes (AC-1) |
| `AUTH_TOKEN` secret in Cloudflare Workers | Already configured | No |
| Resend API key (`RESEND_API_KEY` secret) | Already configured | Yes (AC-2) |
| `OWNER_EMAIL` secret in GitHub Actions | Already configured (but delivery unverified) | Yes (AC-2) |
| `PRIVATE_REPO_PAT` secret in GitHub Actions | Already configured | No |
| Anthropic API credits (for triage retry to succeed) | May be depleted — this story works even if depleted | No |

---

## Effort Estimate

| Task | Points | Time |
|------|--------|------|
| Worker deployment + verification | 1 | 30 min |
| Email delivery verification + fix | 1 | 30-60 min (depends on debugging) |
| Pipeline health banner in digest | 1 | 45 min |
| Billing detection hardening + unit tests | 1 | 30 min |
| Failure handler logging hardening | 0.5 | 15 min |
| End-to-end simulation test | 0.5 | 30 min |
| **Total** | **5** | **~3-4 hours** |

---

## Out of Scope

- **Slack/SMS secondary notifications:** Would add redundancy beyond email, but adds complexity and cost. Revisit if email proves unreliable after this fix.
- **Auto-replenish Anthropic credits:** Not possible via API. The owner must manually add credits.
- **Automatic retry on billing failure:** Retrying a failed triage when the API has no credits will just fail again. The correct response is to alert the human, not retry blindly.
- **Monitoring dashboard (Grafana/Datadog):** Overkill for a solo-developer pipeline. The digest email IS the monitoring dashboard.
- **Rate limiting on the retry-triage endpoint:** The endpoint requires AUTH_TOKEN — only the owner can use it. Rate limiting is unnecessary.
- **Other failure modes (GitHub API down, Resend API down):** These are transient and self-healing. The 3x/day digest cadence provides natural retry. Billing errors are the only failure mode that persists until human action is taken, which is why this story focuses on them.
