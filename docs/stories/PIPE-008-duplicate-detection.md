# PIPE-008: Duplicate Bug Report Detection & Consolidation

**Epic:** Pipeline Reliability & Cost Reduction
**Prerequisites:** None (operates on existing webhook + triage infrastructure)
**Soft dependency:** PIPE-009 (Resend email integration) -- see Dependencies §6
**Blocks:** Nothing (standalone improvement)
**FRs Covered:** Duplicate issue reduction, reporter reward continuity, prioritization signal

---

## Problem Statement

Every bug report submitted from the iOS app creates a new GitHub issue unconditionally. If 10 users encounter the same crash on the Daily Challenge screen, the repo gets 10 separate issues with labels `from-app` and `needs-triage`. Each one triggers the triage pipeline (AI classification via Anthropic API), generating redundant cost. Each one appears as a separate line item in the 3x-daily digest email, hiding signal in noise. The product owner must manually identify and close duplicates.

With the pipeline already at $75 spent and zero successful automated fixes, every unnecessary triage call is wasted money. More importantly, duplicate issues dilute prioritization: a bug reported by 8 users looks the same as a bug reported by 1 user because there is no aggregation signal.

---

## User Stories

**As a product owner,**
I want duplicate bug reports automatically consolidated into a single issue,
so that I can see how many users are affected and prioritize accordingly.

**As a bug reporter,**
I want to receive my thank-you email and Historian reward code even if someone else already reported the same bug,
so that I am not penalized for helping.

**As the triage pipeline,**
I want to only classify each unique bug once,
so that API costs are not wasted on redundant triage runs.

**As a digest email reader,**
I want to see "N users reported this" on each bug card,
so that I can immediately identify high-impact issues.

---

## Acceptance Criteria

### Fingerprint Generation

1. **AC-1:** The worker computes a deterministic "bug fingerprint" from each incoming report using: `currentScreen` (normalized to lowercase, trimmed) + first 100 characters of `description` (lowercased, stripped of punctuation and extra whitespace). The fingerprint is a hex-encoded SHA-256 hash of the concatenated string.

2. **AC-2:** If `currentScreen` is missing or empty, the fingerprint uses `"unknown"` as the screen component. If `description` is under 100 characters, it uses the full description. This ensures every report gets a fingerprint regardless of completeness.

### Duplicate Lookup via KV

3. **AC-3:** Before creating a GitHub issue, the worker checks `PIPELINE_KV` for key `dedup:{fingerprint}`. If a value exists and is less than 7 days old, the report is classified as a duplicate.

4. **AC-4:** When a new (non-duplicate) issue is created, the worker writes to `PIPELINE_KV` key `dedup:{fingerprint}` with value `{ issueNumber, issueUrl, createdAt, reportCount: 1 }` and a TTL of 7 days (604800 seconds).

5. **AC-5:** The 7-day dedup window is a named constant (`DEDUP_WINDOW_SECONDS = 604800`) so it can be tuned without a code change.

### Duplicate Handling

6. **AC-6:** When a duplicate is detected, the worker does NOT create a new GitHub issue. Instead it:
   - Increments `reportCount` in the KV entry and writes it back (same TTL refreshed)
   - Posts a comment on the original issue: `"Duplicate report received (total: {reportCount} reporters). Reporter: {email or 'anonymous'}. Confirmation ID: {confirmationId}."`
   - Returns HTTP 201 to the app with `{ success: true, confirmation_id, issue_number: <original>, issue_url: <original>, message: "Bug report linked to existing issue", duplicate: true }`

7. **AC-7:** The duplicate reporter receives a thank-you email with a Historian reward code, identical to the first reporter. The `sendThankYouEmail()` call fires regardless of duplicate status. The email includes the original issue number, not a new one.

8. **AC-8:** If the comment-on-original API call fails (e.g., issue was closed/deleted), the worker falls back to creating a NEW issue as if no duplicate existed, and logs a warning. The failsafe is always human visibility -- no report is silently dropped.

### Digest Integration

9. **AC-9:** The worker maintains a **dedicated "Duplicate Tracker" comment** on the original issue containing a machine-readable report count marker: `<!-- report_count:{N} -->`. The digest workflow parses this comment to display "N users reported this" on the card. Using a dedicated comment (rather than editing the issue body) avoids race conditions if the issue owner manually edits the body between duplicate reports.

10. **AC-10:** When the worker updates `reportCount`, it finds the existing "Duplicate Tracker" comment (identified by the `<!-- report_count:` marker) via `GET /repos/{repo}/issues/{number}/comments` and PATCHes it. If no tracker comment exists yet (i.e., this is the first duplicate), the worker creates one. The comment body format is: `**Duplicate Tracker** <!-- report_count:{N} -->\n\nThis issue has been reported by {N} users.` The worker never edits the original issue body for dedup purposes.

11. **AC-11:** The digest email template renders `"{N} users reported this"` next to any issue where the report count marker is > 1. Issues with no marker or marker = 1 display nothing extra.

