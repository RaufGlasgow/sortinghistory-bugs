/**
 * BUG-267A — Server-Granted Historian Bonus
 *
 * Replaces the broken ASC offer-code path. Apple silently no-ops
 * FREE_TRIAL + FREE_TRIAL stacking on an active intro trial, so we move
 * the reward off Apple's offer-code primitive entirely.
 *
 * The new model:
 *  - Server-side bonus rows live in Cloudflare D1 (binding BBE_DB,
 *    same `bbe-rewards` database used by BBE-002).
 *  - The `reward-approved` label handler calls `grantBonus()` instead of
 *    `claimCode()` + offer-code email.
 *  - The reward email contains a one-time HMAC-signed claim deep link.
 *  - On tap, the iOS app POSTs the token to /api/bonus/claim and persists
 *    the resolved identity_hash to Keychain. Subsequent launches poll
 *    /api/bonus/state and compose `effectiveTier = max(storeKit, bonus)`.
 *
 * Architect spec:
 *   docs/architecture/BUG-267A-SERVER-GRANTED-REWARD-ARCHITECT-DESIGN.md
 * Story:
 *   docs/stories/BUG-267A.story.bug-reward-code-fails-to-extend-trial.md
 */

import type { D1DatabaseLike, D1PreparedStatementLike } from './bbe';

// ---------------------------------------------------------------------------
// Environment + types
// ---------------------------------------------------------------------------

export interface BonusEnv {
  BBE_DB: D1DatabaseLike;
  BONUS_CLAIM_HMAC_SECRET: string;
  RESEND_API_KEY?: string;
  BBE_ADMIN_TOKEN?: string;
  BBE_ALERT_EMAIL?: string;
  /** Public base URL used to build claim deep-links. Defaults to https://sortinghistory.com */
  BONUS_CLAIM_BASE_URL?: string;
  /** PIPELINE_KV for rate-limiting lookup-by-email. */
  PIPELINE_KV?: { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> };
}

export interface BonusGrantInput {
  bug_report_id: string;
  email: string;
  months_added: number;
  github_issue_num?: number;
  reason?: string;
  granted_by: string;
}

export interface BonusGrantRow {
  id: number;
  granted_at: number;
  identity_hash: string;
  email_plaintext: string;
  bug_report_id: string;
  github_issue_num: number | null;
  months_added: number;
  reason: string | null;
  granted_by: string;
}

export interface BonusStateRow {
  identity_hash: string;
  bonus_until: number;
  total_months: number;
  lifetime_grants: number;
  last_bug_report_id: string | null;
  updated_at: number;
}

export interface BonusClaimRow {
  token: string;
  grant_id: number;
  identity_hash: string;
  issued_at: number;
  expires_at: number;
  claimed_at: number | null;
  claimed_device_id: string | null;
  revoked_at: number | null;
}

export interface ResolvedBonusState {
  identity_hash: string;
  bonus_until: number;
  total_months: number;
  lifetime_grants: number;
  last_bug_report_id: string | null;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// Schema + bootstrap
// ---------------------------------------------------------------------------

export const BONUS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS historian_bonus_grants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  granted_at        INTEGER NOT NULL,
  identity_hash     TEXT NOT NULL,
  email_plaintext   TEXT NOT NULL,
  bug_report_id     TEXT NOT NULL,
  github_issue_num  INTEGER,
  months_added      INTEGER NOT NULL,
  reason            TEXT,
  granted_by        TEXT NOT NULL,
  UNIQUE(bug_report_id, identity_hash)
);

CREATE INDEX IF NOT EXISTS idx_hbg_identity ON historian_bonus_grants(identity_hash);
CREATE INDEX IF NOT EXISTS idx_hbg_ts ON historian_bonus_grants(granted_at);
CREATE INDEX IF NOT EXISTS idx_hbg_email ON historian_bonus_grants(email_plaintext);

