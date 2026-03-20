# PIPE-012: "Need More Info" Must Email the Reporter

**Priority:** P1 — Core pipeline flow is broken
**Points:** 5
**Branch:** `sortinghistory-bugs/main` (worker changes on Cloudflare Worker `bug-webhook`)
**Created:** 2026-03-20
**Principle:** No manual intervention. If the pipeline cannot reach the reporter without the owner opening GitHub, the button is theater.

---

## Problem Statement

The "Need More Info" button in the daily digest email opens a comment form (`/api/pipeline/comment`) where the owner types a question. The form POSTs a comment on the GitHub issue. The problem: bug reporters are end users who submitted bugs through the in-app bug report form. They never see GitHub. They do not have GitHub accounts. They will never read the comment.

The button exists to let the owner ask clarifying questions. It currently does something (posts a GitHub comment) that has zero chance of reaching the person it is meant for. The owner has no way of knowing this -- the confirmation page says the comment was posted, implying the reporter will see it. This is functionally broken.

The in-app bug report form already collects an optional contact email. The worker (`worker-utils.ts:142`) writes it into the issue body as `**Contact Email:** xxx@yyy.com`. This email exists on many issues and is never used for follow-up.

---

## Incident Reference

No specific incident -- this is a systemic design gap discovered during pipeline review. Every "Need More Info" action taken to date has been wasted effort. The GitHub comment sits unread on an issue the reporter will never visit.

---

## User Stories

**US-1:** As the pipeline owner, when I click "Need More Info" and submit a question, I want an email sent to the bug reporter so they actually receive my question.

**US-2:** As the pipeline owner, if the reporter did not provide a contact email, I want to be told clearly that the reporter is unreachable so I do not waste time writing a question that will never be read.

**US-3:** As a bug reporter, when the developer has a question about my bug, I want to receive an email with the question so I can respond without needing a GitHub account.

---

## Acceptance Criteria (numbered, testable)

**AC-1:** When the owner submits a "Need More Info" question and the issue body contains `**Contact Email:** <email>`, the worker sends an email to that address via Resend containing:
- Subject: `Question about your bug report (#<issue_number>) - Sorting History`
- The owner's question text (from the form)
- The original bug title for context
- A reply-to address that routes back to the pipeline (see AC-6)
- Styling consistent with the existing pipeline emails (dark theme, app icon, Sorting History branding)

**AC-2:** The email to the reporter includes a "Reply" link or button. The reply mechanism must be one of:
- Option A: `mailto:` link with a pre-filled subject containing the issue number (e.g., `Re: Bug #163 - Sorting History`) so the reply can be routed back
- Option B: A link to a simple web form on `sortinghistory.com/api/pipeline/reply?issue=<N>&token=<T>` that posts the reply as a GitHub issue comment

**AC-3:** When the owner submits a "Need More Info" question and the issue body does NOT contain `**Contact Email:**` (or the email field is empty), no email is sent. Instead the confirmation page displays:
- A clear warning: "No contact email on file for this bug report."
- Guidance: "The reporter cannot be reached. Consider closing this issue as insufficient information."
- The GitHub comment is still posted (AC-5), but the page makes clear that only the GitHub comment was created, not an email.

**AC-4:** The confirmation page after a successful email send displays: "Email sent to [redacted email, e.g., r***@gmail.com] and comment posted to GitHub issue #<N>."

**AC-5:** The GitHub issue comment is still posted in all cases (email sent or not) for record-keeping. The comment text includes a note indicating whether the reporter was emailed: `[Email sent to reporter]` or `[No contact email on file -- reporter not reached]`.

**AC-6:** The `from` address on the reporter email uses the Resend verified domain (e.g., `bugs@sortinghistory.com`). The `reply-to` is set to the owner's email (from `OWNER_EMAIL` secret) so the reporter can reply directly.

**AC-7:** The contact email is extracted from the issue body by parsing the markdown pattern `**Contact Email:** <email>`. The regex must handle:
- Standard format: `**Contact Email:** user@example.com`
- Email with surrounding whitespace
- Email wrapped in angle brackets: `**Contact Email:** <user@example.com>`
- Missing field (no match = no email available)

**AC-8:** The reporter email is validated as a syntactically valid email address before sending. If it looks malformed (no `@`, no domain), treat it as "no email" (AC-3 path).

**AC-9:** Rate limiting: the worker prevents sending more than 3 "Need More Info" emails per issue (tracked in KV as `nmi-count:<issue_number>`). On the 4th attempt, the confirmation page says: "Maximum follow-up emails reached for this issue. Consider closing as insufficient info or fixing locally."

---

## Technical Design

### 1. Extract Contact Email (new utility function)

Add to the worker's `handlePipelineComment` function or a shared utility:

```typescript
function extractContactEmail(issueBody: string): string | null {
  const match = issueBody.match(/\*\*Contact Email:\*\*\s*<?([^\s>]+@[^\s>]+\.[^\s>]+)>?/i);
  if (!match) return null;
  const email = match[1].trim();
  // Basic validation
  if (!email.includes('@') || !email.includes('.')) return null;
  return email;
}
```

### 2. Fetch Issue Body in Comment Handler

The current `handlePipelineComment` POST handler receives `issue` and `comment` from the form. It needs to also fetch the issue body to extract the email:

