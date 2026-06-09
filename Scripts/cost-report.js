#!/usr/bin/env node
/**
 * cost-report.js — PIPE-OBSERVE-FOUNDATION
 *
 * Local CLI spend/token/latency report. Replaces the retired v2 Worker route
 * /admin/cost-report (the pipeline is local-only now). Reads the JSONL ledger
 * and prints the monthly summary plus by-model / by-role breakdowns.
 *
 * Usage:
 *   node Scripts/cost-report.js --month 2026-06
 *   node Scripts/cost-report.js --month 2026-06 --json
 *
 * --month YYYY-MM is required. --json prints the raw aggregate object.
 */

'use strict';

const meter = require('./lib/cost-meter');

function parseArgs(argv) {
  const args = { month: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') {
      args.month = argv[i + 1];
      i++;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
    }
  }
  return args;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function usage() {
  console.log('Usage: node Scripts/cost-report.js --month YYYY-MM [--json]');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.month || !/^\d{4}-\d{2}$/.test(args.month)) {
    console.error('error: --month YYYY-MM is required (e.g. --month 2026-06)');
    usage();
    process.exit(2);
  }

  const yyyymm = args.month.replace('-', '');
  let totals;
  try {
    totals = await meter.getMonthlyTotals(yyyymm);
  } catch (err) {
    console.error('error: ' + err.message);
    process.exit(1);
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(totals, null, 2));
    return;
  }

  console.log('==========================================================');
  console.log(' Bug pipeline cost report — ' + args.month + '  (' + meter._ledgerPath() + ')');
  console.log('==========================================================');
  console.log(' calls            : ' + totals.calls);
  console.log(' input tokens     : ' + totals.inputTokens);
  console.log(' output tokens    : ' + totals.outputTokens);
  console.log(' dollars (USD)    : $' + totals.dollars.toFixed(6));
  console.log(' paid-route trips : ' + totals.paidRouteTrips +
              (totals.paidRouteTrips > 0 ? '   <-- ANOMALY: a call escaped the local allowlist' : ''));
  console.log(' latency p50 (ms) : ' + totals.latencyP50Ms);
  console.log('');

  console.log(' By role:');
  const roles = Object.keys(totals.byRole).sort();
  if (roles.length === 0) {
    console.log('   (none)');
  } else {
    console.log('   ' + pad('role', 16) + pad('calls', 8) + pad('in_tok', 12) + pad('out_tok', 12) + 'dollars');
    for (let i = 0; i < roles.length; i++) {
      const r = totals.byRole[roles[i]];
      console.log('   ' + pad(roles[i], 16) + pad(r.calls, 8) + pad(r.inputTokens, 12) +
                  pad(r.outputTokens, 12) + '$' + r.dollars.toFixed(6));
    }
  }
  console.log('');

  console.log(' By model:');
  const models = Object.keys(totals.byModel).sort();
  if (models.length === 0) {
    console.log('   (none)');
  } else {
    console.log('   ' + pad('model', 28) + pad('calls', 8) + pad('in_tok', 12) + pad('out_tok', 12) + 'dollars');
    for (let i = 0; i < models.length; i++) {
      const m = totals.byModel[models[i]];
      const flag = meter.isAllowlisted(models[i]) ? '' : '  [OFF-ALLOWLIST]';
      console.log('   ' + pad(models[i], 28) + pad(m.calls, 8) + pad(m.inputTokens, 12) +
                  pad(m.outputTokens, 12) + '$' + m.dollars.toFixed(6) + flag);
    }
  }
  console.log('==========================================================');
}

main().catch(function (err) {
  console.error('cost-report failed: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
});
