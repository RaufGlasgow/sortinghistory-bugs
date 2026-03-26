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
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTING, MODELS } from "../config.js";
import { runTriage, type TriageResult } from "./bug-triage.js";
import { decideRoute, executeRoute, type RoutingInput, type RoutingAction, type TriageHandoff } from "../lib/routing.js";
import { stripBase64Images, extractBase64Images } from "../lib/image-extract.js";
import { logRoutingDecision, type RoutingDecisionLogEntry } from "../lib/routing-log.js";
import { shouldSendEmail, sendActionNeededEmail } from "../lib/notification.js";
import { generateTriageHandoff, postHandoffComment } from "../lib/handoff-generator.js";
import type { TriageData } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Story 3.5: Contextual signal extraction for enhanced triage handoffs
// ---------------------------------------------------------------------------

const GAME_CATEGORIES = [
  "world history", "us history", "european history", "ancient history", "modern history",
  "science history", "technology history", "music history", "art history", "literature history",
  "sports history", "tv history", "film history", "food history", "fashion history",
  "military history", "space history", "medical history", "business history", "political history",
];

const GAME_MODES = [
  "daily challenge", "epic mode", "epic", "solo", "multiplayer", "timed mode",
];

/**
 * Extract contextual signals from a bug report for the triage handoff.
 * Story 3.5 AC2: Identifies what signals ARE present and what's missing.
 */
export function extractTriageSignals(body: string, title: string): {
  found: string[];
  missing: string[];
  suggestedSteps: string[];
} {
  const text = (body + " " + title).toLowerCase();
  const found: string[] = [];
  const missing: string[] = [];
  const suggestedSteps: string[] = [];

  // Check for category names
  const foundCategories = GAME_CATEGORIES.filter((cat) => text.includes(cat));
  if (foundCategories.length > 0) {
    found.push("category_name: " + foundCategories.join(", "));
    suggestedSteps.push("Check category assignment for events in: " + foundCategories.join(", "));
  } else {
    missing.push("no specific category name mentioned");
  }

  // Check for game mode references
  const foundModes = GAME_MODES.filter((mode) => text.includes(mode));
  if (foundModes.length > 0) {
    found.push("game_mode: " + foundModes.join(", "));
    suggestedSteps.push("Review game mode context: " + foundModes.join(", "));
  } else {
    missing.push("no game mode reference");
  }

  // Check for CurrentScreen field
  const screenMatch = body.match(/CurrentScreen:\s*(\w+)/i);
  if (screenMatch) {
    found.push("current_screen: " + screenMatch[1]);
  } else {
    missing.push("no CurrentScreen field");
  }

  // Check for language/locale signals
  const langSignals = ["german", "dutch", "portuguese", "translation", "translated", "sprache", "vertaling", "deutsch"];
  const foundLangs = langSignals.filter((l) => text.includes(l));
  if (foundLangs.length > 0) {
    found.push("language_signal: " + foundLangs.join(", "));
    suggestedSteps.push("Check translation files for referenced language");
  } else {
    missing.push("no language/translation signal");
  }

  // Check for event titles or specific dates
  const dateMatch = text.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  if (dateMatch) {
    found.push("date_reference: " + dateMatch[0]);
    suggestedSteps.push("Verify date accuracy for referenced event");
  } else {
    missing.push("no specific date mentioned");
  }

  // Check for error messages
  if (text.includes("error") || text.includes("crash") || text.includes("exception")) {
    found.push("error_keyword: present");
  } else {
    missing.push("no error message");
  }

  // Default suggestions if nothing specific found
  if (suggestedSteps.length === 0) {
    suggestedSteps.push("Review the full issue body for additional context");
    suggestedSteps.push("Ask the reporter for more details (screen, steps to reproduce)");
  }

  return { found, missing, suggestedSteps };
}

/**
 * Story 3.5: Guess relevant source files based on classification and context.
 * Returns file paths that might be related to the bug type.
 */