CREATE TABLE IF NOT EXISTS historian_bonus_claims (
  token             TEXT PRIMARY KEY,
  grant_id          INTEGER NOT NULL REFERENCES historian_bonus_grants(id),
  identity_hash     TEXT NOT NULL,
  issued_at         INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  claimed_at        INTEGER,
  claimed_device_id TEXT,
  revoked_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hbc_identity ON historian_bonus_claims(identity_hash);
CREATE INDEX IF NOT EXISTS idx_hbc_grant ON historian_bonus_claims(grant_id);

CREATE TABLE IF NOT EXISTS historian_bonus_state (
  identity_hash     TEXT PRIMARY KEY,
  bonus_until       INTEGER NOT NULL,
  total_months      INTEGER NOT NULL,
  lifetime_grants   INTEGER NOT NULL DEFAULT 0,
  last_bug_report_id TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hbs_bonus_until ON historian_bonus_state(bonus_until);
`;

/**
 * Bootstrap schema. Idempotent. Mirrors migration 0002 for belt-and-braces.
 */
export async function initBonusSchema(env: BonusEnv): Promise<void> {
  const statements = BONUS_SCHEMA_SQL
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await env.BBE_DB.prepare(stmt).run();
  }
}

// ---------------------------------------------------------------------------
// Identity hashing
// ---------------------------------------------------------------------------

/**
 * Canonical identity: sha256(lower(trim(email))) as lowercase hex.
 *
 * Email is what links the bug report to the comp. The hash hides the
 * plaintext from the iOS app — the server holds the email separately
 * for ops/audit/CS.
 */
export async function identityHashForEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const buf = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------
// HMAC claim tokens
// ---------------------------------------------------------------------------

interface ClaimTokenPayload {
  gid: number;            // grant id
  ih: string;             // identity hash
  exp: number;            // expiry, unix seconds
  iat: number;            // issued, unix seconds
  nonce: string;          // 16-byte random to prevent token collisions
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}

/**
 * Generate a signed claim token of the form `<payload_b64>.<sig_b64>`.
 *
 * Does NOT persist to D1 — caller (issueClaimToken) does that so the
 * token is bound to a real `historian_bonus_claims` row.
 */
export async function generateClaimToken(
  env: BonusEnv,
  grantId: number,
  identityHash: string,
  ttlDays = 30,
): Promise<{ token: string; issuedAt: number; expiresAt: number }> {
  if (!env.BONUS_CLAIM_HMAC_SECRET) {
    throw new Error('BONUS_CLAIM_HMAC_SECRET not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const payload: ClaimTokenPayload = {
    gid: grantId,
    ih: identityHash,
    exp: now + ttlDays * 86400,
    iat: now,
    nonce,
  };
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(env.BONUS_CLAIM_HMAC_SECRET, payloadB64);
  const token = `${payloadB64}.${base64UrlEncode(sig)}`;
  return { token, issuedAt: now, expiresAt: payload.exp };
}

export interface VerifiedClaimToken {
  payload: ClaimTokenPayload;
  valid: true;
}

export type ClaimVerifyResult =
  | VerifiedClaimToken
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/**
 * Stateless verification. Does NOT consult D1 — call sites that need
 * one-shot-claim semantics check `_claims.claimed_at IS NULL` separately.
 */
export async function verifyClaimToken(env: BonusEnv, token: string): Promise<ClaimVerifyResult> {
  if (!env.BONUS_CLAIM_HMAC_SECRET) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let payload: ClaimTokenPayload;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(json) as ClaimTokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof payload.gid !== 'number' || typeof payload.ih !== 'string' ||
      typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return { valid: false, reason: 'malformed' };
  }
  const expected = await hmacSign(env.BONUS_CLAIM_HMAC_SECRET, payloadB64);
  let provided: Uint8Array;
  try {
    provided = base64UrlDecode(sigB64);
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  if (!constantTimeEqual(expected, provided)) {
    return { valid: false, reason: 'bad_signature' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, payload };
}

// ---------------------------------------------------------------------------
// grantBonus — the core idempotent grant primitive
// ---------------------------------------------------------------------------

const SECONDS_PER_MONTH = 30 * 86400;

export interface GrantBonusResult {
  grant: BonusGrantRow;
  state: BonusStateRow;
  idempotent: boolean;
}

/**
 * Insert a new grant row (idempotent via UNIQUE(bug_report_id, identity_hash))
 * and update the materialized state. Stacking semantics:
 *
 *   new_bonus_until = max(now, current_bonus_until) + months_added * 30 days
 *
 * D1 is SQLite under the hood; concurrent grants on the same identity
 * serialize at the row level. We treat the upsert + state update as a
 * logical transaction; in the rare case of a race, the materialized
 * `_state` row remains reconcilable from the append-only `_grants` log.
 */
export async function grantBonus(env: BonusEnv, input: BonusGrantInput): Promise<GrantBonusResult> {
  const email = input.email.trim();
  if (!email.includes('@')) {
    throw new Error(`invalid email: ${email}`);
  }
  if (!input.bug_report_id) {
    throw new Error('bug_report_id required');
  }
  if (!Number.isFinite(input.months_added) || input.months_added <= 0) {
    throw new Error(`invalid months_added: ${input.months_added}`);
  }

  const identity = await identityHashForEmail(email);
  const now = Math.floor(Date.now() / 1000);

  // Idempotency check FIRST — if a grant for this (bug, identity) exists,
  // return it without touching _state.
  const existing = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_grants
              WHERE bug_report_id = ? AND identity_hash = ? LIMIT 1`)
    .bind(input.bug_report_id, identity)
    .first<BonusGrantRow>();

  if (existing) {
    const state = await env.BBE_DB
      .prepare(`SELECT * FROM historian_bonus_state WHERE identity_hash = ? LIMIT 1`)
      .bind(identity)
      .first<BonusStateRow>();
    if (state) {
      return { grant: existing, state, idempotent: true };
    }
    // _state row missing (drift) — rebuild from _grants.
    const rebuilt = await rebuildStateFromGrants(env, identity);
    return { grant: existing, state: rebuilt, idempotent: true };
  }

  // Insert new grant. UNIQUE constraint also covers the race where two
  // workers fire `reward-approved` simultaneously for the same issue.
  let grantId: number;
  try {
    const ins = await env.BBE_DB
      .prepare(`INSERT INTO historian_bonus_grants
                (granted_at, identity_hash, email_plaintext, bug_report_id,
                 github_issue_num, months_added, reason, granted_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        now,
        identity,
        email,
        input.bug_report_id,
        input.github_issue_num ?? null,
        input.months_added,
        input.reason ?? null,
        input.granted_by,
      )
      .run();
    grantId = ins?.meta?.last_row_id ?? 0;
  } catch (err) {
    // UNIQUE constraint race lost — re-read and return idempotent.
    const raced = await env.BBE_DB
      .prepare(`SELECT * FROM historian_bonus_grants
                WHERE bug_report_id = ? AND identity_hash = ? LIMIT 1`)
      .bind(input.bug_report_id, identity)
      .first<BonusGrantRow>();
    if (raced) {
      const state = await rebuildStateFromGrants(env, identity);
      return { grant: raced, state, idempotent: true };
    }
    throw err;
  }

  // Read back the inserted grant for the canonical row shape.
  const grant = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_grants WHERE id = ? LIMIT 1`)
    .bind(grantId)
    .first<BonusGrantRow>();
  if (!grant) {
    throw new Error(`grant row not found after insert (id=${grantId})`);
  }

  // Upsert _state: stack additively from max(now, current_bonus_until).
  const prev = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_state WHERE identity_hash = ? LIMIT 1`)
    .bind(identity)
    .first<BonusStateRow>();
  const base = prev ? Math.max(now, prev.bonus_until) : now;
  const newBonusUntil = base + input.months_added * SECONDS_PER_MONTH;
  const newTotalMonths = (prev?.total_months ?? 0) + input.months_added;
  const newLifetimeGrants = (prev?.lifetime_grants ?? 0) + 1;

  await env.BBE_DB
    .prepare(`INSERT INTO historian_bonus_state
              (identity_hash, bonus_until, total_months, lifetime_grants,
               last_bug_report_id, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(identity_hash) DO UPDATE SET
                bonus_until = excluded.bonus_until,
                total_months = excluded.total_months,
                lifetime_grants = excluded.lifetime_grants,
                last_bug_report_id = excluded.last_bug_report_id,
                updated_at = excluded.updated_at`)
    .bind(identity, newBonusUntil, newTotalMonths, newLifetimeGrants, input.bug_report_id, now)
    .run();

  const state: BonusStateRow = {
    identity_hash: identity,
    bonus_until: newBonusUntil,
    total_months: newTotalMonths,
    lifetime_grants: newLifetimeGrants,
    last_bug_report_id: input.bug_report_id,
    updated_at: now,
  };

  return { grant, state, idempotent: false };
}

/**
 * Rebuild the materialized state row from the append-only grant log.
 * Used on drift recovery and idempotent paths where _state may be missing.
 */
async function rebuildStateFromGrants(env: BonusEnv, identityHash: string): Promise<BonusStateRow> {
  const grants = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_grants
              WHERE identity_hash = ? ORDER BY granted_at ASC`)
    .bind(identityHash)
    .all<BonusGrantRow>();
  const rows = grants.results ?? [];
  let bonusUntil = 0;
  let totalMonths = 0;
  let lastBug: string | null = null;
  for (const g of rows) {
    const base = Math.max(g.granted_at, bonusUntil);
    bonusUntil = base + g.months_added * SECONDS_PER_MONTH;
    totalMonths += g.months_added;
    lastBug = g.bug_report_id;
  }
  const now = Math.floor(Date.now() / 1000);
  const lifetime = rows.length;
  await env.BBE_DB
    .prepare(`INSERT INTO historian_bonus_state
              (identity_hash, bonus_until, total_months, lifetime_grants,
               last_bug_report_id, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(identity_hash) DO UPDATE SET
                bonus_until = excluded.bonus_until,
                total_months = excluded.total_months,
                lifetime_grants = excluded.lifetime_grants,
                last_bug_report_id = excluded.last_bug_report_id,
                updated_at = excluded.updated_at`)
    .bind(identityHash, bonusUntil, totalMonths, lifetime, lastBug, now)
    .run();
  return {
    identity_hash: identityHash,
    bonus_until: bonusUntil,
    total_months: totalMonths,
    lifetime_grants: lifetime,
    last_bug_report_id: lastBug,
    updated_at: now,
  };
}

// ---------------------------------------------------------------------------
// resolveBonusState — public read path
// ---------------------------------------------------------------------------

export async function resolveBonusState(env: BonusEnv, identityHash: string): Promise<ResolvedBonusState | null> {
  const state = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_state WHERE identity_hash = ? LIMIT 1`)
    .bind(identityHash)
    .first<BonusStateRow>();
  if (!state) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    identity_hash: state.identity_hash,
    bonus_until: state.bonus_until,
    total_months: state.total_months,
    lifetime_grants: state.lifetime_grants,
    last_bug_report_id: state.last_bug_report_id,
    is_active: state.bonus_until > now,
  };
}

// ---------------------------------------------------------------------------
// Claim token persistence
// ---------------------------------------------------------------------------

export interface IssuedClaim {
  token: string;
  grant_id: number;
  identity_hash: string;
  issued_at: number;
  expires_at: number;
  claim_url: string;
}

export async function issueClaimToken(
  env: BonusEnv,
  grant: BonusGrantRow,
  ttlDays = 30,
): Promise<IssuedClaim> {
  const t = await generateClaimToken(env, grant.id, grant.identity_hash, ttlDays);
  await env.BBE_DB
    .prepare(`INSERT INTO historian_bonus_claims
              (token, grant_id, identity_hash, issued_at, expires_at,
               claimed_at, claimed_device_id, revoked_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`)
    .bind(t.token, grant.id, grant.identity_hash, t.issuedAt, t.expiresAt)
    .run();
  const base = env.BONUS_CLAIM_BASE_URL || 'https://sortinghistory.com';
  const claim_url = `${base.replace(/\/$/, '')}/claim/${encodeURIComponent(t.token)}`;
  return {
    token: t.token,
    grant_id: grant.id,
    identity_hash: grant.identity_hash,
    issued_at: t.issuedAt,
    expires_at: t.expiresAt,
    claim_url,
  };
}

export interface ClaimBonusResult {
  ok: true;
  state: ResolvedBonusState;
  bonus_until: number;
  identity_hash: string;
}

export interface ClaimBonusError {
  ok: false;
  reason: 'malformed' | 'bad_signature' | 'expired' | 'not_found' | 'already_claimed' | 'revoked';
}

export async function claimBonusForDevice(
  env: BonusEnv,
  token: string,
  idfv?: string,
): Promise<ClaimBonusResult | ClaimBonusError> {
  const verified = await verifyClaimToken(env, token);
  if (!verified.valid) {
    return { ok: false, reason: verified.reason };
  }
  const row = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_claims WHERE token = ? LIMIT 1`)
    .bind(token)
    .first<BonusClaimRow>();
  if (!row) {
    return { ok: false, reason: 'not_found' };
  }
  if (row.revoked_at) {
    return { ok: false, reason: 'revoked' };
  }
  if (row.claimed_at) {
    // Idempotent re-claim from the same device: return current state.
    if (idfv && row.claimed_device_id === idfv) {
      const state = await resolveBonusState(env, row.identity_hash);
      if (state) {
        return { ok: true, state, bonus_until: state.bonus_until, identity_hash: row.identity_hash };
      }
    }
    return { ok: false, reason: 'already_claimed' };
  }

  const now = Math.floor(Date.now() / 1000);
  await env.BBE_DB
    .prepare(`UPDATE historian_bonus_claims
              SET claimed_at = ?, claimed_device_id = ?
              WHERE token = ? AND claimed_at IS NULL`)
    .bind(now, idfv ?? null, token)
    .run();

  const state = await resolveBonusState(env, row.identity_hash);
  if (!state) {
    // _state missing — rebuild defensively.
    const rebuilt = await rebuildStateFromGrants(env, row.identity_hash);
    return {
      ok: true,
      state: {
        identity_hash: rebuilt.identity_hash,
        bonus_until: rebuilt.bonus_until,
        total_months: rebuilt.total_months,
        lifetime_grants: rebuilt.lifetime_grants,
        last_bug_report_id: rebuilt.last_bug_report_id,
        is_active: rebuilt.bonus_until > now,
      },
      bonus_until: rebuilt.bonus_until,
      identity_hash: row.identity_hash,
    };
  }
  return { ok: true, state, bonus_until: state.bonus_until, identity_hash: row.identity_hash };
}

// ---------------------------------------------------------------------------
// Admin revoke
// ---------------------------------------------------------------------------

export async function revokeClaim(env: BonusEnv, token: string, reason: string): Promise<{ ok: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.BBE_DB
    .prepare(`UPDATE historian_bonus_claims SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`)
    .bind(now, token)
    .run();
  // Log via _grants reason field? No — use a dedicated audit if desired in future.
  void reason;
  return { ok: (res?.meta?.changes ?? 0) >= 1 };
}

// ---------------------------------------------------------------------------
// Email: lookup-by-email + reward claim email
// ---------------------------------------------------------------------------

/**
 * Look up grants by email and re-issue a claim email if any exist.
 * Rate-limited 1/24h per identity hash via PIPELINE_KV.
 *
 * The response shape is identical whether the email has grants or not —
 * prevents enumeration of which bug-reporters got a comp.
 */
export async function lookupByEmail(env: BonusEnv, email: string): Promise<{ accepted: true }> {
  const normalized = email.trim();
  if (!normalized.includes('@')) {
    return { accepted: true };
  }
  const identity = await identityHashForEmail(normalized);

  // Rate-limit: 1/24h per identity. KV missing = pass-through (dev/local).
  if (env.PIPELINE_KV) {
    const rlKey = `bonus_lookup_rl:${identity}`;
    const existing = await env.PIPELINE_KV.get(rlKey);
    if (existing) {
      return { accepted: true };
    }
    await env.PIPELINE_KV.put(rlKey, '1', { expirationTtl: 86400 });
  }

  // Find latest unclaimed-or-claimed grant for this identity.
  const latestGrant = await env.BBE_DB
    .prepare(`SELECT * FROM historian_bonus_grants
              WHERE identity_hash = ?
              ORDER BY granted_at DESC LIMIT 1`)
    .bind(identity)
    .first<BonusGrantRow>();
  if (!latestGrant) {
    return { accepted: true };
  }
  // Issue a fresh claim token (the old one may have expired).
  const claim = await issueClaimToken(env, latestGrant, 30);
  const state = await resolveBonusState(env, identity);
  const bonusUntilDate = state ? new Date(state.bonus_until * 1000).toISOString().slice(0, 10) : 'soon';

  await sendBonusClaimEmail(env, {
    to: latestGrant.email_plaintext,
    claimUrl: claim.claim_url,
    bonusUntilISO: bonusUntilDate,
    refId: latestGrant.bug_report_id,
    isResend: true,
    isCompback: latestGrant.granted_by.startsWith('migration:'),
  });
  return { accepted: true };
}

// ---------------------------------------------------------------------------
// Email template (EN only — BUG-267A-CLAIM-EMAIL-LOCALES-001 backfills others)
// ---------------------------------------------------------------------------

export interface BonusClaimEmailInputs {
  to: string;
  claimUrl: string;
  bonusUntilISO: string;
  refId: string;
  /** True if this is a resend (recovery) vs initial reward. */
  isResend?: boolean;
  /** True if this is a retroactive comp-back grant from BUG-267A migration. */
  isCompback?: boolean;
  /** Reserved for BUG-267A-CLAIM-EMAIL-LOCALES-001. Ignored today. */
  locale?: string;
}

export interface RenderedBonusEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBonusClaimEmail(inputs: BonusClaimEmailInputs): RenderedBonusEmail {
  // TODO BUG-267A-CLAIM-EMAIL-LOCALES-001: branch on locale. Today EN-only
  // for all 7 locales as accepted temporary regression — Mara backfills de,
  // nl, pt, es-419, ja, fr after this PR merges.

  const subject = inputs.isCompback
    ? 'We owe you — 2 months of Historian, fixed'
    : 'Your bug fix shipped — 2 months of Historian on us';

  const greeting = 'Hi,';

  const leadIn = inputs.isCompback
    ? `You reported bug ${inputs.refId} and we sent you a 2-month reward code that — we discovered later — Apple silently ignored if you were in your free trial. We're sorry.`
    : `Good news on bug report ${inputs.refId} — the fix shipped, and the update is live in the App Store.`;

  const granted = inputs.isCompback
    ? `We've now added those 2 months directly to your account. No App Store redemption, no code to enter — it just works.`
    : `As a thank-you, we've added 2 months of Historian to your account directly. No App Store redemption, no code to enter — it just works.`;

  const whatNextLabel = 'What happens next:';
  const bullet1 = `Tap this link on the iPhone or iPad you play Sorting History on: ${inputs.claimUrl}`;
  const bullet2 = `The app will open and confirm "Bonus Historian active until ${inputs.bonusUntilISO}".`;
  const bullet3 = `Your bonus stacks on top of any current subscription — if you're paying for Historian today, the bonus kicks in after your subscription ends.`;

  const linkExpiry = inputs.isResend
    ? `This is a fresh claim link — it expires in 30 days. If you miss it again, open the app, go to Settings → Subscription, and tap "I got a bug-reward email".`
    : `This link expires in 30 days. If you miss it, open the app, go to Settings → Subscription, and tap "I got a bug-reward email" to have a new link sent.`;

  const closing = inputs.isCompback
    ? 'Thanks for putting up with the mess.'
    : 'Thanks again for helping make the game better.';

  const signoff = 'The Sorting History team';

  const refLine = `Report ID: ${inputs.refId}`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="text-align:center;padding:20px 0;border-bottom:2px solid #1a3a4a;">
    <h1 style="color:#1a3a4a;margin:0;font-size:24px;">Sorting History</h1>
  </div>
  <div style="padding:30px 0;">
    <p style="line-height:1.6;">${escapeHtml(greeting)}</p>
    <p style="line-height:1.6;">${escapeHtml(leadIn)}</p>
    <p style="line-height:1.6;">${escapeHtml(granted)}</p>
    <p style="line-height:1.6;margin-top:20px;"><strong>${escapeHtml(whatNextLabel)}</strong></p>
    <ul style="line-height:1.6;padding-left:20px;">
      <li style="margin-bottom:8px;">Tap this link on the iPhone or iPad you play Sorting History on:<br><a href="${escapeHtml(inputs.claimUrl)}" style="color:#1a3a4a;word-break:break-all;">${escapeHtml(inputs.claimUrl)}</a></li>
      <li style="margin-bottom:8px;">${escapeHtml(bullet2)}</li>
      <li style="margin-bottom:8px;">${escapeHtml(bullet3)}</li>
    </ul>
    <p style="line-height:1.6;margin-top:20px;color:#666;font-size:14px;">${escapeHtml(linkExpiry)}</p>
    <p style="line-height:1.6;margin-top:20px;">${escapeHtml(closing)}</p>
    <p style="line-height:1.6;">${escapeHtml(signoff)}</p>
    <p style="color:#666;font-size:13px;line-height:1.6;margin-top:24px;">${escapeHtml(refLine)}</p>
  </div>
</body></html>`;

  const text = [
    greeting,
    '',
    leadIn,
    '',
    granted,
    '',
    whatNextLabel,
    `- ${bullet1}`,
    `- ${bullet2}`,
    `- ${bullet3}`,
    '',
    linkExpiry,
    '',
    closing,
    signoff,
    '',
    refLine,
  ].join('\n');

  return { subject, html, text };
}

export async function sendBonusClaimEmail(env: BonusEnv, inputs: BonusClaimEmailInputs): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.error('bonus: RESEND_API_KEY not configured');
    return false;
  }
  const rendered = renderBonusClaimEmail(inputs);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Sorting History <hello@sortinghistory.com>',
        to: [inputs.to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`bonus: Resend returned ${res.status}: ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('bonus: Resend threw', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// dispatchBonus — replaces bbeDispatchReward for the reward-approved label
// ---------------------------------------------------------------------------

export interface DispatchBonusInputs {
  issueNumber: number;
  labels: string[];
  recipientEmail?: string | null;
  gameLanguage?: string | null;
  locale?: string | null;
  confirmationId?: string;
  /** Default 2 months per architect Open Q #1 recommendation. */
  monthsAdded?: number;
}

export type DispatchBonusStatus =
  | 'granted'
  | 'duplicate'
  | 'no-email'
  | 'opted-out'
  | 'send-failed'
  | 'skipped';

export interface DispatchBonusResult {
  status: DispatchBonusStatus;
  grantId?: number;
  claimUrl?: string;
  bonusUntil?: number;
  reason?: string;
}

export async function dispatchBonus(env: BonusEnv, inputs: DispatchBonusInputs): Promise<DispatchBonusResult> {
  const labels = new Set((inputs.labels || []).map((l) => (l || '').toLowerCase()));
  if (!labels.has('reward-approved')) {
    return { status: 'skipped', reason: 'no trigger label' };
  }
  if (labels.has('no-reward')) {
    return { status: 'opted-out' };
  }
  const email = (inputs.recipientEmail || '').trim();
  if (!email || !email.includes('@')) {
    return { status: 'no-email' };
  }

  const bugReportId = inputs.confirmationId || String(inputs.issueNumber);
  const result = await grantBonus(env, {
    bug_report_id: bugReportId,
    email,
    months_added: inputs.monthsAdded ?? 2,
    github_issue_num: inputs.issueNumber,
    reason: inputs.confirmationId ? `reward-approved label, confirmation ${inputs.confirmationId}` : 'reward-approved label',
    granted_by: 'worker:label:reward-approved',
  });

  if (result.idempotent) {
    return {
      status: 'duplicate',
      grantId: result.grant.id,
      bonusUntil: result.state.bonus_until,
    };
  }

  const claim = await issueClaimToken(env, result.grant, 30);
  const bonusUntilISO = new Date(result.state.bonus_until * 1000).toISOString().slice(0, 10);

  const sent = await sendBonusClaimEmail(env, {
    to: email,
    claimUrl: claim.claim_url,
    bonusUntilISO,
    refId: bugReportId,
    isCompback: false,
    locale: inputs.locale ?? inputs.gameLanguage ?? undefined,
  });

  if (!sent) {
    return { status: 'send-failed', grantId: result.grant.id, claimUrl: claim.claim_url };
  }
  return {
    status: 'granted',
    grantId: result.grant.id,
    claimUrl: claim.claim_url,
    bonusUntil: result.state.bonus_until,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for symmetry with bbe.ts importers
// ---------------------------------------------------------------------------

export type { D1DatabaseLike, D1PreparedStatementLike } from './bbe';
