/**
 * Story 4.2: Routing Logic
 *
 * Pure routing decision function + GitHub API executor.
 *
 * decideRoute() is a PURE function — zero side effects. Takes a RoutingInput
 * and returns a RoutingAction describing what to do.
 *
 * executeRoute() is the side-effect layer — calls GitHub API via native fetch().
 * Supports DRY_RUN mode: logs but does not execute.
 *
 * Idempotency: issues with `sdk-routed` label are skipped entirely.
 *
 * CRITICAL: Uses PRIVATE_REPO_PAT for all GitHub API calls.
 * github.token CANNOT trigger repository_dispatch (proven lesson — CLAUDE.md rule).
 */

import { ROUTING, CLASSIFICATION_SET, CONFIDENCE_THRESHOLD, type Classification, type WorkflowType } from "../config.js";
import { createWorkflowState } from "./state.js";
import { generateTriageHandoff, buildFallbackHandoffComment, type TriageOnlyHandoffInput } from "./handoff-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input to the routing decision function */
export interface RoutingInput {
  classification: string;
  severity: string;
  confidence: number;
  extracted_context: Record<string, unknown>;
  issue_number: number;
  /** Labels already on the issue — used for idempotency check */
  existing_labels?: string[];
  /** Issue title — needed for handoff_to_dev routes (BA-011 Story 2.4) */
  issue_title?: string;
  /** Issue body — needed for handoff_to_dev routes (BA-011 Story 2.4) */
  issue_body?: string;
  /** Triage reasoning — needed for handoff_to_dev routes */
  reasoning?: string;
}

/** Dispatch action — triggers a repository_dispatch event */
interface DispatchAction {
  type: "dispatch";
  event_type: string;
  repo: string;
  payload: Record<string, unknown>;
  /** Optional: labels to apply on the source issue (private repo) before dispatch (HIGH-4 fix) */
  issue_labels?: {
    repo: string;
    issue_number: number;
    labels: string[];
  };
}

/** Label action — adds labels to an issue */
interface LabelAction {
  type: "label";
  repo: string;
  issue_number: number;
  labels: string[];
}

/** Label + state file action — adds labels and creates workflow state */
interface LabelAndStateAction {
  type: "label_and_state";
  repo: string;
  issue_number: number;
  labels: string[];
  workflow_type: WorkflowType;
  category?: string;
}

/** Skip action — issue already routed */
interface SkipAction {
  type: "skip";
  reason: string;
  issue_number: number;
}

/** Handoff-to-dev action — generates structured handoff and posts to private repo (BA-011 ARCH-2) */
interface HandoffAction {
  type: "handoff_to_dev";
  repo: string;
  issue_number: number;
  labels: string[];
  triage_data: {
    classification: string;
    confidence: number;
    severity: string;
    reasoning: string;
    extracted_context: Record<string, unknown>;
    issue_title: string;
    issue_body: string;
  };
}

export type RoutingAction = DispatchAction | LabelAction | LabelAndStateAction | SkipAction | HandoffAction;

// ---------------------------------------------------------------------------
// Pure routing decision function
// ---------------------------------------------------------------------------

/**
 * Decide the routing action for a triage result.
 *
 * This is a PURE function: no I/O, no API calls, no randomness.
 * Returns a RoutingAction describing what to do.
 *
 * 3-gate system (BA-011):
 *   Gate 1: Low confidence → safe label (S4, AC3)
 *   Gate 2: Unknown classification → safe label (S1)
 *   Route: Known classification → routeByClassification()
 */
export function decideRoute(input: RoutingInput): RoutingAction {
  // Idempotency: skip if already routed (AC-10)
  if (input.existing_labels?.includes(ROUTING.LABEL_ROUTED)) {
    return {
      type: "skip",
      reason: "already routed, skipping issue #" + input.issue_number,
      issue_number: input.issue_number,
    };
  }

  // Gate 1 (BA-011 S4): Low confidence → safe label, cheapest action
  // Strictly less-than: 0.70 passes, 0.69 is blocked (FR6)
  if (input.confidence < CONFIDENCE_THRESHOLD) {
    console.log("[routing] Gate 1: Low confidence " + input.confidence.toFixed(2) + " (threshold " + CONFIDENCE_THRESHOLD + ") for issue #" + input.issue_number + " — safe label fallback");
    return {
      type: "label",
      repo: ROUTING.PRIVATE_REPO,
      issue_number: input.issue_number,
      labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_LOW_CONFIDENCE, ROUTING.LABEL_ROUTED],
    };
  }

  // Gate 2 (BA-011 S1): Unknown classification → safe label, never crash
  if (!CLASSIFICATION_SET.has(input.classification)) {
    console.log("[routing] Gate 2: Unknown classification \"" + input.classification + "\" for issue #" + input.issue_number + " — safe label fallback");
    return {
      type: "label",
      repo: ROUTING.PRIVATE_REPO,
      issue_number: input.issue_number,
      labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
    };
  }

  return routeByClassification(input.classification as Classification, input);
}

