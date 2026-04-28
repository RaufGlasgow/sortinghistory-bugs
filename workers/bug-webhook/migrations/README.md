# bug-webhook migrations

D1 migrations applied to the `bbe-rewards` database that backs the
BBE-002 reward-code automation. Wrangler discovers files in this
directory by default when you run `wrangler d1 migrations apply`.

## Sequence

| File | Purpose | Added |
|------|---------|-------|
| `0001_bbe_init.sql` | Initial BBE schema (inventory, audit, meta tables + indexes) | 2026-04-28 (BBE-002) |

## Tables

### `bug_bounty_codes` — inventory

| Column | Type | Notes |
|--------|------|-------|
| `code` | TEXT PRIMARY KEY | Apple offer code (alnum, upper-case). Primary key gives the atomic-claim guarantee. |
| `status` | TEXT NOT NULL | One of `available`, `reserved`, `used`, `invalidated`. CHECK constraint enforces the set. |
| `reserved_at` | INTEGER | Unix ms when claimed. NULL before first reservation. |
| `sent_at` | INTEGER | Unix ms when the email send returned 2xx from Resend. |
| `recipient_email` | TEXT | Set at reservation time. |
| `bug_report_id` | TEXT | GitHub issue number (as string) or `manual-<ts>` for admin sends. |
| `expiration_date` | INTEGER | Unix ms; informational, copied from the batch metadata. |
| `invalidated_at` | INTEGER | Unix ms; set by `invalidateAvailableCodes`. |

Indexes:
- `idx_bbc_status` for the available-row scan in `claimCode`.
- `idx_bbc_bug_report` for the duplicate-protection lookup in `dispatchReward`.

### `bug_bounty_audit` — append-only event log

Every state transition writes a row here. Used by the weekly digest and
for incident forensics. Never mutated; never garbage-collected (the
table is small — one row per code action).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTOINC | |
| `ts` | INTEGER NOT NULL | Unix ms. |
| `event` | TEXT NOT NULL | One of: `code_reserved`, `code_sent`, `code_released`, `reward_opted_out`, `reward_no_email`, `reward_inventory_empty`, `reward_duplicate`, `csv_import`, `manual_send`, `batch_invalidated`. |
| `code` | TEXT | Nullable (some events are not code-scoped). |
| `recipient_email` | TEXT | Nullable. |
| `bug_report_id` | TEXT | Nullable. |
| `detail` | TEXT | Free-form. |

### `bug_bounty_meta` — key-value scratch

Used today only by `runInventoryAlertCheck` for once-per-day
deduplication of alert emails.

## Idempotency

Every `CREATE` uses `IF NOT EXISTS`. Re-applying the migration on a
populated database is safe (no rows touched). The worker also runs
the same SQL via `initSchemaAndImport(env)` at request time as a
belt-and-braces bootstrap; this is intentional.

## Seed data

None. The first-run CSV import is driven by the `BBE_CSV` worker
secret (set via `wrangler secret put BBE_CSV`) and triggered when
`POST /api/bbe/import-csv` runs against an empty inventory.

## Apply commands

Local (development copy):

```
wrangler d1 migrations apply bbe-rewards --local
```

Remote (production):

```
wrangler d1 migrations apply bbe-rewards --remote
```

The full first-time-deploy sequence lives in the runbook in the
private repo at `docs/runbooks/BBE-002-Ra-uf-deploy-runbook.md`.
