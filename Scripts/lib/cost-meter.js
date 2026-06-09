/**
 * cost-meter.js — PIPE-OBSERVE-FOUNDATION
 *
 * Shared Node (CommonJS, zero-dep) cost/token/latency ledger for the LOCAL bug
 * pipeline (plan v3, local Ollama daemons). Consumed by PIPE-LOCAL-TRIAGE-001 /
 * PIPE-LOCAL-FIX-001. Mirrors the existing append-only outcome-log pattern
 * (pipeline-outcomes.jsonl, v3 §9 O5).
 *
 * Design (story PIPE-OBSERVE-FOUNDATION, local-model edition):
 *   - Every LLM call appends ONE JSON row to pipeline-cost-meter.jsonl (repo root).
 *   - Allowlisted local model  -> dollars = 0, paid_route = false.
 *   - Off-allowlist (paid/unknown route) but priced -> paid_route = true, dollars from price map.
 *   - Model with neither allowlist nor price-map entry -> THROW (never a silent zero).
 *   - Idempotent by run_id: re-recording the same run_id is a no-op.
 *   - Aggregates (daily/monthly) computed on read; no separate aggregate store.
 *   - No silent failures: unreadable ledger throws; missing ledger is created.
 *
 * Guardrails honored: NO Anthropic/Claude SDK, NO OpenRouter, NO Langfuse,
 * local-only. ASCII-only field names / log keys. CommonJS to match Scripts/*.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Configuration (allowlist, price map, thresholds, paths)
// ---------------------------------------------------------------------------

// Local-Ollama allowlist (plan v3 §4.1/§4.2). These run on the M4 at $0 hosted
// spend. To add a model: add it here AND ensure the daemon actually uses it.
const ALLOWLIST = Object.freeze([
  'qwen2.5:14b',
  'qwen3:32b',
  'gemma4:31b',
  'gemma4:26b',
]);

// Paid-route price map. NOT here to bill local calls — present only so that if a
// call ever escapes the allowlist to a known hosted model, the stray spend is
// QUANTIFIED (not silently zeroed). Prices in USD per 1,000,000 tokens.
// A model that is off-allowlist AND absent here throws (missing-model-classification).
const PAID_ROUTE_PRICE_MAP = Object.freeze({
  // OpenAI (used by smoke test gpt-4o; representative public pricing)
  'gpt-4o':           { inputPerMTok: 2.50,  outputPerMTok: 10.00 },
  'gpt-4o-mini':      { inputPerMTok: 0.15,  outputPerMTok: 0.60  },
  // Anthropic (no SDK import — pricing reference only, for quantifying a stray route)
  'claude-3-5-sonnet':{ inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  // OpenRouter-style (retired by v3; kept so a regression to it is quantified, not silent)
  'google/gemini-2.0-flash-001': { inputPerMTok: 0.10, outputPerMTok: 0.40 },
});

// Policy thresholds (defense-in-depth; for a correct local pipeline these are
// never reached because dollars are $0 by construction). USD.
const WARN_MONTHLY_USD = 25;
const KILL_MONTHLY_USD = 50;
const SOFT_DAILY_USD = 5; // warn-only, never blocks

const VALID_ROLES = Object.freeze(['triage', 'fix-primary', 'fix-secondary']);

// Ledger lives next to pipeline-outcomes.jsonl at the repo root (Scripts/lib -> ../..).
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LEDGER_PATH = path.join(REPO_ROOT, 'pipeline-cost-meter.jsonl');

// Kill-flag local state file (AC8/AC9). JSON { month, reason, ts }.
const DEFAULT_KILL_FLAG_PATH = path.join(os.homedir(), '.pipeline-cost-cap-tripped');

// Overridable for tests (so tests never touch the real repo-root ledger or $HOME).
function ledgerPath() {
  return process.env.PIPELINE_COST_METER_PATH || DEFAULT_LEDGER_PATH;
}
function killFlagPath() {
  return process.env.PIPELINE_COST_CAP_FLAG_PATH || DEFAULT_KILL_FLAG_PATH;
}

// ---------------------------------------------------------------------------
// Classification (allowlist / price map / throw)
// ---------------------------------------------------------------------------

function isAllowlisted(model) {
  return ALLOWLIST.indexOf(model) !== -1;
}

/**
 * Classify a model into { paidRoute, dollars } given token counts.
 * - Allowlisted -> { paidRoute: false, dollars: 0 }.
 * - Off-allowlist but priced -> { paidRoute: true, dollars: <computed> }.
 * - Neither -> throw Error('missing-model-classification: <model>').
 */
