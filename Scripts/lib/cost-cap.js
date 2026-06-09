/**
 * cost-cap.js — PIPE-OBSERVE-FOUNDATION (paid-route tripwire)
 *
 * The story lists cost-cap.js as a file path AND says "single shared module is
 * acceptable and preferred over duplication." To honor BOTH the centralization
 * rule and the named file path, the cap logic has ONE implementation (in
 * cost-meter.js) and this module re-exports the cap surface. No duplicated
 * policy constants, no second source of truth.
 *
 * Cap surface (see cost-meter.js for behavior):
 *   - assertWithinCap({ model }) -> { ok } | { ok:false, reason, monthlySpend }
 *   - isCapTripped()             -> boolean (kill-flag present for current month)
 *   - writeKillFlag({ reason })  -> record (daemon writes when cap trips)
 *   - resetCap()                 -> boolean (manual reset: delete kill-flag)
 *   - tripwireEmailPayload(cap)  -> { subject, text } for the EXISTING owner-email path
 *   - ALLOWLIST, WARN_MONTHLY_USD, KILL_MONTHLY_USD, SOFT_DAILY_USD
 */

'use strict';

const meter = require('./cost-meter');

module.exports = {
  assertWithinCap: meter.assertWithinCap,
  isCapTripped: meter.isCapTripped,
  writeKillFlag: meter.writeKillFlag,
  resetCap: meter.resetCap,
  tripwireEmailPayload: meter.tripwireEmailPayload,
  ALLOWLIST: meter.ALLOWLIST,
  WARN_MONTHLY_USD: meter.WARN_MONTHLY_USD,
  KILL_MONTHLY_USD: meter.KILL_MONTHLY_USD,
  SOFT_DAILY_USD: meter.SOFT_DAILY_USD,
  _killFlagPath: meter._killFlagPath,
};
