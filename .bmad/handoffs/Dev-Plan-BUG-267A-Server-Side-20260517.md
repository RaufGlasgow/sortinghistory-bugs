# Dev Plan — BUG-267A Server-Granted Historian Bonus (Server Side)

**Branch:** `feat/bonus-historian-server-side` (off main)
**Date:** 2026-05-17
**Dev:** dev-bonus-server-v3 (third dispatch; prior two refused on env grounds, all resolved)
**Scope:** sortinghistory-bugs/ ONLY (server-side). iOS work is a separate later story.

## Five-bullet implementation plan

1. **Migration `migrations/0002_historian_bonus.sql`** — three tables per architect spec:
   - `historian_bonus_grants` (append-only audit) with `UNIQUE(bug_report_id, identity_hash)` for idempotency
   - `historian_bonus_claims` (HMAC token rows, `token PRIMARY KEY`, `claimed_at` nullable)
   - `historian_bonus_state` (materialized `bonus_until` per identity, `identity_hash PRIMARY KEY`)
   - All `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — idempotent re-run-safe per migration convention from `0001_bbe_init.sql`.

2. **`workers/bug-webhook/src/bonus.ts`** — new module mirroring `bbe.ts` structure. Exports:
   - `BONUS_SCHEMA_SQL` (belt-and-braces bootstrap mirror of migration 0002)
   - `initBonusSchema(env)` (one-shot idempotent)
   - `grantBonus(env, {bug_report_id, email, months_added, github_issue_num, reason, granted_by})` — transactional: insert into `_grants` (UNIQUE-constraint-protected); on conflict return existing grant; upsert `_state` with `new_bonus_until = max(now, current_bonus_until) + months_added * 30 days`; audit row.
   - `resolveBonusState(env, identity_hash)` → `{identity_hash, bonus_until, total_months, lifetime_grants, last_bug_report_id}` or null.
   - `generateClaimToken(env, grant_id, identity_hash, ttl_days=30)` — base64url JSON `{gid, ih, exp}` + HMAC-SHA256(`env.BONUS_CLAIM_HMAC_SECRET`); persisted to `_claims`.
   - `verifyClaimToken(env, token)` — constant-time HMAC verify + expiry check + DB lookup.
   - `claimBonusForDevice(env, token, idfv?)` — verify → mark `_claims.claimed_at` + `claimed_device_id` → return resolved state.
   - `lookupByEmail(env, email)` — rate-limit (PIPELINE_KV, 1/24h per `sha256(email)`); re-issue claim token via Resend; response identical whether email has grants or not (no enumeration).
   - `dispatchBonus(env, {issueNumber, labels, recipientEmail, gameLanguage, locale, confirmationId})` — replaces `bbeDispatchReward` for `reward-approved` label; orchestrates grant → token → email.
   - `sendBonusClaimEmail(env, {to, claimUrl, bonusUntil, refId})` — English template per architect spec; locale fallthrough today (BUG-267A-CLAIM-EMAIL-LOCALES-001 fills the 6 other locales).
   - All Web Crypto via `crypto.subtle.importKey` + `crypto.subtle.sign('HMAC', ...)` — same primitives the existing worker uses for the GitHub webhook signature verifier (`verifyWebhookSignature` in index.ts).

3. **`workers/bug-webhook/src/index.ts` edits** —
   - Import the new `bonus.ts` exports.
   - Extend `Env` interface: `BONUS_CLAIM_HMAC_SECRET?: string` (and reuse `BBE_DB` D1 binding).
   - **Replace the `reward-approved` label handler (line 2627-2651)**: call `bonusDispatch` instead of `bbeDispatchReward`. The current `bbeDispatchReward` call site is COMMENTED OUT with a `// LEGACY: removed next release per BUG-267A` marker but NOT deleted (one-release rollback).
   - **Add 4 new routes** to the `fetch` handler (before the 405 fallback):
     - `POST /api/bonus/claim` (HMAC token in body, returns state)
     - `GET /api/bonus/state?identity_hash=...` (public, identity-hash-keyed)
     - `POST /api/bonus/lookup-by-email` (rate-limited via PIPELINE_KV)
     - `POST /api/bonus/admin/revoke` (BBE_ADMIN_TOKEN bearer auth)
     - `POST /api/bonus/grant` (admin-only, used by backfill script)
   - CORS: `Access-Control-Allow-Origin` locked to `https://sortinghistory.com` for public endpoints. App calls from the iOS HTTP client don't need CORS (no preflight).

4. **`workers/bug-webhook/src/bonus.test.ts`** — 3 minimum tests, plus stretch:
   - HMAC token: signed token round-trips and verifies; tampered token rejected; expired token rejected.
   - `grantBonus` idempotency: same `(bug_report_id, identity_hash)` second call returns existing grant, no double-add to `_state.bonus_until`.
   - `resolveBonusState`: multiple grants for same identity stack additively from `max(now, current_bonus_until)`; chain math correct.

5. **`workers/bug-webhook/scripts/backfill-bonus-grants.ts`** — Node script (NOT a worker route; runs locally with `wrangler d1 execute` for the writes). Enumerates GH issues labeled `reward-email-sent`, parses Contact Email + confirmation ID from issue body, calls `POST /api/bonus/grant` (admin token) for each — idempotent via UNIQUE constraint. `--dry-run` default lists what WOULD be granted + email previews. `--apply` posts. Sends comp-back email on apply per architect spec Component 6. **Does not auto-run on deploy** — Ra'uf invokes manually after PM smoke.

## Files modified (preview)

| File | Type | Lines (est) |
|---|---|---|
| `workers/bug-webhook/migrations/0002_historian_bonus.sql` | NEW | ~50 |
| `workers/bug-webhook/src/bonus.ts` | NEW | ~600 |
| `workers/bug-webhook/src/bonus.test.ts` | NEW | ~200 |
| `workers/bug-webhook/src/index.ts` | EDIT | ~+80 |
| `workers/bug-webhook/wrangler.toml` | EDIT | +5 lines (secret docs only; secret itself set via `wrangler secret put`) |
| `workers/bug-webhook/scripts/backfill-bonus-grants.ts` | NEW | ~250 |

## Collateral-impact check (planned)

- `bbe.ts` `claimCode` / `dispatchReward` / `markUsed` / `sendRewardEmail` — unchanged but no longer called from the `reward-approved` handler. Kept in code marked LEGACY for one release rollback. Existing `/api/bbe/*` admin endpoints unchanged (Ra'uf can still manually send via `bbeHandleManualSend` if needed during rollover).
- BBE schema (`bug_bounty_codes`, `bug_bounty_audit`, `bug_bounty_meta`) untouched.
- `sendThankYouEmail` (ack email at intake) — unchanged. This is the FIRST email (on report-create). The reward-approved label still fires a SECOND email — now the claim email instead of the offer-code email.
- GitHub webhook signature verifier (`verifyWebhookSignature`) — reused for HMAC primitives in `bonus.ts`.
- `/api/bbe/*` and `/api/pipeline/*` route handlers — unchanged.
- `BBE_DB` binding — REUSED. No new D1 database.