function classify(model, inputTokens, outputTokens) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('missing-model-classification: model is required');
  }
  if (isAllowlisted(model)) {
    return { paidRoute: false, dollars: 0 };
  }
  const price = PAID_ROUTE_PRICE_MAP[model];
  if (!price) {
    // Never a silent zero. An unclassifiable model is a hard error.
    throw new Error('missing-model-classification: ' + model);
  }
  const inTok = Number(inputTokens) || 0;
  const outTok = Number(outputTokens) || 0;
  const dollars =
    (inTok / 1e6) * price.inputPerMTok + (outTok / 1e6) * price.outputPerMTok;
  return { paidRoute: true, dollars };
}

// ---------------------------------------------------------------------------
// Ledger read / write helpers (no silent failures)
// ---------------------------------------------------------------------------

/**
 * Read all ledger rows. Missing file -> [] (created lazily on first write).
 * Unreadable/corrupt file -> THROW (per guardrail: unreadable ledger throws).
 */
function readRows() {
  const p = ledgerPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return []; // missing ledger is fine — it will be created on first write
    }
    throw new Error('cost-meter: ledger unreadable at ' + p + ': ' + err.message);
  }
  const rows = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(
        'cost-meter: corrupt ledger row ' + (i + 1) + ' in ' + p + ': ' + err.message
      );
    }
    rows.push(row);
  }
  return rows;
}

function hasRunId(runId) {
  const rows = readRows();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].run_id === runId) return true;
  }
  return false;
}

function appendRow(row) {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// recordCall (AC1-AC5)
// ---------------------------------------------------------------------------

/**
 * recordCall — append one ledger row for an LLM call.
 * Idempotent by run_id. Throws on unknown model or invalid role.
 * @param {Object} call
 * @param {string} call.runId   stable id, e.g. `${bugId}-${role}-${attempt}`
 * @param {string|number} call.bugId
 * @param {'triage'|'fix-primary'|'fix-secondary'} call.role
 * @param {string} call.model
 * @param {string} call.promptHash
 * @param {number} call.inputTokens
 * @param {number} call.outputTokens
 * @param {number} call.latencyMs
 * @param {string} [call.ts]   ISO timestamp; defaults to now.
 * @returns {Promise<void>}
 */
async function recordCall(call) {
  const {
    runId,
    bugId,
    role,
    model,
    promptHash,
    inputTokens,
    outputTokens,
    latencyMs,
    ts,
  } = call || {};

  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('cost-meter: runId is required (stable idempotency key)');
  }
  if (VALID_ROLES.indexOf(role) === -1) {
    throw new Error(
      'cost-meter: invalid role "' + role + '" (expected one of ' + VALID_ROLES.join(', ') + ')'
    );
  }

  // Idempotency: a row whose run_id already exists is not appended again.
  if (hasRunId(runId)) {
    return;
  }

  // classify() throws on unknown model BEFORE any write — never a silent zero.
  const { paidRoute, dollars } = classify(model, inputTokens, outputTokens);

  const row = {
    ts: ts || new Date().toISOString(),
    run_id: runId,
    bug_id: bugId === undefined || bugId === null ? null : bugId,
    role: role,
    model: model,
    prompt_hash: promptHash === undefined ? null : promptHash,
    input_tokens: Number(inputTokens) || 0,
    output_tokens: Number(outputTokens) || 0,
    latency_ms: Number(latencyMs) || 0,
    dollars: dollars,
    paid_route: paidRoute,
  };

  appendRow(row);

  // Month-to-date total for the telemetry line (AC5).
  const monthKey = row.ts.slice(0, 7).replace('-', ''); // yyyymm
  const monthTotals = await getMonthlyTotals(monthKey);

  // AC5 telemetry log line. ASCII-only keys.
  console.log(
    '[cost-meter] bug=' + row.bug_id +
    ' role=' + row.role +
    ' model=' + row.model +
    ' tokens_in=' + row.input_tokens +
    ' tokens_out=' + row.output_tokens +
    ' latency_ms=' + row.latency_ms +
    ' $=' + dollars.toFixed(6) +
    ' paid=' + paidRoute +
    ' month_total=' + monthTotals.dollars.toFixed(2)
  );

  // AC10 daily soft-warn (warn-only, never blocks).
  const dayKey = row.ts.slice(0, 10).replace(/-/g, ''); // yyyymmdd
  const dayTotals = await getDailyTotals(dayKey);
  if (dayTotals.dollars > 0) {
    console.warn(
      '[cost-meter] SOFT-DAILY-WARN day=' + dayKey +
      ' $=' + dayTotals.dollars.toFixed(2) +
      ' soft_daily_usd=' + SOFT_DAILY_USD +
      ' (warn-only, not blocking)'
    );
  }
}

