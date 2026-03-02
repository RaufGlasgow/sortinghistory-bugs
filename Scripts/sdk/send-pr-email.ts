/**
 * Entry point for sending PR created email from GitHub Actions YAML.
 *
 * Reads all parameters from environment variables and calls sendPRCreatedEmail().
 * Exit code 0 always — email failure must never break the pipeline.
 *
 * Required env vars: RESEND_API_KEY, OWNER_EMAIL
 * Required env vars (data): PR_URL, PR_NUMBER, ISSUE_NUMBER, ISSUE_TITLE,
 *   FILES_MODIFIED, COMPILATION, CONFIDENCE, FIX_ATTEMPTS, PIPELINE_MODE
 * Optional env vars: AUTH_TOKEN (for reject button), ALPHA_VERSION,
 *   ISSUE_BODY_FILE (path to file with issue body), QA_SUMMARY_FILE (path to QA summary),
 *   DIFF_SUMMARY_FILE (path to file with git diff --stat output)
 */

import { readFileSync } from "node:fs";
import { sendPRCreatedEmail } from "./lib/notification.js";

function readFileSafe(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const prUrl = process.env.PR_URL;
  const prNumber = process.env.PR_NUMBER;
  const issueNumber = process.env.ISSUE_NUMBER;
  const issueTitle = process.env.ISSUE_TITLE;

  if (!prUrl || !prNumber || !issueNumber || !issueTitle) {
    console.log("[send-pr-email] Missing required env vars (PR_URL, PR_NUMBER, ISSUE_NUMBER, ISSUE_TITLE) — skipping");
    return;
  }

  await sendPRCreatedEmail({
    issueNumber: parseInt(issueNumber, 10),
    issueTitle,
    prNumber: parseInt(prNumber, 10),
    prUrl,
    filesModified: process.env.FILES_MODIFIED || "unknown",
    compilation: process.env.COMPILATION || "unknown",
    confidence: process.env.CONFIDENCE || "unknown",
    fixAttempts: parseInt(process.env.FIX_ATTEMPTS || "1", 10),
    alphaVersion: process.env.ALPHA_VERSION || undefined,
    pipelineMode: process.env.PIPELINE_MODE || "full",
    issueBody: readFileSafe(process.env.ISSUE_BODY_FILE),
    qaSummary: readFileSafe(process.env.QA_SUMMARY_FILE),
    diffSummary: readFileSafe(process.env.DIFF_SUMMARY_FILE),
  });
}

main().catch((err) => {
  console.error("[send-pr-email] Unexpected error:", err);
  // Never exit non-zero — email failure must not break the pipeline
});
