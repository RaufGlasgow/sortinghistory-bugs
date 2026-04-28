-- BBE-002: Bug Bounty Reward Email pipeline — initial schema.
--
-- Creates the inventory, audit, and meta tables that back the
-- /api/bbe/* admin endpoints, the public /api/reward-code/status
-- inventory probe, and the issues.labeled -> dispatchReward flow.
--
-- This migration MUST stay idempotent. The worker also runs
-- initSchemaAndImport(env) at request time as a belt-and-braces
-- bootstrap; running this migration first cleanly is preferred so
-- the first /api/bbe/* request is fast.
--
-- Source of truth for the schema: workers/bug-webhook/src/bbe.ts
-- (export const BBE_SCHEMA_SQL). Keep this file in sync if that
-- constant changes.

CREATE TABLE IF NOT EXISTS bug_bounty_codes (
  code              TEXT PRIMARY KEY,
  status            TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'used', 'invalidated')),
  reserved_at       INTEGER,
  sent_at           INTEGER,
  recipient_email   TEXT,
  bug_report_id     TEXT,
  expiration_date   INTEGER,
  invalidated_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bbc_status ON bug_bounty_codes(status);
CREATE INDEX IF NOT EXISTS idx_bbc_bug_report ON bug_bounty_codes(bug_report_id);

CREATE TABLE IF NOT EXISTS bug_bounty_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  event             TEXT NOT NULL,
  code              TEXT,
  recipient_email   TEXT,
  bug_report_id     TEXT,
  detail            TEXT
);

CREATE INDEX IF NOT EXISTS idx_bba_ts ON bug_bounty_audit(ts);
CREATE INDEX IF NOT EXISTS idx_bba_bug_report ON bug_bounty_audit(bug_report_id);

CREATE TABLE IF NOT EXISTS bug_bounty_meta (
  key               TEXT PRIMARY KEY,
  value             TEXT
);
