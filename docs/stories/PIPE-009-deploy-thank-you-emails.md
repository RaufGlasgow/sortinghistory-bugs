# PIPE-009: Deploy FR-160 Thank-You Emails to Production

**Epic:** Bug Reporter Reward Pipeline
**Prerequisites:** Resend account with verified domain, Apple offer codes generated (BLOCKED — subscription products not yet in ASC)
**Blocks:** PIPE-008 (duplicate detection assumes email-sent label exists)
**Handoff:** `.bmad/handoffs/Session-20260320-PM-BugRewardCodes-Handoff.md` — offer code process, blocker status, step-by-step for Ra'uf
**FRs Covered:** FR-160 (thank-you email), reporter reward fulfillment
**Branch:** `feature/engagement-retention` (code exists but is NOT deployed)

---

## Problem Statement

The `sendThankYouEmail` function was committed on 2026-03-17 (line 2562 of `workers/bug-webhook/src/index.ts`) but has never been merged to `main` or deployed to Cloudflare Workers. As a result, every bug reporter who includes their email gets zero acknowledgment. Issues #158, #159, and #160 all have reporter emails and received nothing. Issue #160 is literally the owner reporting that his wife submitted a bug with her email and got no response -- the feature that was supposed to handle this is sitting undeployed on a feature branch.

Beyond deployment, the code has three structural defects:

1. **No redemption mechanism.** The email promises "one month of Historian access" but contains no offer code, no deep link, no way to actually redeem anything. It is a promise with no fulfillment path.
2. **Silent failure on missing API key.** Line 2564 does `if (!env.RESEND_API_KEY || !email) return;` -- a silent no-op. If the secret is not configured (it is not -- `wrangler.toml` does not even list it in the secrets comments), every email silently vanishes with zero log output and zero GitHub issue comment. No one will ever know it failed.
3. **Missing label dependency.** The `email-sent` label does not exist in the `RaufGlasgow/Sorting-History` repo. The GitHub API returns a 422 when you try to apply a label that does not exist. This means even if the email sends successfully, the duplicate-prevention label will fail to apply, and retries will send duplicate emails.

Additionally, the `hello@sortinghistory.com` from-address requires DNS domain verification in Resend before any email will actually deliver. Without this, Resend rejects the send request with a 403.

---

## User Stories

**As a bug reporter,**
I want to receive a thank-you email with a working reward code within seconds of submitting my report,
so that I feel valued and actually get the Historian access I was promised.

**As the product owner,**
I want email delivery failures to be loudly visible in worker logs and as GitHub issue comments,
so that I know immediately when the reward pipeline is broken rather than discovering it weeks later.

**As the product owner,**
I want every reporter to get a reward regardless of whether their bug is a duplicate,
so that people are never punished for taking the time to report.

**As a non-English-speaking reporter,**
I want the thank-you email in my language (DE/PT/NL/ES),
so that the reward experience matches the localized bug reporting experience.

---

## Acceptance Criteria

1. **AC-1: Resend domain verified.** The domain `sortinghistory.com` is verified in the Resend dashboard with correct DNS records (SPF, DKIM, DMARC). Verification is confirmed by sending a test email from `hello@sortinghistory.com` that lands in inbox (not spam).

2. **AC-2: RESEND_API_KEY set as Cloudflare Worker secret.** Running `wrangler secret list` for the `bug-webhook` worker shows `RESEND_API_KEY` in the output. The `wrangler.toml` secrets comment block is updated to include `RESEND_API_KEY`.

3. **AC-3: Missing API key throws a visible error.** If `RESEND_API_KEY` is empty or undefined, the function logs `FR-160: RESEND_API_KEY not configured -- cannot send thank-you email for issue #N` at `console.error` level AND posts a comment on the GitHub issue stating the email could not be sent due to missing configuration. It does NOT silently return.

4. **AC-4: Email contains a working redemption mechanism.** Each email includes either (a) a unique Apple App Store offer code for one month of Historian, or (b) a deep link to `sortinghistory.com/redeem?code=XXXX` that activates the reward. The code is single-use and pulled from a pre-generated pool stored in KV (`PIPELINE_KV`) under key prefix `reward-code:`.

5. **AC-5: Offer code pool management.** Each unused offer code is stored as its own KV key (`reward-code:available:{index}`) to avoid race conditions on concurrent reads. To pop a code, the function calls `list({ prefix: 'reward-code:available:' , limit: 1 })`, then atomically `get`-and-`delete` the returned key. The consumed code is recorded under `reward-code:used:{issueNumber}`. If no available keys remain, the email is still sent but with a fallback message ("We'll send your reward code separately within 24 hours") and a `reward-pool-empty` label is applied to the issue to alert the product owner.
   > **Design note:** A single JSON array under one KV key was considered but rejected because two concurrent webhook invocations could `get` the same array, pop the same code, and `put` back independently -- a classic read-modify-write race. At current volume (~3-5 bugs/month) the window is negligible, but the per-key approach eliminates it entirely with no extra complexity.

