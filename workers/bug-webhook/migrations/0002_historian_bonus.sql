-- BUG-267A: Server-Granted Historian Bonus — schema migration.
--
-- Replaces the broken ASC offer-code reward path (offer code
-- 4e62c36a-e951-48cd-b27c-9242b4c3cc1a, "Bug Bounty - 2 months one-time")
-- which Apple silently no-ops when redeemed against an active intro trial.
--
-- The new model is a server-granted bonus tier living in this same
-- `bbe-rewards` D1 (binding BBE_DB). The iOS app polls /api/bonus/state
-- and composes `effectiveTier = max(storeKitTier, bonusTier)`.
--
-- This migration MUST stay idempotent. The worker also runs
-- initBonusSchema(env) at request time as a belt-and-braces bootstrap;
-- running this migration first cleanly is preferred so the first
-- /api/bonus/* request is fast.
--
-- Source of truth for the schema: workers/bug-webhook/src/bonus.ts
-- (export const BONUS_SCHEMA_SQL). Keep this file in sync if that
-- constant changes.
--
-- Architect spec: docs/architecture/BUG-267A-SERVER-GRANTED-REWARD-ARCHITECT-DESIGN.md
-- Story: docs/stories/BUG-267A.story.bug-reward-code-fails-to-extend-trial.md

-- Append-only grant log. One row per accepted bug reward.
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

-- Claim tokens — one per grant, used by the reward email's deep link.
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

-- Materialized "bonus_until" per identity. Updated transactionally by
-- grantBonus(). Reconcilable: a periodic admin job can rebuild this
-- from historian_bonus_grants if drift is suspected.
CREATE TABLE IF NOT EXISTS historian_bonus_state (
  identity_hash     TEXT PRIMARY KEY,
  bonus_until       INTEGER NOT NULL,
  total_months      INTEGER NOT NULL,
  lifetime_grants   INTEGER NOT NULL DEFAULT 0,
  last_bug_report_id TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hbs_bonus_until ON historian_bonus_state(bonus_until);