function guessRelevantFiles(classification: string, context: Record<string, unknown>): string[] {
  const files: string[] = [];

  // Add category-specific file if category is known
  const category = typeof context.category === "string" && context.category !== "unknown"
    ? context.category
    : null;
  if (category) {
    // Event JSON files use category name with spaces replaced
    const categoryFile = category.replace(/\s+/g, "");
    files.push("Data/Events/" + categoryFile + ".json");
  }

  // Classification-based file hints
  switch (classification) {
    case "content_error":
    case "content_category_error":
    case "content_duplicate":
      files.push("Data/Events/");
      break;
    case "translation_error":
      files.push("Data/Events/*_de.json", "Data/Events/*_nl.json", "Data/Events/*_pt.json", "Data/Events/*_es.json");
      break;
    case "ui_bug":
      files.push("Views/");
      break;
    case "gameplay_bug":
      files.push("ViewModels/GameManager.swift", "Models/");
      break;
    case "crash_bug":
      files.push("Core/", "SortingHistoryApp.swift");
      break;
    case "performance_issue":
      files.push("Core/Services/", "ViewModels/");
      break;
    case "code_bug":
      files.push("Core/Services/", "Models/");
      break;
    case "purchase_error":
      files.push("Core/Services/StoreKit/");
      break;
    case "data_corruption":
      files.push("Core/Services/PersistenceService.swift");
      break;
    case "multiplayer_error":
      files.push("Core/Services/MultipeerService.swift", "Views/Multiplayer/");
      break;
  }

  // Add file_path from context if present
  const filePath = typeof context.file_path === "string" && context.file_path !== "unknown"
    ? context.file_path
    : null;
  if (filePath) {
    files.push(filePath);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the real triage command */
export interface RealTriageInput {
  /** GitHub issue number on the private repo */
  issueNumber: number;
  /** Story 3.11: Owner correction notes from dispatch payload (optional) */
  correctionNotes?: string;
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

/** Fetch issue title, body, labels, and comments from the private repo using gh CLI */
function fetchIssue(issueNumber: number): { title: string; body: string; labels: string[]; comments: { body: string }[] } {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[triage] Fetching issue #" + issueNumber + " from " + repo);

  let issueJson: string;
  try {
    // Story 3.11 AC3: Also fetch comments for owner feedback extraction
    issueJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json title,body,labels,comments",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error("Failed to fetch issue #" + issueNumber + " from " + repo + ": " + errMsg);
  }

  let parsed: { title: string; body: string; labels: { name: string }[]; comments: { body: string }[] };
  try {
    parsed = JSON.parse(issueJson) as { title: string; body: string; labels: { name: string }[]; comments: { body: string }[] };
  } catch (err: unknown) {
    throw new Error("Failed to parse issue JSON from gh CLI: " + issueJson);
  }

  if (!parsed.title) {
    throw new Error("Issue #" + issueNumber + " has no title");
  }

  const labels = (parsed.labels ?? []).map((l) => l.name);
  const comments = parsed.comments ?? [];
  console.log("[triage] Issue title: " + parsed.title);
  console.log("[triage] Labels: [" + labels.join(", ") + "]");
  console.log("[triage] Comments: " + comments.length + " total");

  return {
    title: parsed.title,
    body: parsed.body ?? "",
    labels,
    comments,
  };
}

/**
 * Story 3.11 AC3: Extract owner feedback comments from issue comments.
 * Filters for comments containing ## Owner Correction or ## Owner Reclassification headers.
 * Returns matching comments in newest-first order.
 */
export function extractOwnerComments(comments: { body: string }[]): string[] {
  const ownerComments: string[] = [];
  for (const comment of [...comments].reverse()) {
    if (comment.body.includes("## Owner Correction") || comment.body.includes("## Owner Reclassification")) {
      ownerComments.push(comment.body);
    }
  }
  return ownerComments;
}

/** Post a comment on the issue in the private repo.
 *  Uses --body-file to avoid shell backtick command substitution eating markdown code spans. */
function postIssueComment(issueNumber: number, comment: string): void {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[triage] Posting comment on " + repo + "#" + issueNumber);

  const tmpFile = join(tmpdir(), "gh-comment-" + issueNumber + "-" + Date.now() + ".md");
  try {
    writeFileSync(tmpFile, comment, "utf-8");
    execSync(
      "gh issue comment " + issueNumber + " --repo " + repo + " --body-file " + tmpFile,
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[triage] Comment posted successfully");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[triage] WARNING: Failed to post comment on issue #" + issueNumber + ": " + errMsg);
    // Non-fatal: the triage still succeeded even if comment fails
  } finally {
    try { unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
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
  const correctionNotes = input.correctionNotes ?? "";
  console.log("=== Story 2.4a: Real Triage — Issue #" + issueNumber + " ===");
  if (correctionNotes) {
    console.log("[triage] Story 3.11: Re-triage with owner correction notes");
  }
  console.log("");

  // --------------------------------------------------
  // Step 1: Fetch issue from private repo
  // --------------------------------------------------
  let issueData: { title: string; body: string; labels: string[]; comments: { body: string }[] };
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

  // Build report text from issue title + body
  let reportText = issueData.title + "\n\n" + issueData.body;

  // BA-010.10: Parse reporter hint from issue body (Path B) and prepend to triage prompt
  const KNOWN_BUG_TYPES = ["ui_bug", "gameplay_bug", "content_error", "crash_bug"];
  const hintMatch = issueData.body.match(/\*\*Reporter Classification:\*\*\s*(\S+)/);
  const reporterHint = hintMatch && KNOWN_BUG_TYPES.includes(hintMatch[1]) ? hintMatch[1] : null;
  if (reporterHint) {
    const hintBlock = "The bug reporter classified this as: \"" + reporterHint + "\".\nConsider this as a signal but make your own independent assessment.\n\n";
    reportText = hintBlock + reportText;
    console.log("[triage] BA-010.10: Prepended reporter hint to triage prompt: " + reporterHint);
  } else {
    console.log("[triage] BA-010.10: No reporter hint found in issue body — proceeding normally");
  }

  // --------------------------------------------------
  // Story 3.11: Prepend owner comments and correction notes to prompt
  // Order: reporter hint (above) → owner comments → correction notes → original report
  // --------------------------------------------------
  const ownerComments = extractOwnerComments(issueData.comments);
  if (ownerComments.length > 0) {
    const ownerBlock = "OWNER FEEDBACK FROM ISSUE COMMENTS:\n" + ownerComments.join("\n\n---\n\n") + "\n\n";
    reportText = ownerBlock + reportText;
    console.log("[triage] Story 3.11: Prepended " + ownerComments.length + " owner comment(s) to triage prompt");
  }

  if (correctionNotes) {
    const correctionBlock = "OWNER CORRECTION (use this to inform your classification):\n" + correctionNotes + "\n\n";
    reportText = correctionBlock + reportText;
    console.log("[triage] Story 3.11: Prepended correction notes to triage prompt");
  }

  // Extract screenshots BEFORE stripping them — triage needs to see visual bugs
  const extractedImages = extractBase64Images(reportText);
  if (extractedImages.length > 0) {
    console.log("[triage] Extracted " + extractedImages.length + " screenshot(s) from issue body");
  }

  // Strip base64 from text prompt (model will receive images as content blocks instead)
  const cleanReportText = stripBase64Images(reportText);

  // Story 3.11 AC4: Escalate to Sonnet when correction notes are present
  const triageModel = correctionNotes ? MODELS.ORCHESTRATOR : undefined;
  if (triageModel) {
    console.log("[triage] Story 3.11: Escalating model to Sonnet for re-triage with corrections");
  }

  let triageResult: TriageResult;
  try {
    triageResult = await runTriage({
      report_text: cleanReportText,
      report_id: "issue-" + issueNumber,
      images: extractedImages.length > 0 ? extractedImages : undefined,
      model: triageModel,
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
  // BA-010.10: Adjust confidence based on reporter hint vs AI classification
  // --------------------------------------------------
  const originalClassification = triageResult.classification;
  if (reporterHint) {
    if (triageResult.classification === reporterHint) {
      console.log("[triage] BA-010.10: AI classification matches reporter hint — no adjustment");
    } else if (triageResult.confidence >= 0.70) {
      console.log("[triage] BA-010.10: AI disagrees with reporter (AI=" + triageResult.classification + " vs hint=" + reporterHint + "), capping confidence at 0.70");
      triageResult.confidence = 0.70;
    } else {
      console.log("[triage] BA-010.10: AI disagrees with reporter AND low confidence (" + triageResult.confidence + ") — routing to needs_human_review");
      triageResult.classification = "needs_human_review";
    }
  }

  // --------------------------------------------------
  // Step 3: Post classification comment (AC4)
  // --------------------------------------------------
  console.log("");
  console.log("--- Posting classification comment ---");

  let classificationComment = buildClassificationComment(triageResult);
  // BA-010.10: Add note when AI disagrees with reporter hint
  if (reporterHint && originalClassification !== reporterHint && triageResult.classification !== "needs_human_review") {
    classificationComment += "\n\n> **Note:** reporter classified this as `" + reporterHint + "` but triage classified as `" + originalClassification + "`";
  } else if (reporterHint && triageResult.classification === "needs_human_review") {
    classificationComment += "\n\n> **Note:** AI and reporter disagree — AI says `" + originalClassification + "` (" + (triageResult.confidence * 100).toFixed(0) + "%), reporter says `" + reporterHint + "`";
  }
  postIssueComment(issueNumber, classificationComment);

  // --------------------------------------------------
  // Step 4: Route based on classification (AC2)
  // --------------------------------------------------
  console.log("");
  console.log("--- Routing issue #" + issueNumber + " ---");

  // Story 3.5: Extract contextual signals early so they can be passed to routing
  const signals = extractTriageSignals(issueData.body, issueData.title);

  // Story 3.5: Build triage_handoff for needs_human_review and low-confidence routes
  const triageHandoff: TriageHandoff = {
    best_guess_classification: triageResult.classification,
    reasoning: triageResult.reasoning,
    signals_found: signals.found,
    signals_missing: signals.missing,
    suggested_steps: signals.suggestedSteps,
    relevant_files: guessRelevantFiles(triageResult.classification, triageResult.extracted_context),
  };

  const routingInput: RoutingInput = {
    classification: triageResult.classification,
    severity: triageResult.severity,
    confidence: triageResult.confidence,
    extracted_context: triageResult.extracted_context,
    issue_number: issueNumber,
    existing_labels: issueData.labels,
    // BA-011 Story 2.4: pass issue data for handoff_to_dev routes
    issue_title: issueData.title,
    issue_body: issueData.body,
    reasoning: triageResult.reasoning,
    // Story 3.5: pass triage handoff for needs_human_review routing
    triage_handoff: triageHandoff,
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

  // Log routing decision (BA-011 Story 1.3: between decideRoute and executeRoute)
  logRoutingDecision(buildLogEntry(issueNumber, triageResult, routingAction));

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
  // Step 5: Send real-time email if action needed (BA-010.6)
  // Fire-and-forget: await but catch all errors
  // --------------------------------------------------
  if (shouldSendEmail(routingAction)) {
    try {
      await sendActionNeededEmail(
        {
          issueNumber,
          issueTitle: issueData.title,
          classification: triageResult.classification,
          confidence: triageResult.confidence,
          severity: triageResult.severity,
          reasoning: triageResult.reasoning,
          description: issueData.body,
          // Story 3.5: Include triage handoff signals in notification email
          triageHandoff: {
            best_guess_classification: triageHandoff.best_guess_classification,
            signals_found: triageHandoff.signals_found,
            signals_missing: triageHandoff.signals_missing,
            suggested_steps: triageHandoff.suggested_steps,
            relevant_files: triageHandoff.relevant_files,
          },
        },
        routingAction,
      );
    } catch (emailErr: unknown) {
      const emailErrMsg = emailErr instanceof Error ? emailErr.message : String(emailErr);
      console.error("[triage] WARNING: Action email failed (non-fatal): " + emailErrMsg);
    }
  }

  // --------------------------------------------------
  // Step 5b: Post triage handoff for needs-human-review issues
  // Gives the human a structured document with full context instead of
  // just a classification comment. Uses the same generateTriageHandoff()
  // that handoff_to_dev uses.
  // --------------------------------------------------
  if (triageResult.classification === "needs_human_review") {
    try {
      // Story 3.5: Reuse signals already extracted above (avoid duplicate work)
      const handoffMarkdown = generateTriageHandoff({
        issueNumber,
        issueTitle: issueData.title,
        issueBody: issueData.body,
        classification: triageResult.classification,
        confidence: triageResult.confidence,
        severity: triageResult.severity,
        reasoning: triageResult.reasoning,
        extractedContext: triageResult.extracted_context,
        signalsFound: signals.found,
        signalsMissing: signals.missing,
        suggestedSteps: signals.suggestedSteps,
      });
      postHandoffComment(issueNumber, handoffMarkdown);
      console.log("[triage] Posted triage handoff for needs-human-review issue #" + issueNumber);
    } catch (handoffErr: unknown) {
      const handoffErrMsg = handoffErr instanceof Error ? handoffErr.message : String(handoffErr);
      console.error("[triage] WARNING: Triage handoff generation failed (non-fatal): " + handoffErrMsg);
    }
  }

  // --------------------------------------------------
  // Step 6: Post routing comment (AC4)
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

/** Build the classification result comment (AC4, PV2-6.1) */
export function buildClassificationComment(triage: TriageResult): string {
  // Defensive: fallback to "unknown" if any field is unexpectedly missing
  const classification = triage.classification || "unknown";
  const severity = triage.severity || "unknown";
  const confidence = typeof triage.confidence === "number" ? triage.confidence : 0;
  const reasoning = triage.reasoning || "No reasoning provided";
  const extractedContext = triage.extracted_context ?? {};

  // Human-readable table (unchanged)
  const lines = [
    "## Triage Classification",
    "",
    "| Field | Value |",
    "|-------|-------|",
    "| Classification | `" + classification + "` |",
    "| Severity | `" + severity + "` |",
    "| Confidence | " + (confidence * 100).toFixed(0) + "% |",
    "",
    "**Reasoning:** " + reasoning,
  ];

  if (Object.keys(extractedContext).length > 0) {
    lines.push("");
    lines.push("**Extracted context:** `" + JSON.stringify(extractedContext) + "`");
  }

  // Machine-readable JSON block (PV2-6.1 AC1, AC2)
  // Inside an HTML comment so it is invisible in the GitHub UI
  const triageData: TriageData = {
    classification,
    severity,
    confidence,
    reasoning,
    extracted_context: {
      category: typeof extractedContext.category === "string" ? extractedContext.category : null,
      file_path: typeof extractedContext.file_path === "string" ? extractedContext.file_path : null,
      event_id: typeof extractedContext.event_id === "string" ? extractedContext.event_id : null,
      expected_behavior: typeof extractedContext.expected_behavior === "string" ? extractedContext.expected_behavior : null,
      actual_behavior: typeof extractedContext.actual_behavior === "string" ? extractedContext.actual_behavior : null,
    },
  };

  lines.push("");
  lines.push("<!-- TRIAGE_DATA_START");
  lines.push("```json");
  lines.push(JSON.stringify(triageData));
  lines.push("```");
  lines.push("TRIAGE_DATA_END -->");

  return lines.join("\n");
}

/** Build routing decision log entry (BA-011 Story 1.3) */
function buildLogEntry(
  issueNumber: number,
  triage: TriageResult,
  action: RoutingAction,
): RoutingDecisionLogEntry {
  // Determine which gate fired
  let gate: RoutingDecisionLogEntry["gate"] = "classification_route";
  let labels: string[] = [];

  if (action.type === "skip") {
    gate = "idempotency";
  } else if (action.type === "handoff_to_dev") {
    labels = action.labels;
  } else if (action.type === "label" || action.type === "label_and_state") {
    labels = action.labels;
    if (labels.includes(ROUTING.LABEL_LOW_CONFIDENCE)) {
      gate = "confidence";
    } else if (labels.includes(ROUTING.LABEL_UNKNOWN_CLASSIFICATION)) {
      gate = "unknown_classification";
    }
  } else if (action.type === "dispatch" && action.issue_labels) {
    labels = action.issue_labels.labels;
  }

  return {
    ts: new Date().toISOString(),
    issue: issueNumber,
    cls: triage.classification,
    conf: triage.confidence,
    action: action.type,
    labels,
    gate,
  };
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

    case "handoff_to_dev":
      return "Handed off to developer — structured handoff for `" + triage.classification + "` (" + triage.severity + ").";

    case "skip":
      return "Skipped: " + action.reason;

    default:
      return "Routing completed.";
  }
}