6. **AC-6: email-sent label is auto-created.** Before applying the `email-sent` label, the function first calls `POST /repos/{owner}/{repo}/labels` with name `email-sent`, color `#0E8A16`, description `Thank-you email delivered to reporter`. If the label already exists (409 response), the function proceeds normally. This eliminates the 422 error on first use.

7. **AC-7: Duplicate email prevention works.** If an issue already has the `email-sent` label, the function logs a skip message and returns without sending. Verified by: submit bug, confirm email-sent label applied, re-trigger the webhook for same issue, confirm no second email.

8. **AC-8: All 5 languages produce correct emails.** Submitting bug reports with locales `en`, `de`, `de-AT`, `pt`, `pt-BR`, `nl`, `es`, `es-419` each produce an email with the correct localized subject, heading, body, reward text, and closing. The offer code line is in the reporter's language.

9. **AC-9: Email delivery is logged.** On success: `console.log` with `FR-160: Thank-you email sent to [redacted] for issue #N, code: [code]`. On failure: `console.error` with status code and error body, plus a GitHub issue comment with the redacted email and failure reason.

10. **AC-10: Worker deployed to production.** The `bug-webhook` worker is deployed via `wrangler deploy` from the merged code on `main`. The deployment is verified by submitting a test bug report with an email and confirming the thank-you email arrives.

11. **AC-11: Backfill for issues #158, #159, #160.** After deployment, manually trigger `sendThankYouEmail` for each of these three issues (or run a one-time script) so their reporters receive the reward they were promised.

12. **AC-12: wrangler.toml updated.** The secrets comment block at the bottom of `wrangler.toml` includes `RESEND_API_KEY` so future developers know it is required.

13. **AC-13: Label application errors are logged.** All `.catch(() => {})` on label application calls (e.g., the `email-sent` label, the `reward-pool-empty` label) are replaced with proper error logging: `console.error` with the label name, issue number, and HTTP status. Silent `.catch(() => {})` swallows are not permitted -- consistent with the "no silent failures" principle established in PIPE-010.

---

## Technical Design

### 1. Fix silent failure (AC-3)

Replace line 2564:
```typescript
// BEFORE (silent failure)
if (!env.RESEND_API_KEY || !email) return;

// AFTER (loud failure)
if (!email) {
  console.log(`FR-160: No email provided for issue #${issueNumber}, skipping`);
  return;
}
if (!env.RESEND_API_KEY) {
  console.error(`FR-160: RESEND_API_KEY not configured -- cannot send thank-you email for issue #${issueNumber}`);
  await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'SortingHistory-Bug-Webhook' },
      body: JSON.stringify({ body: `\u26a0\ufe0f FR-160: Thank-you email NOT sent -- RESEND_API_KEY is not configured. Reporter email is on file.` }),
    }
  ).catch(err => {
    console.error(`FR-160: Failed to post missing-key comment on issue #${issueNumber}:`, err);
  });
  return;
}
```

### 2. Add offer code retrieval (AC-4, AC-5)

Before composing the email HTML, pop a code from KV using atomic get-and-delete on individual keys:
```typescript
// Pop reward code from KV (one key per code -- no read-modify-write race)
let rewardCode: string | null = null;
let poolEmpty = false;
try {
  const list = await env.PIPELINE_KV.list({ prefix: 'reward-code:available:', limit: 1 });
  if (list.keys.length > 0) {
    const key = list.keys[0].name;
    rewardCode = await env.PIPELINE_KV.get(key);
    await env.PIPELINE_KV.delete(key); // atomic removal -- no other request can pop this key
    if (rewardCode) {
      await env.PIPELINE_KV.put(`reward-code:used:${issueNumber}`, JSON.stringify({
        code: rewardCode,
        email: email,
        sentAt: new Date().toISOString(),
      }));
    } else {
      poolEmpty = true;
    }
  } else {
    poolEmpty = true;
  }
} catch (err) {
  console.error('FR-160: Failed to retrieve reward code from KV:', err);
  poolEmpty = true;
}
```

Inject the code (or fallback message) into the email HTML inside the reward `<div>`:
```typescript
const redeemLine = rewardCode
  ? `<p style="margin-top: 12px;"><strong>${redeemLabel}:</strong> <code style="...">${rewardCode}</code></p>
     <p style="font-size: 13px; color: #666;">${redeemInstructions}</p>`
  : `<p style="margin-top: 12px; color: #c0392b;"><em>${fallbackMessage}</em></p>`;
