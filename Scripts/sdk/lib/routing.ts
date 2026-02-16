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

import { ROUTING, type WorkflowType } from "../config.js";
import { createWorkflowState } from "./state.js";

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

export type RoutingAction = DispatchAction | LabelAction | LabelAndStateAction | SkipAction;

// ---------------------------------------------------------------------------
// Pure routing decision function
// ---------------------------------------------------------------------------

/**
 * Decide the routing action for a triage result.
 *
 * This is a PURE function: no I/O, no API calls, no randomness.
 * Returns a RoutingAction describing what to do.
 *
 * Throws on unknown classification (defensive).
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

  switch (input.classification) {
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
      // AC-3 / AC-4: simple (P3/P4) vs complex (P1/P2)
      if (input.severity === "P3" || input.severity === "P4") {
        // AC-3: simple — dispatch to auto-fix pipeline
        return {
          type: "dispatch",
          event_type: ROUTING.DISPATCH_APPROVE,
          repo: ROUTING.PUBLIC_REPO,
          payload: {
            issue_number: input.issue_number,
          },
        };
      }
      // AC-4: complex — manual queue
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_NEEDS_CLAUDE_CODE, ROUTING.LABEL_ROUTED],
      };
    }

    case "gameplay_bug": {
      // AC-5: always manual queue
      return {
        type: "label",
        repo: ROUTING.PRIVATE_REPO,
        issue_number: input.issue_number,
        labels: [ROUTING.LABEL_NEEDS_CLAUDE_CODE, ROUTING.LABEL_ROUTED],
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

    default:
      throw new Error(
        "Unknown classification: \"" + input.classification + "\". " +
        "Cannot route issue #" + input.issue_number + ". " +
        "Valid classifications: content_error, translation_error, ui_bug, gameplay_bug, feature_request, needs_human_review"
      );
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
  }
}
