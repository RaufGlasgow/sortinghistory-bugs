'use strict';

/**
 * cost-cap.test.js — PIPE-OBSERVE-FOUNDATION (paid-route tripwire)
 * Runner: node:test (zero-dep). Run: node --test Scripts/lib/__tests__/
 *
 * Isolates BOTH the ledger (PIPELINE_COST_METER_PATH) and the kill-flag
 * (PIPELINE_COST_CAP_FLAG_PATH) to a temp dir so the real $HOME flag and
 * repo-root ledger are never touched.
 *
 * Tests exercise the cap surface via cost-cap.js (the re-export module) to
 * prove that path resolves to the single cost-meter.js implementation.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let cap;
let meter;

function freshEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-cap-test-'));
  process.env.PIPELINE_COST_METER_PATH = path.join(tmpDir, 'pipeline-cost-meter.jsonl');
  process.env.PIPELINE_COST_CAP_FLAG_PATH = path.join(tmpDir, 'kill-flag.json');
  delete require.cache[require.resolve('../cost-meter')];
  delete require.cache[require.resolve('../cost-cap')];
  meter = require('../cost-meter');
  cap = require('../cost-cap');
}

beforeEach(function () {
  freshEnv();
});

afterEach(function () {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  delete process.env.PIPELINE_COST_METER_PATH;
  delete process.env.PIPELINE_COST_CAP_FLAG_PATH;
});

function thisMonthKey() {
  return new Date().toISOString().slice(0, 7).replace('-', '');
}

// ---------------------------------------------------------------------------

test('allowlisted model + $0 spend -> ok:true', async function () {
  const res = await cap.assertWithinCap({ model: 'qwen2.5:14b' });
  assert.deepStrictEqual(res, { ok: true });
});

test('off-allowlist model -> ok:false with reason (primary guard)', async function () {
  const res = await cap.assertWithinCap({ model: 'gpt-4o' });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /model-off-allowlist: gpt-4o/);
  assert.strictEqual(typeof res.monthlySpend, 'number');
});

test('undefined model -> ok:false (treated as off-allowlist)', async function () {
  const res = await cap.assertWithinCap({});
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /model-off-allowlist/);
});

test('nonzero monthly spend -> ok:false even for an allowlisted model', async function () {
  // Record a paid call THIS month so monthly dollars > 0.
  const ts = new Date().toISOString();
  await meter.recordCall({
    runId: 'paid-this-month',
    bugId: 1,
    role: 'triage',
    model: 'gpt-4o',
    promptHash: 'h',
    inputTokens: 1000000,
    outputTokens: 0,
    latencyMs: 1,
    ts: ts,
  });
  const res = await cap.assertWithinCap({ model: 'qwen2.5:14b' });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /nonzero-monthly-spend/);
  assert.ok(res.monthlySpend > 0);
});

test('daily soft-warn does NOT block (cap still ok:true on an allowlisted $0 path)', async function () {
  // A pure-allowlisted day keeps dollars at $0; assertWithinCap stays ok.
  await meter.recordCall({
    runId: 'soft-1', bugId: 2, role: 'triage', model: 'qwen3:32b',
    promptHash: 'h', inputTokens: 10, outputTokens: 1, latencyMs: 5,
    ts: new Date().toISOString(),
  });
  const res = await cap.assertWithinCap({ model: 'qwen3:32b' });
  assert.deepStrictEqual(res, { ok: true }, 'soft-daily is warn-only, never blocks');
});

test('writeKillFlag writes JSON {month,reason,ts}; isCapTripped sees it', function () {
  assert.strictEqual(cap.isCapTripped(), false, 'no flag initially');
  const rec = cap.writeKillFlag({ reason: 'model-off-allowlist: gpt-4o' });
  assert.strictEqual(rec.month, thisMonthKey());
  assert.match(rec.reason, /gpt-4o/);
  assert.ok(rec.ts);
  assert.strictEqual(cap.isCapTripped(), true, 'flag present for this month -> tripped');

  const onDisk = JSON.parse(fs.readFileSync(process.env.PIPELINE_COST_CAP_FLAG_PATH, 'utf8'));
  assert.strictEqual(onDisk.month, thisMonthKey());
});

test('reset (kill-flag removal) clears state', function () {
  cap.writeKillFlag({ reason: 'x' });
  assert.strictEqual(cap.isCapTripped(), true);
  const removed = cap.resetCap();
  assert.strictEqual(removed, true, 'resetCap returns true when a flag existed');
  assert.strictEqual(cap.isCapTripped(), false, 'state cleared after reset');
  assert.strictEqual(cap.resetCap(), false, 'reset is a no-op when nothing to remove');
});

test('a stale flag from a different month is NOT treated as tripped this month', function () {
  fs.writeFileSync(
    process.env.PIPELINE_COST_CAP_FLAG_PATH,
    JSON.stringify({ month: '209901', reason: 'old', ts: '2099-01-01T00:00:00.000Z' }) + '\n',
    'utf8'
  );
  assert.strictEqual(cap.isCapTripped(), false, 'prior-month flag does not trip current month');
});

test('tripwireEmailPayload builds subject/text from a cap result (no mail sent here)', function () {
  const payload = cap.tripwireEmailPayload({ ok: false, reason: 'model-off-allowlist: gpt-4o', monthlySpend: 0 });
  assert.match(payload.subject, /cost-cap tripped/);
  assert.match(payload.text, /model-off-allowlist: gpt-4o/);
  assert.match(payload.text, /delete /, 'tells the reader how to reset');
});

test('cost-cap.js re-exports the SAME constants as cost-meter.js (single source)', function () {
  assert.strictEqual(cap.KILL_MONTHLY_USD, meter.KILL_MONTHLY_USD);
  assert.strictEqual(cap.WARN_MONTHLY_USD, meter.WARN_MONTHLY_USD);
  assert.strictEqual(cap.SOFT_DAILY_USD, meter.SOFT_DAILY_USD);
  assert.strictEqual(cap.assertWithinCap, meter.assertWithinCap);
});