/**
 * Route a known classification to its action (ARCH-5).
 *
 * Uses TypeScript exhaustive switch with `never` assertion —
 * adding a classification to CLASSIFICATIONS without a case here
 * causes a compile error.
 */
function routeByClassification(classification: Classification, input: RoutingInput): RoutingAction {
  switch (classification) {
    case "content_error": {
      // AC-1: dispatch sdk-content-verify to public repo
      // HIGH-4 fix: also apply sdk-routed + content-error labels on the private repo issue
      const category = (typeof input.extracted_context.category === "string" && input.extracted_context.category !== "")
        ? input.extracted_context.category
        : "unknown";
      return {
        type: "dispatch",
        event_type: ROUTING.DISPATCH_CONTENT_VERIFY,
        repo: ROUTING.PUBLIC_REPO,
        payload: {
          workflow_type: "content_verification",
          category,
          issue_number: input.issue_number,
        },
        issue_labels: {
          repo: ROUTING.PRIVATE_REPO,
          issue_number: input.issue_number,
          labels: [ROUTING.LABEL_ROUTED, ROUTING.LABEL_CONTENT_ERROR],
        },
      };
    }

    case "content_category_error": {
      // Event is in the wrong category — needs manual review (no automated handler for category moves)
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_CONTENT_ERROR, "category-mismatch", ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
      };
    }

    case "content_duplicate": {
      // BA-011: Duplicate event — needs human review to decide which copy to keep
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_CONTENT_DUPLICATE, ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
      };
    }

    case "translation_error": {
      // AC-2: label + state file for translation queue
      const category = (typeof input.extracted_context.category === "string" && input.extracted_context.category !== "")
        ? input.extracted_context.category
        : undefined;
      return {
        type: "label_and_state",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_TRANSLATION_ERROR, ROUTING.LABEL_ROUTED],
        workflow_type: "translation_verification",
        category,
      };
    }

    case "ui_bug": {
      // SDK-BF.3 AC1: ALL ui_bug severities → label with classification + severity, wait for /approve
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_UI_BUG, "severity/" + input.severity, ROUTING.LABEL_ROUTED],
      };
    }

    case "gameplay_bug": {
      // SDK-BF.3 AC2: ALL gameplay_bug severities → label with classification + severity, wait for /approve
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_GAMEPLAY_BUG, "severity/" + input.severity, ROUTING.LABEL_ROUTED],
      };
    }

    case "performance_issue": {
      // BA-011: Needs code analysis/profiling — handoff to developer
      if (!input.issue_title || !input.issue_body) {
        // Defensive: if issue data not provided, fall back to label-only (TEA recommendation)
        console.log("[routing] handoff_to_dev for performance_issue missing issue_title/issue_body — falling back to label-only");
        return {
          type: "label",
          repo: ROUTING.PRIVATE_REPO,
          issue_number: input.issue_number,
          labels: [ROUTING.LABEL_PERFORMANCE_ISSUE, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
        };
      }
      return {
        type: "handoff_to_dev",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_PERFORMANCE_ISSUE, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
        triage_data: {
          classification: "performance_issue",
          confidence: input.confidence,
          severity: input.severity,
          reasoning: input.reasoning ?? "",
          extracted_context: input.extracted_context,
          issue_title: input.issue_title,
          issue_body: input.issue_body,
        },
      };
    }

    case "crash_bug": {
      // BA-011: Needs investigation — handoff to developer
      if (!input.issue_title || !input.issue_body) {
        console.log("[routing] handoff_to_dev for crash_bug missing issue_title/issue_body — falling back to label-only");
        return {
          type: "label",
          repo: ROUTING.PRIVATE_REPO,
          issue_number: input.issue_number,
          labels: [ROUTING.LABEL_CRASH_BUG, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
        };
      }
      return {
        type: "handoff_to_dev",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_CRASH_BUG, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
        triage_data: {
          classification: "crash_bug",
          confidence: input.confidence,
          severity: input.severity,
          reasoning: input.reasoning ?? "",
          extracted_context: input.extracted_context,
          issue_title: input.issue_title,
          issue_body: input.issue_body,
        },
      };
    }

    case "feature_request": {
      // AC-6: backlog
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_FEATURE_REQUEST, ROUTING.LABEL_ROUTED],
      };
    }

    case "needs_human_review": {
      // AC-7: manual triage queue
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
      };
    }

    default: {
      // Exhaustive check — TypeScript will error if a Classification case is missing
      const _exhaustive: never = classification;
      // This line should be unreachable. If somehow reached at runtime, safe fallback.
      console.error("[routing] Exhaustive check failed for: " + String(_exhaustive));
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function getGitHubToken(): string {
  const token = process.env.PRIVATE_REPO_PAT ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      "No GitHub token found. Set PRIVATE_REPO_PAT or GH_TOKEN environment variable. " +
      "CRITICAL: github.token CANNOT trigger repository_dispatch — use a PAT."
    );
  }
  return token;
}