### No AI Involved

12. **AC-12:** Zero AI/LLM API calls are made for duplicate detection. The entire dedup logic is deterministic string hashing via SHA-256. No Anthropic API, no OpenAI, no embedding similarity.

### Duplicate Observability

13. **AC-13:** When a duplicate is detected, the worker adds the label `duplicate-report` to the original issue (if not already present) and logs a structured line: `[DEDUP] Duplicate detected — fingerprint={fingerprint} original_issue={issueNumber} report_count={reportCount}`. This enables measuring dedup effectiveness after deployment via log queries and label filters.

### Triage Bypass for Duplicates

14. **AC-14:** The `dispatchAnalysis()` call (which triggers AI triage in the `sortinghistory-bugs` repo) is NOT fired for duplicate reports. Only the first report triggers triage. This directly saves API cost.

---

## Technical Design

### 1. Fingerprint Function (in `workers/bug-webhook/src/index.ts`)

```typescript
const DEDUP_WINDOW_SECONDS = 604800; // 7 days

function computeBugFingerprint(report: BugReport): string {
  const screen = (report.deviceInfo?.currentScreen || 'unknown').toLowerCase().trim();
  const desc = report.description
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // strip punctuation
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim()
    .substring(0, 100);
  const raw = `${screen}|${desc}`;
  // Use Web Crypto API (available in Cloudflare Workers)
  // Return hex-encoded SHA-256
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

### 2. KV Schema

**Key:** `dedup:{sha256hex}`
**Value (JSON):**
```json
{
  "issueNumber": 42,
  "issueUrl": "https://github.com/RaufGlasgow/Sorting-History/issues/42",
  "createdAt": "2026-03-19T12:00:00Z",
  "reportCount": 3,
  "fingerprint": "abc123..."
}
```
**TTL:** 604800 seconds (7 days), refreshed on each duplicate hit.

Uses the existing `PIPELINE_KV` namespace already bound in the worker -- no new KV namespace needed.

### 3. Modified Bug Report Flow

```
App submits POST /bug-report
  -> validateBugReport()
  -> computeBugFingerprint(report)
  -> PIPELINE_KV.get("dedup:{fingerprint}")
  -> IF exists and < 7 days old:
       increment reportCount, KV.put() with refreshed TTL
       comment on original issue (fire-and-forget via ctx.waitUntil)
       upsert Duplicate Tracker comment with report_count marker (fire-and-forget)
       add `duplicate-report` label to original issue if not present (fire-and-forget)
       send thank-you email (fire-and-forget, same as non-duplicate)
       return 201 { duplicate: true, issue_number: original }
  -> ELSE:
       upload screenshot (existing)
       createGitHubIssue() (existing)
       KV.put("dedup:{fingerprint}", { issueNumber, ... }, { expirationTtl: 604800 })
       dispatchAnalysis() (existing, triage trigger)
       send thank-you email (existing)
       return 201 { duplicate: false }