```

Each language needs `redeemLabel`, `redeemInstructions`, and `fallbackMessage` strings (same pattern as existing `subject`/`heading`/`bodyText`/`rewardText`/`closing` localization).

If `poolEmpty`, apply `reward-pool-empty` label to the issue.

### 3. Auto-create email-sent label (AC-6)

Before applying the label, ensure it exists:
```typescript
// Ensure email-sent label exists (idempotent -- 422 means it already exists)
await fetch(
  `https://api.github.com/repos/${env.GITHUB_REPO}/labels`,
  {
    method: 'POST',
    headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'SortingHistory-Bug-Webhook' },
    body: JSON.stringify({ name: 'email-sent', color: '0E8A16', description: 'Thank-you email delivered to reporter' }),
  }
).then(res => {
  if (!res.ok && res.status !== 422) {
    console.error(`FR-160: Failed to create email-sent label for issue #${issueNumber}: ${res.status}`);
  }
}).catch(err => {
  console.error(`FR-160: Label creation request failed for issue #${issueNumber}:`, err);
}); // 422 = already exists, fine
```

Place this call once at the top of `sendThankYouEmail`, before the duplicate check at line 2624. The GitHub API returns 422 if the label already exists, which is harmless.

### 4. Resend domain verification (AC-1)

DNS records required (added to `sortinghistory.com` zone in Cloudflare):

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| TXT | `sortinghistory.com` | `v=spf1 include:_spf.resend.com ~all` | SPF |
| CNAME | `resend._domainkey` | Value from Resend dashboard | DKIM |
| TXT | `_dmarc` | `v=DMARC1; p=none;` (minimum) | DMARC |

Exact DKIM value comes from the Resend dashboard after adding the domain.

### 5. Offer code pool seeding

Apple App Store offer codes are generated in App Store Connect (up to 25,000 per offer per quarter). The codes are bulk-loaded into KV:

```bash
# One-time seeding script (run locally) -- writes one KV key per code
cd workers/bug-webhook
i=0; while IFS= read -r code; do
  [ -z "$code" ] && continue
  wrangler kv:key put --binding PIPELINE_KV "reward-code:available:$i" "$code"
  i=$((i + 1))
