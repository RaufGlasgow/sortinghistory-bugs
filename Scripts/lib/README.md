# Scripts/lib — bug-pipeline cost meter + paid-route tripwire

Story: **PIPE-OBSERVE-FOUNDATION** (local-model edition). This is the safety
instrumentation that must exist before any local Ollama LLM daemon
(`PIPE-LOCAL-TRIAGE-001` / `PIPE-LOCAL-FIX-001`) goes live.

Local-only. **No** Anthropic/Claude SDK, **no** OpenRouter, **no** Langfuse. The
pipeline runs Ollama models on the M4 at `$0` hosted spend; the meter exists to
(a) keep a token/latency ledger that detects quality regressions after a model
pull, and (b) trip the instant any call routes to a model outside the local
allowlist.

## Files

| File | What it is |
|---|---|
| `cost-meter.js` | The ledger + cap. Single source of truth (CommonJS, zero-dep). |
| `cost-cap.js` | Thin re-export of the cap surface from `cost-meter.js` (no duplicated logic). |
| `../cost-report.js` | CLI monthly report (replaces the retired Worker `/admin/cost-report`). |
| `__tests__/*.test.js` | `node:test` suite (zero-dep). |
| `../../pipeline-cost-meter.jsonl` | Append-only ledger at repo root (created on first write). |
| `~/.pipeline-cost-cap-tripped` | Kill-flag local state file (JSON `{month,reason,ts}`). |

## How to read spend

```bash
# from the repo root (sortinghistory-bugs/)
node Scripts/cost-report.js --month 2026-06          # human summary
node Scripts/cost-report.js --month 2026-06 --json   # raw aggregate object
```

The report prints calls / input+output tokens / dollars / paid-route trips /
latency p50, plus by-role and by-model breakdowns. A nonzero `paid-route trips`
or any nonzero `dollars` is an **anomaly** for a correct local pipeline (a call
escaped the local allowlist) and warrants investigation.

## How the tripwire works

Every LLM call site MUST call `assertWithinCap({ model })` **before** invoking
the model (enforced at dispatch of the consuming daemon stories). It returns:

- `{ ok: true }` — allowlisted model, `$0` month-to-date.
- `{ ok: false, reason, monthlySpend }` — model off the local allowlist, OR any
  nonzero monthly spend, OR spend at/over the `$50` kill threshold.

On `ok:false` the daemon: skips the call, labels the issue `cost-cap-tripped`,
calls `writeKillFlag({ reason })` (so it stops attempting LLM calls this month),
and emails Ra'uf via the **existing** PIPE-NOTIFY owner-email path
(`workers/bug-webhook/src/lib/send-owner-email.ts`) using
`tripwireEmailPayload(capResult)` for the subject/text. This module does **not**
send mail itself (no second mailer).

## How to reset the tripwire

Delete the kill-flag file, then the daemon resumes LLM calls next poll:

```bash
rm -f ~/.pipeline-cost-cap-tripped
```

(A kill-flag from a previous month is automatically ignored — it only blocks the
month it names.) Programmatically: `require('./cost-cap').resetCap()`.

## How to update the allowlist / price map

Both live at the top of `cost-meter.js`:

- **`ALLOWLIST`** — the local Ollama models (`qwen2.5:14b`, `qwen3:32b`,
  `gemma4:31b`, `gemma4:26b`, from plan v3 §4.1/§4.2). To add a model the daemon
  will actually use, add its exact Ollama tag here. Allowlisted models always
  cost `$0` and `paid_route=false`.
- **`PAID_ROUTE_PRICE_MAP`** — USD-per-1,000,000-tokens for models we want to be
  able to *quantify* if a stray call ever escapes the allowlist. It is **not**
  for billing local calls. If a model is off-allowlist AND absent from this map,
  `recordCall` **throws** `missing-model-classification` (never a silent zero) —
  add a price-map entry only if you intentionally introduce a paid route.

Thresholds (`WARN_MONTHLY_USD=25`, `KILL_MONTHLY_USD=50`, `SOFT_DAILY_USD=5`) are
defense-in-depth; for a correct local pipeline they are never reached.

## Run the tests

```bash
node --test 'Scripts/lib/__tests__/*.test.js'
```

Zero dependencies (Node's built-in `node:test`). Tests isolate the ledger and
kill-flag to a temp dir via `PIPELINE_COST_METER_PATH` /
`PIPELINE_COST_CAP_FLAG_PATH`, so they never touch the real repo-root ledger or
`$HOME`.
