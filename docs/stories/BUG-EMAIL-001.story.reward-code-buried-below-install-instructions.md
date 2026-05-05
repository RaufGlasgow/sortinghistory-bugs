---
id: BUG-EMAIL-001
title: BBE reward email buries the redemption code under 700+ words of install instructions
status: IN-PROGRESS
severity: P2
release: webhook-deploy 2026-05-05
filed: 2026-05-05
filed-by: PM (John)
reported-by: 2 from-app reporters (issue #253 confirmation IDs BUG-MOSF5LVN-X0TVA2 and BUG-MOSKQMUL-E2IV27, plus Ra'uf himself)
github-issue: https://github.com/RaufGlasgow/Sorting-History/issues/253
component: workers/bug-webhook/src/bbe.ts renderRewardEmail
related: BBE-001-v4 (install instructions block), BUG-229 (mitigation that added install block)
---

# BUG-EMAIL-001 - BBE reward email buries the redemption code under install instructions

## Repro

1. Submit a from-app bug via the iOS app
2. Receive the BBE reward email titled "Thanks for the bug report - 2 months of Historian on us"
3. Read the email top-to-bottom: heading, 2 intro paragraphs, then a yellow "Before redeeming this code:" block with 6 numbered install/troubleshooting steps (~700 words including App Store install URL, TestFlight coexistence, force-quit instructions, support email)
4. Step 3 of the install block reads: "Then redeem the code. Open the App Store app -> tap your profile photo (top right) -> tap Redeem Gift Card or Code -> **enter the code below**."
5. Reader scrolls down expecting the code immediately after step 3, but the code block is rendered AFTER all 6 install steps complete and a styled div boundary closes
6. Code block is `Your code: 88AXXFWW6RM38L8WNX [Redeem now]`, blue-bordered

Reporter's verbatim title (#253): "Just started program the email have have the Ward code" - paraphrased: "Just started [the rewards] program. The email [should] have [the re]ward code [but I can't find it]."

## Root Cause

`renderRewardEmail` in `workers/bug-webhook/src/bbe.ts:408-608` assembles the HTML in this order:

1. Heading
2. Intro body paragraphs
3. **Install-instructions block** (yellow div, 6 numbered steps, ~700 words)
4. **Code block** (blue div, the actual code + CTA button)
5. Footnote
6. Signoff

The instructions reference the code via "enter the code below" (step 3), which is technically true (the code IS below the install block) but visually misleading: readers expect "below" to mean "the next thing visible," not "after 700 more words of unrelated prose."

Two reporters filed #253 in the same morning (2026-05-05) reporting the same confusion.

## Acceptance Criteria

1. **AC1 (code visible at-a-glance):** The redemption code block is rendered BEFORE the install-instructions block in the HTML email body. Reader sees the code within the first viewport on a typical iPhone email render.
2. **AC2 (install instructions still present):** All 6 install steps remain in the email, in the same order, with the same EN/DE/PT/NL/ES translations. No content lost.
3. **AC3 (locale step 3 wording grace period):** The locale step 3 text still says "the code below" / "den unten stehenden Code" / "código de abajo" / "onderstaande code" / "código em baixo" - these become slightly imprecise when the code is also above. Acceptable trade-off until LOC ships translated step 3 text. LOC follow-up filed in BUG-EMAIL-001-LOC-FU.
4. **AC4 (notification continuity smoke):** Per CLAUDE.md standing rule, change touching email path requires same-commit smoke. Smoke: import `renderRewardEmail`, render with synthetic inputs, send rendered HTML to raufglasgow@gmail.com via Resend, verify code block appears above install block in actual delivered email.
5. **AC5 (unit test):** Add a vitest case that renders the email and asserts `html.indexOf(codeLabel) < html.indexOf(installHeading)` for at least the EN locale.
6. **AC6 (no logic changes):** Pure HTML structure reorder. No changes to email-locale selection, code generation, redemption URL construction, or the install instructions text itself.

## Files to change

- `workers/bug-webhook/src/bbe.ts` - move code block (current lines 575-578) to BEFORE the install block (current lines 571-574)
- `workers/bug-webhook/src/bbe.test.ts` - add render-order assertion

## Out of scope

- Translating step 3 of locale install steps to remove "below" references (LOC follow-up BUG-EMAIL-001-LOC-FU; not blocking the structural fix)
- Restructuring the install block contents (BBE-001-v4 / BUG-229 mitigation, intentional)
- Changing the visual styling of the code block (blue border kept as-is)

## WhatsNew

Not applicable. Email-only change; no in-app surface affected.