/** POST repository_dispatch event to a GitHub repo */
async function githubDispatch(
  repo: string,
  eventType: string,
  clientPayload: Record<string, unknown>,
): Promise<void> {
  const token = getGitHubToken();
  const url = "https://api.github.com/repos/" + repo + "/dispatches";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
  });

  // repository_dispatch returns 204 on success
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "GitHub dispatch failed: " + response.status + " " + response.statusText + " — " + body
    );
  }

  console.log("[routing] Dispatched " + eventType + " to " + repo);
}

/** POST labels to a GitHub issue */
async function githubLabel(
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  const token = getGitHubToken();
  const url = "https://api.github.com/repos/" + repo + "/issues/" + issueNumber + "/labels";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "GitHub label failed: " + response.status + " " + response.statusText + " — " + body
    );
  }

  console.log("[routing] Applied labels [" + labels.join(", ") + "] to " + repo + "#" + issueNumber);
}

/** POST a comment on a GitHub issue (BA-011 AC5: same auth as githubLabel/githubDispatch).
 *  Uses AbortController with 30s timeout per NFR10. */
async function githubPostComment(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const token = getGitHubToken();
  const url = "https://api.github.com/repos/" + repo + "/issues/" + issueNumber + "/comments";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        "GitHub comment failed: " + response.status + " " + response.statusText + " — " + responseBody,
      );
    }

    console.log("[routing] Posted comment on " + repo + "#" + issueNumber);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Route executor (side-effect layer)
// ---------------------------------------------------------------------------

/**
 * Execute a routing action against the GitHub API.
 *
 * When dryRun is true, logs the action but does NOT make API calls (AC-9).
 * Throws on non-2xx API responses (AC-11).
 */