// ---------------------------------------------------------------------------
// Aggregation (AC1 getDaily/getMonthly, AC2 computed-on-read)
// ---------------------------------------------------------------------------

function median(sortedNums) {
  if (sortedNums.length === 0) return 0;
  const mid = Math.floor(sortedNums.length / 2);
  if (sortedNums.length % 2 === 1) return sortedNums[mid];
  return (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

/**
 * Aggregate rows whose ts matches a key prefix.
 * @param {(tsCompact: string) => boolean} matchFn  given ts as yyyymmdd... -> include?
 */
function aggregate(matchFn) {
  const rows = readRows();
  const out = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    dollars: 0,
    paidRouteTrips: 0,
    latencyP50Ms: 0,
    byRole: {},
    byModel: {},
  };
  const latencies = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r.ts !== 'string') continue;
    const compact = r.ts.replace(/[-:TZ.]/g, '').slice(0, 14); // yyyymmddHHMMSS
    if (!matchFn(compact)) continue;

    out.calls += 1;
    out.inputTokens += Number(r.input_tokens) || 0;
    out.outputTokens += Number(r.output_tokens) || 0;
    out.dollars += Number(r.dollars) || 0;
    if (r.paid_route === true) out.paidRouteTrips += 1;
    latencies.push(Number(r.latency_ms) || 0);

    const role = r.role || 'unknown';
    if (!out.byRole[role]) {
      out.byRole[role] = { calls: 0, inputTokens: 0, outputTokens: 0, dollars: 0 };
    }
    out.byRole[role].calls += 1;
    out.byRole[role].inputTokens += Number(r.input_tokens) || 0;
    out.byRole[role].outputTokens += Number(r.output_tokens) || 0;
    out.byRole[role].dollars += Number(r.dollars) || 0;

    const model = r.model || 'unknown';
    if (!out.byModel[model]) {
      out.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, dollars: 0 };
    }
    out.byModel[model].calls += 1;
    out.byModel[model].inputTokens += Number(r.input_tokens) || 0;
    out.byModel[model].outputTokens += Number(r.output_tokens) || 0;
    out.byModel[model].dollars += Number(r.dollars) || 0;
  }

  latencies.sort(function (a, b) { return a - b; });
  out.latencyP50Ms = median(latencies);
  return out;
}

/**
 * getDailyTotals(yyyymmdd) — aggregate one calendar day (UTC, by ts prefix).
 */
async function getDailyTotals(yyyymmdd) {
  const key = String(yyyymmdd);
  if (!/^\d{8}$/.test(key)) {
    throw new Error('cost-meter: getDailyTotals expects yyyymmdd, got "' + yyyymmdd + '"');
  }
  return aggregate(function (compact) {
    return compact.slice(0, 8) === key;
  });
}

/**
 * getMonthlyTotals(yyyymm) — aggregate one calendar month (UTC, by ts prefix).
 */
async function getMonthlyTotals(yyyymm) {
  const key = String(yyyymm);
  if (!/^\d{6}$/.test(key)) {
    throw new Error('cost-meter: getMonthlyTotals expects yyyymm, got "' + yyyymm + '"');
  }
  return aggregate(function (compact) {
    return compact.slice(0, 6) === key;
  });
}

// ---------------------------------------------------------------------------
// Paid-route tripwire / cap (AC6-AC10)
// ---------------------------------------------------------------------------

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7).replace('-', ''); // yyyymm
}

/**
 * assertWithinCap({ model }) — the guard every LLM call site MUST call BEFORE
 * invoking the model. Returns { ok: true } or { ok: false, reason, monthlySpend }.
 *
 * ok:false when ANY of:
 *   - model is NOT on the local allowlist (the primary guard — paid/unknown route)
 *   - month-to-date dollars > 0 (any real spend at all is anomalous)
 *   - month-to-date dollars >= KILL_MONTHLY_USD (belt-and-suspenders)
 *
 * This story delivers the module + the contract; the call sites that act on
 * ok:false (skip call, label issue, write kill-flag, email Ra'uf) land in
 * PIPE-LOCAL-TRIAGE-001 / PIPE-LOCAL-FIX-001 (AC8/AC11). writeKillFlag() and
 * tripwireEmailPayload() below give those daemons what they need.
 */
