/**
 * Story 2.4a: Real Triage Command
 *
 * Fetches a real GitHub issue from the private repo, classifies it using Haiku,
 * and feeds the result to routing for automatic dispatch or labeling.
 *
 * Signal path: webhook fires `analyze` -> CI triages -> routes to pipeline
 *
 * This reuses the core classification logic from bug-triage.ts but operates
 * against real GitHub issues instead of test fixtures.
 *
 * Exit codes:
 * - 0: Success (triage + routing completed)
 * - 1: Failure (API error, invalid issue, classification failure)
 */

import { execSync } from "node:child_process";
import { ROUTING } from "../config.js";
import { runTriage, type TriageResult } from "./bug-triage.js";
import { decideRoute, executeRoute, type RoutingInput } from "../lib/routing.js";
import { stripBase64Images } from "../lib/image-extract.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the real triage command */
export interface RealTriageInput {
  /** GitHub issue number on the private repo */
  issueNumber: number;
}

/** Result from the real triage command */
export interface RealTriageResult {
  /** Issue number that was triaged */
  issueNumber: number;
  /** Triage classification result */
  triage: TriageResult;
  /** Whether routing was executed */
  routed: boolean;
  /** Error message if something went wrong */
  error: string | null;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

/** Fetch issue title and body from the private repo using gh CLI */
function fetchIssue(issueNumber: number): { title: string; body: string; labels: string[] } {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[triage] Fetching issue #" + issueNumber + " from " + repo);

  let issueJson: string;
  try {
    issueJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json title,body,labels",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error("Failed to fetch issue #" + issueNumber + " from " + repo + ": " + errMsg);
  }

  let parsed: { title: string; body: string; labels: { name: string }[] };
  try {
    parsed = JSON.parse(issueJson) as { title: string; body: string; labels: { name: string }[] };
  } catch (err: unknown) {
    throw new Error("Failed to parse issue JSON from gh CLI: " + issueJson);
  }

  if (!parsed.title) {
    throw new Error("Issue #" + issueNumber + " has no title");
  }

  const labels = (parsed.labels ?? []).map((l) => l.name);
  console.log("[triage] Issue title: " + parsed.title);
  console.log("[triage] Labels: [" + labels.join(", ") + "]");

  return {
    title: parsed.title,
    body: parsed.body ?? "",
    labels,
  };
}

/** Post a comment on the issue in the private repo */
function postIssueComment(issueNumber: number, comment: string): void {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[triage] Posting comment on " + repo + "#" + issueNumber);

  try {
    execSync(
      "gh issue comment " + issueNumber + " --repo " + repo + " --body " + JSON.stringify(comment),
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[triage] Comment posted successfully");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[triage] WARNING: Failed to post comment on issue #" + issueNumber + ": " + errMsg);
    // Non-fatal: the triage still succeeded even if comment fails
  }
}

// ---------------------------------------------------------------------------
// Main triage function
// ---------------------------------------------------------------------------

/**
 * Run real triage on a GitHub issue.
 *
 * 1. Fetches issue from private repo
 * 2. Classifies with Haiku (reuses bug-triage.ts)
 * 3. Posts classification comment on issue
 * 4. Feeds result to routing (dispatch or label)
 * 5. Posts routing comment on issue
 */
export async function runRealTriage(input: RealTriageInput): Promise<RealTriageResult> {
  const issueNumber = input.issueNumber;
  console.log("=== Story 2.4a: Real Triage — Issue #" + issueNumber + " ===");
  console.log("");

  // --------------------------------------------------
  // Step 1: Fetch issue from private repo
  // --------------------------------------------------
  let issueData: { title: string; body: string; labels: string[] };
  try {
    issueData = fetchIssue(issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[triage] FATAL: " + errMsg);

    // Try to post error comment (may also fail if PAT issue)
    try {
      postIssueComment(
        issueNumber,
        "## Triage Failed\n\nCould not fetch this issue for triage.\n\n**Error:** " + errMsg,
      );
    } catch {
      // Silently ignore — we already logged the primary error
    }

    process.exit(1);
  }

  // Check idempotency: skip if already routed
  if (issueData.labels.includes(ROUTING.LABEL_ROUTED)) {
    console.log("[triage] Issue #" + issueNumber + " already has `" + ROUTING.LABEL_ROUTED + "` label — skipping");
    return {
      issueNumber,
      triage: {
        classification: "skip",
        confidence: 1,
        severity: "P4",
        reasoning: "Already routed",
        extracted_context: {},
        routing_recommendation: "skip",
      },
      routed: false,
      error: null,
    };
  }

  // --------------------------------------------------
  // Step 2: Classify with Haiku
  // --------------------------------------------------
  console.log("");
  console.log("--- Classifying issue #" + issueNumber + " ---");

  // Build report text from issue title + body, stripping base64 images
  const reportText = issueData.title + "\n\n" + issueData.body;
  const cleanReportText = stripBase64Images(reportText);

  let triageResult: TriageResult;
  try {
    triageResult = await runTriage({
      report_text: cleanReportText,
      report_id: "issue-" + issueNumber,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[triage] FATAL: Classification failed: " + errMsg);

    postIssueComment(
      issueNumber,
      "## Triage Failed\n\nClassification could not be completed.\n\n**Error:** " + errMsg,
    );

    process.exit(1);
  }

  // --------------------------------------------------
  // Step 3: Post classification comment (AC4)
  // --------------------------------------------------
  console.log("");
  console.log("--- Posting classification comment ---");

  const classificationComment = buildClassificationComment(triageResult);
  postIssueComment(issueNumber, classificationComment);

  // --------------------------------------------------
  // Step 4: Route based on classification (AC2)
  // --------------------------------------------------
  console.log("");
  console.log("--- Routing issue #" + issueNumber + " ---");

  const routingInput: RoutingInput = {
    classification: triageResult.classification,
    severity: triageResult.severity,
    confidence: triageResult.confidence,
    extracted_context: triageResult.extracted_context,
    issue_number: issueNumber,
    existing_labels: issueData.labels,
  };

  // Handle unknown/unextractable category for content_error (AC5)
  if (triageResult.classification === "content_error") {
    const category = triageResult.extracted_context.category;
    if (!category || (typeof category === "string" && category.trim() === "")) {
      console.log("[triage] Content error detected but category unclear — posting comment and labeling");
      postIssueComment(
        issueNumber,
        "## Triage: Content Error Detected\n\n" +
          "Content error detected but category could not be determined.\n" +
          "Manual review needed to identify the correct category.\n\n" +
          "**Classification:** " + triageResult.classification + "\n" +
          "**Confidence:** " + triageResult.confidence + "\n" +
          "**Severity:** " + triageResult.severity,
      );

      // Apply needs-triage label instead of routing to pipeline (AC5)
      try {
        const dryRun = process.env.DRY_RUN === "true";
        await executeRoute(
          {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            issue_number: issueNumber,
            labels: [ROUTING.LABEL_NEEDS_TRIAGE, ROUTING.LABEL_CONTENT_ERROR],
          },
          dryRun,
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[triage] WARNING: Failed to apply labels: " + errMsg);
      }

      return {
        issueNumber,
        triage: triageResult,
        routed: false,
        error: null,
      };
    }
  }

  // Normal routing
  const routingAction = decideRoute(routingInput);

  // Execute the routing action
  // Note: For content_error dispatch, routing.ts now applies sdk-routed + content-error
  // labels automatically via the issue_labels field on the dispatch action (HIGH-4 fix).
  const dryRun = process.env.DRY_RUN === "true";
  try {
    await executeRoute(routingAction, dryRun);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[triage] FATAL: Routing failed: " + errMsg);

    postIssueComment(
      issueNumber,
      "## Routing Failed\n\n" +
        "Triage classified this issue as **" + triageResult.classification + "** " +
        "but routing could not complete.\n\n" +
        "**Error:** " + errMsg,
    );

    process.exit(1);
  }

  // --------------------------------------------------
  // Step 5: Post routing comment (AC4)
  // --------------------------------------------------
  const routingComment = buildRoutingComment(triageResult, routingAction);
  postIssueComment(issueNumber, routingComment);

  console.log("");
  console.log("=== Triage COMPLETE — Issue #" + issueNumber + ": " + triageResult.classification + " (" + triageResult.severity + ") ===");

  return {
    issueNumber,
    triage: triageResult,
    routed: true,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Comment builders
// ---------------------------------------------------------------------------

/** Build the classification result comment (AC4) */
function buildClassificationComment(triage: TriageResult): string {
  const lines = [
    "## Triage Classification",
    "",
    "| Field | Value |",
    "|-------|-------|",
    "| Classification | `" + triage.classification + "` |",
    "| Severity | `" + triage.severity + "` |",
    "| Confidence | " + (triage.confidence * 100).toFixed(0) + "% |",
    "",
    "**Reasoning:** " + triage.reasoning,
  ];

  if (Object.keys(triage.extracted_context).length > 0) {
    lines.push("");
    lines.push("**Extracted context:** `" + JSON.stringify(triage.extracted_context) + "`");
  }

  return lines.join("\n");
}

/** Build the routing action comment (AC4) */
function buildRoutingComment(
  triage: TriageResult,
  action: ReturnType<typeof decideRoute>,
): string {
  switch (action.type) {
    case "dispatch":
      return "Routing to content pipeline... Dispatching `" + action.event_type + "` to `" + action.repo + "`.";

    case "label":
      return "Labeled as `" + triage.classification + "` -- manual triage needed.";

    case "label_and_state":
      return "Labeled as `" + triage.classification + "` and queued for " + action.workflow_type + " pipeline.";

    case "skip":
      return "Skipped: " + action.reason;

    default:
      return "Routing completed.";
  }
}