```

### 4. Comment on Original Issue

```typescript
async function commentOnOriginalIssue(
  env: Env,
  issueNumber: number,
  reportCount: number,
  confirmationId: string,
  email?: string
): Promise<boolean> {
  const reporter = email || 'anonymous';
  const body = `**Duplicate report received** (total: ${reportCount} reporters)\n\nReporter: ${reporter}\nConfirmation ID: \`${confirmationId}\``;
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ body }),
    }
  );
  return resp.ok;
}
```

### 5. Duplicate Tracker Comment (Upsert)

When a duplicate is detected, the worker lists comments on the original issue via `GET /repos/{repo}/issues/{number}/comments` and searches for one containing `<!-- report_count:`. If found, it PATCHes that comment with the updated count. If not found (first duplicate), it POSTs a new comment. The comment body format: `**Duplicate Tracker** <!-- report_count:{N} -->\n\nThis issue has been reported by {N} users.` This is fire-and-forget via `ctx.waitUntil()`. The worker never edits the original issue body, avoiding race conditions with manual owner edits.

### 6. Duplicate Report Label

When a duplicate is detected, the worker adds the `duplicate-report` label to the original issue via `POST /repos/{repo}/issues/{number}/labels` (idempotent -- GitHub ignores the call if the label is already present). The label must be pre-created in the repo. The worker also emits a structured log line: `[DEDUP] Duplicate detected — fingerprint={fingerprint} original_issue={issueNumber} report_count={reportCount}`.

### 7. Digest Template Change

In `sortinghistory-bugs/.github/workflows/daily-analysis-digest.yml`, the issue-rendering step fetches comments for each issue, finds the Duplicate Tracker comment by matching `<!-- report_count:(\d+) -->`, and if found with count > 1, appends a badge: `<span style="color:#e67e22;font-weight:bold;">{N} users reported this</span>`.

---

## Edge Cases

### Different languages, same bug
A German user writes "Spiel stuerzt ab auf Tagesherausforderung" and an English user writes "Game crashes on Daily Challenge". These produce DIFFERENT fingerprints because the description text differs. They will create separate issues. This is acceptable -- the triage pipeline already classifies by label, and a human can merge them during triage review. Attempting cross-language semantic matching would require AI (out of scope and too expensive).

### Similar but not identical descriptions
"App crashes when I open daily challenge" vs. "App crashes when opening the daily challenge screen" on the same `currentScreen` will produce different fingerprints (the first 100 chars differ after normalization). This is a deliberate false-negative tradeoff: deterministic hashing will miss some near-duplicates, but it will never produce false positives (grouping unrelated bugs). False negatives are safe -- they just create an extra issue that a human can close. False positives would be dangerous -- they would hide a distinct bug.

### Same screen, completely different bugs
Two different bugs both occurring on `DailyChallengeView` but with different descriptions (e.g., "timer freezes" vs. "leaderboard shows wrong score") produce different fingerprints. Correctly treated as separate issues.

### Reporter with no email
The thank-you email is already conditional on `report.email` existing. For duplicates, the same guard applies. The comment on the original issue says "anonymous" for the reporter.

### Original issue was closed or deleted
If the comment POST returns 404 or 410, the fallback creates a new issue normally (AC-8). The KV entry is also deleted so future reports do not try to link to a dead issue.

### KV race condition (two identical reports at the same millisecond)
Cloudflare KV is eventually consistent. Two simultaneous identical reports could both see "no existing entry" and both create issues. This is acceptable -- it means at worst one extra issue, which is no worse than the current behavior. The second KV write wins, and subsequent duplicates will consolidate correctly.

### KV entry expires mid-wave
If a bug is reported on day 1, the KV entry expires on day 8, and user reports the same bug on day 9, a new issue is created. This is correct -- a 7-day gap suggests it may be a regression or a different build, and a fresh issue is appropriate.

### Report count overflow
`reportCount` is a number in JSON. Even at 10,000 reports, this is well within safe integer range. No special handling needed.

---

## Dependencies

1. **`PIPELINE_KV` already bound** -- Yes, confirmed in the worker's `Env` interface (line 23 of `index.ts`). Already used for pipeline action idempotency. No new binding needed.

2. **Web Crypto API** -- Available in Cloudflare Workers runtime natively. No npm dependency.

3. **GitHub API permissions** -- The existing `GITHUB_TOKEN` PAT already has `issues: write` (it creates issues). Posting comments and editing issue bodies uses the same permission. No new token needed.

4. **FR-160 thank-you email** -- Currently listed as "broken" in project context. This story does NOT fix FR-160. It only ensures `sendThankYouEmail()` is called for duplicates the same way it is for originals. When FR-160 is fixed, duplicates automatically benefit.

5. **Digest workflow** -- Requires a minor template change to parse the `report_count` marker from the Duplicate Tracker comment. This is a self-contained change within this story.

6. **PIPE-009 (Resend email integration) -- soft dependency.** AC-7 promises duplicate reporters receive a thank-you email, but `sendThankYouEmail()` silently returns when `RESEND_API_KEY` is missing. Without PIPE-009 shipped first (or simultaneously), the email promise is hollow. PIPE-008 can ship independently -- the dedup logic works regardless -- but the reporter-facing email reward only functions once PIPE-009 lands.

---

## Effort Estimate

**Medium (M)** -- 2-3 days of implementation.

Justification:
- Fingerprint function: ~30 lines, straightforward (S)
- KV read/write with TTL: ~40 lines, uses existing binding (S)
- Branching logic in the main handler: ~50 lines, moderate refactor of the bug report flow (M)
- Comment upsert + label + log line GitHub API calls: ~80 lines, new but follows existing patterns (S-M)
- Digest template parsing (comment-based): ~25 lines (S)
- Testing: Manual + unit tests for fingerprint function, KV mock for dedup logic (M)
- No new infrastructure, no new secrets, no new KV namespace.

---

## Out of Scope

1. **AI/embedding-based similarity matching** -- Too expensive, too unreliable. Deterministic hashing only.
2. **Cross-language duplicate detection** -- Would require translation or embeddings. Not worth the cost. Humans merge these during triage.
3. **Retroactive dedup of existing issues** -- This story only prevents future duplicates. A backfill script could be a separate story if needed.
4. **Fixing FR-160 (thank-you email)** -- That is a separate bug. This story ensures the call is made; whether it succeeds depends on FR-160's fix.
5. **Screenshot similarity matching** -- Comparing screenshots for visual duplicates is complex and expensive. Out of scope.
6. **User-facing duplicate notification in the app** -- The app receives `duplicate: true` in the response, but this story does not mandate any UI change in the iOS app. A future story could show "This bug has already been reported -- thanks for confirming!" in the app.
7. **Merging duplicate issues after the fact** -- If two issues are created (race condition or different wording), manually merging them is out of scope. The digest shows report counts; the human triager handles the rest.
8. **Rate limiting per-user** -- A separate concern. This story handles duplicate content, not abusive senders.
