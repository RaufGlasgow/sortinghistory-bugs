/**
 * Story 3.6 AC1: CLI entry point for digest health metrics.
 *
 * Called by the GitHub Actions daily digest workflow to get the
 * System Health HTML section from workflow state files.
 *
 * Usage:
 *   npx tsx Scripts/sdk/lib/health-metrics-cli.ts
 *
 * Output: HTML to stdout (for injection into the digest email).
 *
 * If no state files exist, outputs a "No pipeline data yet" message
 * (computeHealthMetrics handles empty input gracefully).
 */

import { listWorkflowStates } from "./state.js";
import { computeHealthMetrics, buildHealthSectionHtml } from "./health-metrics.js";

const states = await listWorkflowStates();
const metrics = computeHealthMetrics(states);
const html = buildHealthSectionHtml(metrics);
process.stdout.write(html);
