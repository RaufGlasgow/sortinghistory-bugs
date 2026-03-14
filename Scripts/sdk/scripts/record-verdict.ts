#!/usr/bin/env npx tsx
/**
 * record-verdict.ts — CLI wrapper for updateHumanVerdict()
 *
 * Usage:
 *   npx tsx scripts/record-verdict.ts <workflow_id> <verdict>
 *
 * Arguments:
 *   workflow_id  — The workflow ID (e.g. "bf-issue-157")
 *   verdict      — One of: "approved", "rejected", "reworked"
 *
 * Writes a TrainingVerdictEntry to state/training/raw/td-YYYY-MM-DD.jsonl
 *
 * Story 1.6: Human Verdict Training Data Integration
 */

import { updateHumanVerdict } from "../lib/training-capture.js";

const VALID_VERDICTS = ["approved", "rejected", "reworked"] as const;
type Verdict = (typeof VALID_VERDICTS)[number];

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npx tsx scripts/record-verdict.ts <workflow_id> <verdict>");
    console.error("  verdict must be one of: approved, rejected, reworked");
    process.exit(1);
  }

  const workflowId = args[0];
  const verdict = args[1];

  if (!workflowId) {
    console.error("ERROR: workflow_id is required");
    process.exit(1);
  }

  if (!VALID_VERDICTS.includes(verdict as Verdict)) {
    console.error(`ERROR: Invalid verdict '${verdict}' — must be one of: ${VALID_VERDICTS.join(", ")}`);
    process.exit(1);
  }

  console.log(`[record-verdict] Recording verdict '${verdict}' for workflow '${workflowId}'`);

  updateHumanVerdict(workflowId, verdict as Verdict);

  console.log("[record-verdict] Done.");
}

main();