async function assertWithinCap(opts) {
  const model = opts && opts.model;
  const monthly = await getMonthlyTotals(currentMonthKey());
  const monthlySpend = monthly.dollars;

  if (typeof model !== 'string' || !isAllowlisted(model)) {
    return {
      ok: false,
      reason: 'model-off-allowlist: ' + String(model),
      monthlySpend: monthlySpend,
    };
  }
  if (monthlySpend >= KILL_MONTHLY_USD) {
    return {
      ok: false,
      reason: 'monthly-spend-at-kill-threshold: $' + monthlySpend.toFixed(2) +
              ' >= $' + KILL_MONTHLY_USD,
      monthlySpend: monthlySpend,
    };
  }
  if (monthlySpend > 0) {
    return {
      ok: false,
      reason: 'nonzero-monthly-spend: $' + monthlySpend.toFixed(2) +
              ' (any real spend is anomalous for a local pipeline)',
      monthlySpend: monthlySpend,
    };
  }
  return { ok: true };
}

/**
 * isCapTripped() — true if the kill-flag file exists for the current month.
 * (A stale flag from a prior month is treated as not-tripped this month.)
 */
function isCapTripped() {
  const p = killFlagPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw new Error('cost-cap: kill-flag unreadable at ' + p + ': ' + err.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('cost-cap: corrupt kill-flag at ' + p + ': ' + err.message);
  }
  return parsed && parsed.month === currentMonthKey();
}

/**
 * writeKillFlag({ reason }) — write ~/.pipeline-cost-cap-tripped so the daemon
 * stops attempting LLM calls this month. Called by the daemon when
 * assertWithinCap returns ok:false (AC8). Returns the written record.
 */
function writeKillFlag(opts) {
  const reason = (opts && opts.reason) || 'cost-cap-tripped';
  const record = {
    month: currentMonthKey(),
    reason: reason,
    ts: new Date().toISOString(),
  };
  const p = killFlagPath();
  fs.writeFileSync(p, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * resetCap() — manual reset: remove the kill-flag file (AC9). No-op if absent.
 * Returns true if a flag was removed, false if none existed.
 */
function resetCap() {
  const p = killFlagPath();
  try {
    fs.unlinkSync(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw new Error('cost-cap: could not remove kill-flag at ' + p + ': ' + err.message);
  }
}

/**
 * tripwireEmailPayload(capResult) — build the subject/text for the
 * `cost-cap-tripped` notification. The actual SEND reuses the EXISTING
 * PIPE-NOTIFY owner-email transport (workers/bug-webhook send-owner-email) —
 * this module deliberately does NOT send mail (no second mailer). The consuming
 * daemon (PIPE-LOCAL-TRIAGE-001 / PIPE-LOCAL-FIX-001) passes this payload to the
 * heartbeat/notify path that already reaches the Worker. AC16.
 */
function tripwireEmailPayload(capResult) {
  const reason = (capResult && capResult.reason) || 'unknown';
  const spend = capResult && typeof capResult.monthlySpend === 'number'
    ? capResult.monthlySpend.toFixed(2)
    : '0.00';
  return {
    subject: '[bug-pipeline] cost-cap tripped — LLM calls halted',
    text:
      'The bug pipeline cost-cap tripped and further LLM calls are halted for ' +
      'the current month.\n\n' +
      'Reason: ' + reason + '\n' +
      'Month-to-date spend: $' + spend + '\n' +
      'Kill threshold: $' + KILL_MONTHLY_USD + '\n\n' +
      'For a correct local-only pipeline this should never happen ($0 by ' +
      'construction). Investigate which call escaped the local Ollama allowlist.\n\n' +
      'To resume after fixing the route: delete ' + killFlagPath() + '\n',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // meter
  recordCall,
  getDailyTotals,
  getMonthlyTotals,
  // classification (exported for tests / report)
  classify,
  isAllowlisted,
  // cap / tripwire
  assertWithinCap,
  isCapTripped,
  writeKillFlag,
  resetCap,
  tripwireEmailPayload,
  // config (read-only references for report/tests/daemons)
  ALLOWLIST,
  PAID_ROUTE_PRICE_MAP,
  WARN_MONTHLY_USD,
  KILL_MONTHLY_USD,
  SOFT_DAILY_USD,
  VALID_ROLES,
  // path helpers (for tests + report)
  _ledgerPath: ledgerPath,
  _killFlagPath: killFlagPath,
  DEFAULT_LEDGER_PATH,
  DEFAULT_KILL_FLAG_PATH,
};