```typescript
// Fetch issue body from GitHub API
const issueData = await fetch(
  `https://api.github.com/repos/RaufGlasgow/Sorting-History/issues/${issueNumber}`,
  { headers: { Authorization: `token ${env.GITHUB_TOKEN}`, Accept: 'application/json' } }
);
const { body: issueBody, title: issueTitle } = await issueData.json();
const contactEmail = extractContactEmail(issueBody || '');
```

### 3. Send Reporter Email (via Resend)

If `contactEmail` is non-null, send the email before or in parallel with the GitHub comment:

```typescript
if (contactEmail) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Sorting History <bugs@sortinghistory.com>',
      to: contactEmail,
      reply_to: env.OWNER_EMAIL,
      subject: `Question about your bug report (#${issueNumber}) - Sorting History`,
      html: buildReporterQuestionEmail(issueNumber, issueTitle, commentText),
    }),
  });
}
```

### 4. Email Template

New function `buildReporterQuestionEmail()` using the same dark-theme styling as other pipeline emails. Content:
- App icon header
- "We have a question about your bug report"
- Bug number and title
- The owner's question (sanitized, in a styled block)
- Reply instructions (mailto link with pre-filled subject)
- Footer: "You received this because you submitted a bug report for Sorting History and provided your email address."

### 5. Confirmation Page Updates

The existing `resultHtml()` function (or equivalent) needs two variants:
- **Email sent:** Green confirmation with redacted email
- **No email:** Amber warning with "reporter unreachable" message

### 6. GitHub Comment Annotation

Modify the comment body posted to GitHub to include the email status:

```
> **Owner question (via pipeline):**
> [question text]
>
> _[Email sent to reporter]_ or _[No contact email on file]_
```

### 7. KV Rate Limiting

```typescript
const countKey = `nmi-count:${issueNumber}`;
const current = parseInt(await env.KV.get(countKey) || '0');
if (current >= 3) {
  return new Response(rateLimitHtml(issueNumber), { status: 429, headers: { 'Content-Type': 'text/html' } });
}
await env.KV.put(countKey, String(current + 1), { expirationTtl: 60 * 60 * 24 * 30 }); // 30 day TTL
```

---

## Edge Cases

1. **Reporter email is a noreply or bounce address.** Resend will accept the send but the email bounces. No mitigation in this story -- Resend bounce webhooks are a future enhancement (out of scope).

2. **Issue body was edited and email removed.** The extraction runs at comment-time against the current issue body. If someone edited the issue and removed the email, the "no email" path fires. This is correct behavior.

3. **Multiple email addresses in issue body.** The regex matches the first occurrence of the `**Contact Email:**` field. Multiple fields should not exist (the form writes one), but if they do, the first is used.

4. **Reporter replies to the email.** The reply goes to the owner's email (via `reply-to`). This is outside the pipeline -- the owner reads it in their inbox. Future: parse replies and post them as issue comments.

5. **HTML injection in the question text.** The owner's question is rendered inside the email HTML. Sanitize by escaping `<`, `>`, `&`, `"` before inserting into the template. The comment form textarea should be treated as plain text.

6. **Resend API failure.** If the Resend call fails, the GitHub comment is still posted (it runs independently). The confirmation page reports: "GitHub comment posted, but email to reporter failed. Try again or contact them manually." The comment annotation says `[Email send failed]`.

7. **KV unavailable.** If KV read fails, default to allowing the send (fail open for rate limiting). Log the KV error.

---

## Dependencies

| Dependency | Status | Blocking? |
|-----------|--------|-----------|
| Resend API key in worker secrets | Configured (`RESEND_API_KEY`) | No |
| Resend verified domain (`sortinghistory.com`) | Configured (used by thank-you emails) | No |
| Owner email in worker secrets | Configured (`OWNER_EMAIL`) | No |
| GitHub PAT in worker secrets | Configured (`GITHUB_TOKEN`) | No |
| KV namespace bound to worker | Configured (used by idempotency checks) | No |
| Bug report form writes `**Contact Email:**` | Implemented (`worker-utils.ts:142`) | No |

No new secrets or infrastructure required. All dependencies are already in place.

---

## Effort Estimate

| Component | Points | Notes |
|-----------|--------|-------|
| Email extraction + validation | 1 | Regex + basic validation |
| Reporter email template | 1 | Reuse existing email styling |
| Worker handler updates (fetch body, branch logic, send email) | 2 | Main logic change |
| Confirmation page variants + KV rate limiting | 1 | UI + KV calls |
| **Total** | **5** | Single PR to `sortinghistory-bugs` + worker deploy |

---

## Out of Scope

- **Bounce handling.** Resend bounce/complaint webhooks are not wired up. If the reporter email bounces, we do not know.
- **Reply parsing.** When the reporter replies to the email, the reply goes to the owner's inbox. Automatically posting replies as GitHub issue comments is a future story.
- **Reporter notification preferences.** There is no opt-out mechanism. The reporter provided their email in the bug report form. A future story could add unsubscribe.
- **Rich text in questions.** The owner's question is plain text only. Markdown rendering in the email is not included.
- **Localization of the reporter email.** The email is sent in English regardless of the reporter's locale. The bug report form does not capture language preference.