export async function executeRoute(action: RoutingAction, dryRun: boolean): Promise<void> {
  if (action.type === "skip") {
    console.log("[routing] SKIP: " + action.reason);
    return;
  }

  if (dryRun) {
    console.log("[routing] DRY RUN — would execute:");
    console.log("[routing]   type: " + action.type);
    if (action.type === "dispatch") {
      console.log("[routing]   event_type: " + action.event_type);
      console.log("[routing]   repo: " + action.repo);
      console.log("[routing]   payload: " + JSON.stringify(action.payload));
      if (action.issue_labels) {
        console.log("[routing]   issue_labels: [" + action.issue_labels.labels.join(", ") + "] on " + action.issue_labels.repo + "#" + action.issue_labels.issue_number);
      }
    } else if (action.type === "label") {
      console.log("[routing]   repo: " + action.repo);
      console.log("[routing]   issue_number: " + action.issue_number);
      console.log("[routing]   labels: [" + action.labels.join(", ") + "]");
    } else if (action.type === "label_and_state") {
      console.log("[routing]   repo: " + action.repo);
      console.log("[routing]   issue_number: " + action.issue_number);
      console.log("[routing]   labels: [" + action.labels.join(", ") + "]");
      console.log("[routing]   workflow_type: " + action.workflow_type);
      if (action.category) {
        console.log("[routing]   category: " + action.category);
      }
    } else if (action.type === "handoff_to_dev") {
      console.log("[routing]   repo: " + action.repo);
      console.log("[routing]   issue_number: " + action.issue_number);
      console.log("[routing]   labels: [" + action.labels.join(", ") + "]");
      console.log("[routing]   triage_data.classification: " + action.triage_data.classification);
    }
    return;
  }

  switch (action.type) {
    case "dispatch":
      // HIGH-4 fix: apply labels on the source issue before dispatching
      if (action.issue_labels) {
        await githubLabel(
          action.issue_labels.repo,
          action.issue_labels.issue_number,
          action.issue_labels.labels,
        );
      }
      await githubDispatch(action.repo, action.event_type, action.payload);
      break;

    case "label":
      await githubLabel(action.repo, action.issue_number, action.labels);
      break;

    case "label_and_state":
      await githubLabel(action.repo, action.issue_number, action.labels);
      await createWorkflowState(action.workflow_type, "dispatch", action.category, action.issue_number);
      console.log("[routing] Created workflow state for " + action.workflow_type + " (issue #" + action.issue_number + ")");
      break;

    case "handoff_to_dev": {
      // BA-011 Story 3.1: Generate handoff, post comment, apply labels
      await githubLabel(action.repo, action.issue_number, action.labels);

      // Generate structured handoff document
      let handoffMarkdown: string;
      try {
        const handoffInput: TriageOnlyHandoffInput = {
          issueNumber: action.issue_number,
          issueTitle: action.triage_data.issue_title,
          issueBody: action.triage_data.issue_body,
          classification: action.triage_data.classification,
          confidence: action.triage_data.confidence,
          severity: action.triage_data.severity,
          reasoning: action.triage_data.reasoning,
          extractedContext: action.triage_data.extracted_context,
        };
        handoffMarkdown = generateTriageHandoff(handoffInput);
      } catch (genErr: unknown) {
        // AC3: Generation failed → apply handoff-generation-failed label + fallback comment
        const genErrMsg = genErr instanceof Error ? genErr.message : String(genErr);
        console.error("[routing] Handoff generation failed for issue #" + action.issue_number + ": " + genErrMsg);
        try {
          await githubLabel(action.repo, action.issue_number, ["handoff-generation-failed"]);
        } catch { /* best-effort label */ }
        const fallback = buildFallbackHandoffComment(
          action.triage_data.classification,
          action.triage_data.confidence,
          action.triage_data.severity,
          action.triage_data.reasoning,
          genErrMsg,
        );
        try {
          await githubPostComment(action.repo, action.issue_number, fallback);
        } catch { /* best-effort fallback comment */ }
        break;
      }

      // Post handoff comment with single retry (AC4)
      try {
        await githubPostComment(action.repo, action.issue_number, handoffMarkdown);
      } catch (postErr: unknown) {
        const postErrMsg = postErr instanceof Error ? postErr.message : String(postErr);
        console.error("[routing] Handoff comment post failed (attempt 1) for issue #" + action.issue_number + ": " + postErrMsg);
        // Retry once
        try {
          await githubPostComment(action.repo, action.issue_number, handoffMarkdown);
          console.log("[routing] Handoff comment posted on retry for issue #" + action.issue_number);
        } catch (retryErr: unknown) {
          // Both attempts failed — apply delivery-failed label + fallback
          const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error("[routing] Handoff comment retry also failed for issue #" + action.issue_number + ": " + retryErrMsg);
          try {
            await githubLabel(action.repo, action.issue_number, ["delivery-failed"]);
          } catch { /* best-effort label */ }
          const fallback = buildFallbackHandoffComment(
            action.triage_data.classification,
            action.triage_data.confidence,
            action.triage_data.severity,
            action.triage_data.reasoning,
            "Comment delivery failed after 2 attempts: " + retryErrMsg,
          );
          try {
            await githubPostComment(action.repo, action.issue_number, fallback);
          } catch { /* best-effort — if this also fails, the labels are the signal */ }
        }
      }

      console.log("[routing] Handoff-to-dev complete for issue #" + action.issue_number);
      break;
    }
  }
}