done < codes.txt
echo "Seeded $i reward codes."
```

A monitoring check in the digest workflow should warn when the pool drops below 10 codes.

### 6. Backfill script (AC-11)

After deployment, run manually or via `wrangler tail` + curl:
```bash
# For each missed issue, call the worker's internal endpoint or run:
curl -X POST "https://sortinghistory.com/api/bug/backfill-email" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"issues": [158, 159, 160]}'
```

This requires adding a small `/api/bug/backfill-email` route that looks up the reporter email from the issue body and calls `sendThankYouEmail`. Alternatively, trigger manually via `wrangler` CLI by temporarily invoking the function.

---

## Deployment Checklist

Ordered. Each step depends on the previous.

1. **Create Resend account** at https://resend.com. Free tier allows 100 emails/day (sufficient for bug volume).
2. **Add domain** `sortinghistory.com` in Resend dashboard (Domains > Add Domain). Copy the DNS records provided.
3. **Add DNS records** in Cloudflare dashboard for `sortinghistory.com` zone (SPF TXT, DKIM CNAME, DMARC TXT). Wait for verification (usually < 5 minutes with Cloudflare).
4. **Copy Resend API key** from Resend dashboard (API Keys > Create API Key, name it `bug-webhook-production`, permission: sending only).
5. **Set Cloudflare Worker secret:**
   ```bash
   cd "/Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory/workers/bug-webhook"
   wrangler secret put RESEND_API_KEY
   # Paste the API key when prompted
   ```
6. **Generate Apple offer codes** in App Store Connect: Subscriptions > Historian Monthly > Offer Codes > Create. Generate 50 codes to start.
7. **Seed the KV reward pool** (one key per code to avoid race conditions):
   ```bash
   cd "/Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory/workers/bug-webhook"
   # Put codes in a file, one per line
   i=0; while IFS= read -r code; do
     [ -z "$code" ] && continue
     wrangler kv:key put --binding PIPELINE_KV "reward-code:available:$i" "$code"
     i=$((i + 1))
   done < codes.txt
   echo "Seeded $i reward codes."
   ```
8. **Apply code fixes** (AC-3 silent failure fix, AC-4 offer code retrieval, AC-6 label auto-creation) on `feature/engagement-retention`.
9. **Merge** `feature/engagement-retention` into `main` (or cherry-pick the email-related changes).
10. **Deploy worker:**
    ```bash
    cd "/Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory/workers/bug-webhook"
    wrangler deploy
    ```
11. **Verify deployment** by submitting a test bug report from the iOS app with a known email address. Confirm: (a) email arrives within 30 seconds, (b) email contains a valid offer code, (c) `email-sent` label is applied to the issue, (d) worker logs show the send confirmation.
12. **Backfill issues #158, #159, #160** using the backfill mechanism described in Technical Design section 6.
13. **Update `wrangler.toml`** secrets comment to include `RESEND_API_KEY`.

---

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| `RESEND_API_KEY` not set | Loud error log + GitHub issue comment. Email not sent. No silent swallow. |
| Reporter provides no email | `console.log` skip message. No error. No issue comment. |
| `email-sent` label does not exist in repo | Auto-created on first use (green, with description). |
| Label already exists | 422 from GitHub ignored gracefully. |
| Reward code pool is empty | Email sent with fallback message ("We'll send your code within 24 hours"). `reward-pool-empty` label applied to issue. |
| KV read/write fails | Email sent without code (same fallback). Error logged. |
| Resend returns 403 (domain not verified) | Error logged. GitHub issue comment posted with status code. |
| Resend returns 429 (rate limit) | Error logged. GitHub issue comment posted. Retry on next webhook trigger (no `email-sent` label = not marked as sent). |
| Duplicate webhook trigger for same issue | `email-sent` label check prevents second email. Log says "skipping duplicate." |
| Reporter email is malformed | Resend rejects it. Error logged. GitHub issue comment posted. |
| Locale is `nil` or unrecognized | Falls through to English (existing behavior, correct). |
| Locale is `es-419` or `es-MX` | `lang.startsWith('es')` matches. Spanish email sent (existing behavior, correct). |
| Reporter submits duplicate bug (PIPE-008 future) | Still gets their own email and reward code. Duplicate detection is issue-level, not reporter-level. |

---

## Dependencies

| Dependency | Owner | Status | Blocks |
|------------|-------|--------|--------|
| Resend account + verified domain | Ra'uf (manual) | NOT DONE | AC-1, AC-2, AC-10 |
| `RESEND_API_KEY` Cloudflare secret | Ra'uf (manual) | NOT DONE | AC-2, AC-10 |
| Subscription group + Historian Monthly product in ASC | ASR team / Ra'uf | NOT DONE (BLOCKER) | AC-4, AC-5 |
| Apple review of subscription product | Apple | NOT DONE (BLOCKER) | AC-4, AC-5 |
| First batch of 100 offer codes generated (CSV from Ra'uf) | Ra'uf | BLOCKED on above | AC-4, AC-5 |
| `feature/engagement-retention` merged to `main` | Integration team | NOT DONE | AC-10 |
| `wrangler` CLI authenticated | Ra'uf | DONE (assumed) | AC-10 |
| `PIPELINE_KV` namespace | Already bound | DONE | AC-5 |
| GitHub PAT with issues:write | Already configured | DONE | AC-6, AC-7 |

---

## Effort Estimate

| Task | Points | Hours |
|------|--------|-------|
| Fix silent failure (AC-3) | 1 | 0.5 |
| Offer code retrieval + KV pool (AC-4, AC-5) | 3 | 2 |
| Localize redemption strings (5 languages) | 1 | 1 |
| Auto-create label (AC-6) | 1 | 0.5 |
| Backfill route + auth + error handling (AC-11) | 2 | 1 |
| Replace silent `.catch(() => {})` with logging (AC-13) | 1 | 0.5 |
| Resend setup + DNS + secret (AC-1, AC-2) | -- | 1 (manual) |
| Apple offer code generation + KV seeding | -- | 1 (manual) |
| Integration testing + deployment (AC-10) | 1 | 1 |
| **Total** | **10** | **~8.5 hours** |

10 story points. ~1.5 days of dev work + ~2 hours of manual setup (Resend, Apple, Cloudflare secrets).

---

## Out of Scope

- **Email analytics/open tracking.** Resend provides this natively. Not wiring it into the digest yet.
- **Unsubscribe mechanism.** These are transactional one-time emails, not marketing. CAN-SPAM does not require unsubscribe for transactional mail.
- **HTML email testing across clients.** The existing template uses inline styles and a simple layout. Good enough for v1.
- **Automated offer code generation.** Apple does not have an API for this. Codes are manually generated in App Store Connect and bulk-loaded into KV.
- **PIPE-008 duplicate detection integration.** That story handles consolidating duplicate issues. This story ensures every reporter gets an email regardless of duplicates. They are complementary, not dependent.
- **Email template versioning or A/B testing.** Ship one template, iterate later.
- **Reward code expiration tracking.** Apple offer codes have their own expiration policy managed in App Store Connect. Not tracking expiry in KV for v1.
