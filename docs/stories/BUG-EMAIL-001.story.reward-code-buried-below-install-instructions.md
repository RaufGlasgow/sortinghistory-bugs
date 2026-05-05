---
id: BUG-EMAIL-001
title: BBE reward email buries the redemption code under 700+ words of install instructions
status: IN-PROGRESS
severity: P2
release: webhook-deploy 2026-05-05
filed: 2026-05-05
filed-by: PM (John)
reported-by: 2 from-app reporters (issue #253 confirmation IDs BUG-MOSF5LVN-X0TVA2 and BUG-MOSKQMUL-E2IV27)
github-issue: https://github.com/RaufGlasgow/Sorting-History/issues/253
component: workers/bug-webhook/src/bbe.ts renderRewardEmail
related: BBE-001-v4 (install instructions block), BUG-229 (mitigation that added install block), BUG-EMAIL-001-LOC-FU (locale step 3 wording follow-up)
---

# BUG-EMAIL-001 - BBE reward email buries the redemption code under install instructions

## 1. Plain-English what-is-this

When a player submits a bug from the iOS app, they receive a "thank you" email containing a redemption code that gives them 2 free months of Historian subscription. The email body is structured: heading, two intro paragraphs, then a yellow box of install instructions, then a blue box with the actual code. Step 3 of the install instructions says "enter the code below" - and the code IS technically below it, but only after about 700 more words of install/troubleshooting prose (App Store install link, TestFlight coexistence, force-quit instructions, support email). Two reporters in one morning opened the email, read "enter the code below", scrolled expecting to see the code immediately, hit a wall of unrelated text, couldn't find the code, and filed bug reports asking where the code was. They felt confused and assumed the email was broken.

## 2. What's at stake / why fix now

User-trust + monetization-pipeline bug. P2. Two reporters filed in one morning (#253 with `report_count:2` per the duplicate-tracker comment). Real impact on bug-bounty redemption: every reporter who can't find their code is a player who DOESN'T redeem the 2-month Historian subscription, so the entire bug-bounty incentive program degrades. Doesn't block release directly but actively breaks the BBE-001 marketing/retention loop that you just shipped. Worth fixing today because (a) other reporters this week may hit the same wall, (b) the change is structurally tiny - swap the order of two HTML divs.

## 3. What I tried first vs what I landed on

Three approaches considered:
- **(A) Move code block to the TOP, keep install block below.** Selected. Code is the first concrete thing the user sees; install instructions still present in full. Step 3's "code below" wording is now slightly imprecise (the code is also above) but technically still satisfied. Minimum scope.
- **(B) Show code BOTH at the top AND at the bottom.** Rejected: doubles the code's visual weight unnecessarily and clutters the email.
- **(C) Rewrite step 3 wording in all 5 locales to remove the "below" reference.** Rejected for now: requires a translation handoff (LOC process per `feedback_translation_choices_loc_process_only`) and would block today's fix on translator availability. Filed BUG-EMAIL-001-LOC-FU to do this properly later.

## 4. Before vs after - what the user will see

- **Before:** Open the reward email, see heading + 2 intro paragraphs + a yellow box of install steps. Step 3 says "enter the code below". Scroll, scroll, scroll past 5 more steps and hundreds of words of troubleshooting. Eventually find the blue box with the code at the bottom. Two reporters this morning gave up before that point and filed bugs.
- **After:** Open the reward email, see heading + 2 intro paragraphs + the blue code block immediately, with the code in large monospace + the "Redeem now" button. Below it: yellow box with install instructions for users who need them. Code is visible in the first viewport on a typical iPhone email render.
- **Eventually (after BUG-EMAIL-001-LOC-FU):** Step 3 wording will be translated in 5 locales to say "enter the code shown above" or similar, removing the directional inconsistency.

## 5. What I deliberately did NOT do, and why

- **Did not translate step 3 wording in any locale.** Translation choices are LOC-process-owned per the standing rule. Filed BUG-EMAIL-001-LOC-FU. The "code below" wording becomes imprecise (code is now also above) but not wrong.
- **Did not restructure the install block contents.** That block was added intentionally by BUG-229 mitigation to combat the App Store/TestFlight redemption confusion. All 6 steps preserved verbatim.
- **Did not change the visual styling** (colors, borders, fonts) of either box. Pure structural reorder.
- **Did not deploy the Worker.** The wrangler deploy is a separate manual step; this PR only changes the source. Ra'uf or the deploy automation needs to push it live.
- **Did not change the BBE_NOTIFY plumbing** or any of the lifecycle around when the reward email fires. Pure render-time HTML reorder.

## 6. Risk + what I could not verify

- All 11 vitest cases pass (8 pre-existing + 3 new BUG-EMAIL-001 render-order assertions covering all 5 locales).
- Notification-continuity smoke: rendered the email locally with synthetic inputs, sent to raufglasgow@gmail.com via real Resend API. Resend message id `ecb2388f-cdbb-4b50-8fc0-cacc7fb0e754`, `last_event: delivered` per Resend API. Code-position-before-install verified offline (`codePos=1534, installPos=2019`).
- Did NOT visually verify the rendered email in Gmail's iPhone client or web client. Ra'uf needs to open the smoke email in his inbox and confirm the layout reads as intended.
- Did NOT verify in any other email client (Outlook, Yahoo, Apple Mail). HTML is standard; should be fine, but not visually confirmed.
- Did NOT do a non-EN smoke send. Only EN was rendered + sent. de/pt/nl/es covered by unit tests but no live render to your inbox.

## 7. Follow-up needed

- **BUG-EMAIL-001-LOC-FU** (DRAFT, not yet filed as a separate file): translate step 3 in all 5 locales to remove the directional "below" reference, since the code is now above. Mara handoff when LOC bandwidth allows.
- **Required Ra'uf action:** open the smoke email already in your inbox (subject `[SMOKE BUG-EMAIL-001] Thanks for the bug report - 2 months of Historian on us`); confirm the code block appears above the install instructions; merge PR #51 after eyeballing.
- **Deploy after merge:** `cd sortinghistory-bugs/workers/bug-webhook && wrangler deploy` to push the Worker live. Until that runs, new reporters will still get the old (broken) email layout.

---

## Acceptance Criteria

1. **AC1 (code visible at-a-glance):** The redemption code block is rendered BEFORE the install-instructions block in the HTML email body. Reader sees the code within the first viewport on a typical iPhone email render.
2. **AC2 (install instructions still present):** All 6 install steps remain in the email, in the same order, with the same EN/DE/PT/NL/ES translations. No content lost.
3. **AC3 (locale step 3 wording grace period):** The locale step 3 text still says "the code below" / "den unten stehenden Code" / "código de abajo" / "onderstaande code" / "código em baixo" - these become slightly imprecise when the code is also above. Acceptable trade-off until LOC ships translated step 3 text. LOC follow-up filed in BUG-EMAIL-001-LOC-FU.
4. **AC4 (notification continuity smoke):** Per CLAUDE.md standing rule, change touching email path requires same-commit smoke. Smoke verified Resend `last_event: delivered` to raufglasgow@gmail.com. ✓
5. **AC5 (unit test):** Added 3 vitest cases asserting `html.indexOf(codeLabel) < html.indexOf(installHeading)` for all 5 locales, plus install-steps-still-present and subject-unchanged. All 11 tests pass. ✓
6. **AC6 (no logic changes):** Pure HTML structure reorder. Plain-text fallback (`out.text`) also reordered for parity with the HTML so plain-text mail clients render the same code-first layout.

## Files changed

- `workers/bug-webhook/src/bbe.ts` - move HTML code block before install block in `renderRewardEmail`. Reorder `out.text` for parity. Replace pre-existing em-dashes with hyphens for ascii-ids lint.
- `workers/bug-webhook/src/bbe.test.ts` - add 3 render-order assertions.

## WhatsNew

Not applicable. Email-only change; no in-app surface affected.
