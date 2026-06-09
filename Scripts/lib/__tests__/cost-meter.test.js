'use strict';

/**
 * cost-meter.test.js — PIPE-OBSERVE-FOUNDATION
 * Runner: node:test (zero-dep; the root Scripts/ has no other test runner).
 * Run:    node --test Scripts/lib/__tests__/
 *
 * Each test isolates the ledger to a temp file via PIPELINE_COST_METER_PATH so
 * the real repo-root pipeline-cost-meter.jsonl is never touched.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let meter;

function freshLedgerEnv() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-meter-test-'));
  process.env.PIPELINE_COST_METER_PATH = path.join(tmpDir, 'pipeline-cost-meter.jsonl');
  // Reload module so any cached path is re-evaluated (path is read lazily, but
  // a fresh require is cheap and keeps tests hermetic).
  delete require.cache[require.resolve('../cost-meter')];
  meter = require('../cost-meter');
}

function readLedger() {
  const p = process.env.PIPELINE_COST_METER_PATH;
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(function (l) { return l.trim().length > 0; })
    .map(function (l) { return JSON.parse(l); });
}

beforeEach(function () {
  freshLedgerEnv();
});

afterEach(function () {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  delete process.env.PIPELINE_COST_METER_PATH;
});

// ---------------------------------------------------------------------------

test('allowlisted model -> dollars=0, paid_route=false, one row, correct shape', async function () {
  await meter.recordCall({
    runId: 'bug42-triage-1',
    bugId: 42,
    role: 'triage',
    model: 'qwen2.5:14b',
    promptHash: 'abc123',
    inputTokens: 1000,
    outputTokens: 200,
    latencyMs: 850,
    ts: '2026-06-09T10:00:00.000Z',
  });

  const rows = readLedger();
  assert.strictEqual(rows.length, 1, 'exactly one row appended');
  const r = rows[0];

  // AC2 row shape — every required field present with ASCII snake_case keys.
  assert.deepStrictEqual(
    Object.keys(r).sort(),
    [
      'bug_id', 'dollars', 'input_tokens', 'latency_ms', 'model',
      'output_tokens', 'paid_route', 'prompt_hash', 'role', 'run_id', 'ts',
    ].sort()
  );
  assert.strictEqual(r.run_id, 'bug42-triage-1');
  assert.strictEqual(r.bug_id, 42);
  assert.strictEqual(r.role, 'triage');
  assert.strictEqual(r.model, 'qwen2.5:14b');
  assert.strictEqual(r.prompt_hash, 'abc123');
  assert.strictEqual(r.input_tokens, 1000);
  assert.strictEqual(r.output_tokens, 200);
  assert.strictEqual(r.latency_ms, 850);
  assert.strictEqual(r.dollars, 0, 'allowlisted -> $0');
  assert.strictEqual(r.paid_route, false, 'allowlisted -> not paid route');
});

test('idempotency: re-recording the same run_id is a no-op', async function () {
  const call = {
    runId: 'bug7-fix-primary-1',
    bugId: 7,
    role: 'fix-primary',
    model: 'qwen3:32b',
    promptHash: 'h',
    inputTokens: 500,
    outputTokens: 100,
    latencyMs: 1200,
    ts: '2026-06-09T11:00:00.000Z',
  };
  await meter.recordCall(call);
  await meter.recordCall(call);
  await meter.recordCall(Object.assign({}, call, { inputTokens: 999999 })); // same run_id, different payload

  const rows = readLedger();
  assert.strictEqual(rows.length, 1, 'duplicate run_id not appended');
  assert.strictEqual(rows[0].input_tokens, 500, 'first write wins; no overwrite');
});

test('off-allowlist priced model -> paid_route=true, correct dollar math', async function () {
  // gpt-4o price map: input $2.50/MTok, output $10.00/MTok.
  // 1,000,000 in + 500,000 out = 2.50 + 5.00 = 7.50
  await meter.recordCall({
    runId: 'stray-1',
    bugId: 'stray',
    role: 'triage',
    model: 'gpt-4o',
    promptHash: 'x',
    inputTokens: 1000000,
    outputTokens: 500000,
    latencyMs: 300,
    ts: '2026-06-09T12:00:00.000Z',
  });
  const r = readLedger()[0];
  assert.strictEqual(r.paid_route, true);
  assert.ok(Math.abs(r.dollars - 7.5) < 1e-9, 'dollars should be 7.50, got ' + r.dollars);
});

test('unknown model THROWS (never a silent zero) and writes no row', async function () {
  await assert.rejects(
    function () {
      return meter.recordCall({
        runId: 'unknown-1',
        bugId: 1,
        role: 'triage',
        model: 'totally-unknown-model:99b',
        promptHash: 'x',
        inputTokens: 10,
        outputTokens: 10,
        latencyMs: 10,
        ts: '2026-06-09T13:00:00.000Z',
      });
    },
    /missing-model-classification: totally-unknown-model:99b/
  );
  assert.strictEqual(readLedger().length, 0, 'no row written on classification throw');
});

test('invalid role throws', async function () {
  await assert.rejects(
    function () {
      return meter.recordCall({
        runId: 'r',
        bugId: 1,
        role: 'not-a-role',
        model: 'qwen2.5:14b',
        promptHash: 'x',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      });
    },
    /invalid role/
  );
});

test('missing runId throws (idempotency key required)', async function () {
  await assert.rejects(
    function () {
      return meter.recordCall({
        bugId: 1, role: 'triage', model: 'qwen2.5:14b',
        promptHash: 'x', inputTokens: 1, outputTokens: 1, latencyMs: 1,
      });
    },
    /runId is required/
  );
});

test('daily + monthly aggregation incl. latency p50, byRole, byModel', async function () {
  // 4 calls same day: latencies 100, 200, 300, 400 -> p50 = (200+300)/2 = 250
  const base = {
    bugId: 5, model: 'qwen2.5:14b', promptHash: 'h',
  };
  await meter.recordCall(Object.assign({}, base, { runId: 'a', role: 'triage', inputTokens: 10, outputTokens: 1, latencyMs: 100, ts: '2026-06-09T01:00:00.000Z' }));
  await meter.recordCall(Object.assign({}, base, { runId: 'b', role: 'triage', inputTokens: 20, outputTokens: 2, latencyMs: 200, ts: '2026-06-09T02:00:00.000Z' }));
  await meter.recordCall(Object.assign({}, base, { runId: 'c', role: 'fix-primary', model: 'qwen3:32b', inputTokens: 30, outputTokens: 3, latencyMs: 300, ts: '2026-06-09T03:00:00.000Z' }));
  await meter.recordCall(Object.assign({}, base, { runId: 'd', role: 'fix-primary', model: 'qwen3:32b', inputTokens: 40, outputTokens: 4, latencyMs: 400, ts: '2026-06-09T04:00:00.000Z' }));
  // one call in a different day (should NOT appear in the 0609 daily total)
  await meter.recordCall(Object.assign({}, base, { runId: 'e', role: 'triage', inputTokens: 1000, outputTokens: 100, latencyMs: 999, ts: '2026-06-10T01:00:00.000Z' }));

  const day = await meter.getDailyTotals('20260609');
  assert.strictEqual(day.calls, 4);
  assert.strictEqual(day.inputTokens, 100); // 10+20+30+40
  assert.strictEqual(day.outputTokens, 10);  // 1+2+3+4
  assert.strictEqual(day.dollars, 0);
  assert.strictEqual(day.paidRouteTrips, 0);
  assert.strictEqual(day.latencyP50Ms, 250, 'p50 of [100,200,300,400] = 250');
  assert.strictEqual(day.byRole.triage.calls, 2);
  assert.strictEqual(day.byRole['fix-primary'].calls, 2);
  assert.strictEqual(day.byModel['qwen2.5:14b'].calls, 2);
  assert.strictEqual(day.byModel['qwen3:32b'].calls, 2);

  const month = await meter.getMonthlyTotals('202606');
  assert.strictEqual(month.calls, 5, 'monthly includes the 06-10 call too');
  assert.strictEqual(month.inputTokens, 1100); // 100 + 1000
});

test('paidRouteTrips counted in aggregation', async function () {
  await meter.recordCall({ runId: 'ok', bugId: 1, role: 'triage', model: 'qwen2.5:14b', promptHash: 'h', inputTokens: 1, outputTokens: 1, latencyMs: 1, ts: '2026-06-09T05:00:00.000Z' });
  await meter.recordCall({ runId: 'paid', bugId: 1, role: 'triage', model: 'gpt-4o-mini', promptHash: 'h', inputTokens: 1000000, outputTokens: 0, latencyMs: 1, ts: '2026-06-09T06:00:00.000Z' });
  const month = await meter.getMonthlyTotals('202606');
  assert.strictEqual(month.paidRouteTrips, 1);
  assert.ok(month.dollars > 0, 'paid call contributes dollars');
});

test('missing ledger file -> aggregation returns zeros (created, not crashed)', async function () {
  const day = await meter.getDailyTotals('20260609');
  assert.strictEqual(day.calls, 0);
  assert.strictEqual(day.latencyP50Ms, 0);
  assert.deepStrictEqual(day.byRole, {});
});

test('corrupt ledger row -> read THROWS (no silent skip)', async function () {
  const p = process.env.PIPELINE_COST_METER_PATH;
  fs.writeFileSync(p, '{"ts":"2026-06-09T00:00:00.000Z","run_id":"good"}\nNOT JSON\n', 'utf8');
  await assert.rejects(
    function () { return meter.getMonthlyTotals('202606'); },
    /corrupt ledger row/
  );
});

test('classify(): allowlisted vs priced vs unknown', function () {
  assert.deepStrictEqual(meter.classify('qwen3:32b', 100, 100), { paidRoute: false, dollars: 0 });
  const priced = meter.classify('gpt-4o', 1000000, 0);
  assert.strictEqual(priced.paidRoute, true);
  assert.ok(Math.abs(priced.dollars - 2.5) < 1e-9);
  assert.throws(function () { meter.classify('nope', 1, 1); }, /missing-model-classification/);
});
