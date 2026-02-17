/**
 * Story SDK-BF.1: Bug Fix Subagent Workflow
 *
 * Spawns an Opus 4.6 subagent with full tool suite to fix bugs in the
 * SortingHistory iOS game codebase. The subagent:
 *   1. Explores the codebase using Read/Glob/Grep
 *   2. Makes targeted fixes using Edit (not Write for full rewrites)
 *   3. Verifies compilation with xcodebuild via Bash
 *   4. Returns structured JSON summary
 *
 * Hooks (buildBugFixHooksConfig):
 *   - ALLOWS writes to .swift files and Data JSON files
 *   - BLOCKS writes to .github/, Scripts/, .yml, .yaml, .ts, .js,
 *     Package.swift, .pbxproj, .xcworkspace
 *
 * State file: bug_fix workflow type, "bf-" prefix
 *
 * Exit codes:
 * - 0: Success (fix applied, JSON summary returned)
 * - 1: Failure (subagent error, compilation failure, invalid response)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MODELS, BUG_FIX_TOOLS, PATHS, ROUTING } from "../config.js";
import { spawnSubagent, type SubagentResult } from "../lib/subagent.js";
import { buildBugFixHooksConfig } from "../lib/hooks.js";
import { extractJson } from "../lib/json-extract.js";
import { extractBase64Images, stripBase64Images } from "../lib/image-extract.js";
import {
  createWorkflowState,
  updateWorkflowState,
  type WorkflowState,
} from "../lib/state.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Structured JSON output from the bug fix subagent */
export interface BugFixSummary {
  files_modified: string[];
  fix_summary: string;
  compilation_result: string;
  confidence: "high" | "medium" | "low";
}

/** Input parameters for the bug fix workflow */
export interface BugFixInput {
  /** GitHub issue number from the private repo */
  issueNumber: number;
  /** Path to the game repo checkout */
  gameRepoPath: string;
  /** If true, skip actual subagent spawn and log what would happen */
  dryRun: boolean;
}

/** Result of the bug fix workflow */
export interface BugFixResult {
  /** Whether the fix was applied successfully */
  success: boolean;
  /** Workflow ID for state tracking */
  workflowId: string;
  /** Issue number that was fixed */
  issueNumber: number;
  /** Parsed fix summary from the subagent (null if parsing failed) */
  summary: BugFixSummary | null;
  /** Subagent metrics */
  metrics: {
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    costUsd: number;
    toolsUsed: string[];
  } | null;
  /** Error message if something went wrong */
  error: string | null;
}

// ------------------------------------------------------------------
// GitHub Helpers
// ------------------------------------------------------------------

/** Fetch issue body and comments from the private repo */
function fetchIssueContext(issueNumber: number): { title: string; body: string; triageComment: string | null } {
  const repo = ROUTING.PRIVATE_REPO;
  console.log("[bug-fix] Fetching issue #" + issueNumber + " from " + repo);

  // Fetch issue title and body
  let issueJson: string;
  try {
    issueJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json title,body",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error("Failed to fetch issue #" + issueNumber + ": " + errMsg);
  }

  let parsed: { title: string; body: string };
  try {
    parsed = JSON.parse(issueJson) as { title: string; body: string };
  } catch {
    throw new Error("Failed to parse issue JSON: " + issueJson);
  }

  console.log("[bug-fix] Issue title: " + parsed.title);

  // Fetch comments to find triage/analysis comment
  let triageComment: string | null = null;
  try {
    const commentsJson = execSync(
      "gh issue view " + issueNumber + " --repo " + repo + " --json comments",
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();

    const commentsParsed = JSON.parse(commentsJson) as {
      comments: Array<{ body: string }>;
    };

    // Find the triage classification comment (contains "## Triage Classification")
    for (const comment of commentsParsed.comments) {
      if (comment.body.includes("Triage Classification") || comment.body.includes("Bug Analysis")) {
        triageComment = comment.body;
        break;
      }
    }

    if (triageComment) {
      console.log("[bug-fix] Found triage/analysis comment");
    } else {
      console.log("[bug-fix] No triage/analysis comment found on issue");
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[bug-fix] WARNING: Could not fetch comments: " + errMsg);
  }

  return {
    title: parsed.title,
    body: parsed.body ?? "",
    triageComment,
  };
}

// ------------------------------------------------------------------
// Main Workflow
// ------------------------------------------------------------------

/**
 * Run the bug fix workflow.
 *
 * 1. Fetch issue body + triage analysis from GitHub
 * 2. Load system prompt from prompts/bug-fixer.md
 * 3. Spawn Opus 4.6 subagent with BUG_FIX_TOOLS + buildBugFixHooksConfig
 * 4. Parse structured JSON summary from response
 * 5. Save workflow state
 * 6. Return result
 */
export async function runBugFix(input: BugFixInput): Promise<BugFixResult> {
  const { issueNumber, gameRepoPath, dryRun } = input;

  console.log("=== SDK-BF.1: Bug Fix Subagent ===");
  console.log("Issue: #" + issueNumber);
  console.log("Game repo: " + gameRepoPath);
  console.log("Model: " + MODELS.COMPLEX_BUG);
  console.log("Tools: [" + BUG_FIX_TOOLS.join(", ") + "]");
  console.log("Dry run: " + dryRun);
  console.log("");

  // --------------------------------------------------
  // Step 1: Create workflow state
  // --------------------------------------------------
  const state = await createWorkflowState(
    "bug_fix",
    "dispatch",
    undefined,
    issueNumber,
  );
  console.log("[bug-fix] Workflow created: " + state.workflow_id);
  console.log("");

  // --------------------------------------------------
  // Step 2: Fetch issue context from GitHub
  // --------------------------------------------------
  let issueContext: { title: string; body: string; triageComment: string | null };
  try {
    issueContext = fetchIssueContext(issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bug-fix] FATAL: " + errMsg);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Could not fetch issue: " + errMsg,
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: "Could not fetch issue: " + errMsg,
    };
  }

  // --------------------------------------------------
  // Step 3: Load system prompt
  // --------------------------------------------------
  const repoRoot = process.env.GITHUB_WORKSPACE
    ?? process.env.SDK_REPO_ROOT
    ?? process.cwd();

  const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "bug-fixer.md");
  let systemPrompt: string;
  try {
    systemPrompt = fs.readFileSync(promptPath, "utf-8");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[bug-fix] Could not read system prompt at " + promptPath);
    console.error("Error: " + errMsg);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Could not read system prompt: " + errMsg,
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: "Could not read system prompt: " + errMsg,
    };
  }

  // --------------------------------------------------
  // Step 4: Build user prompt with issue context
  // --------------------------------------------------
  // Extract base64 images from the issue body for multimodal content blocks
  const images = extractBase64Images(issueContext.body);
  if (images.length > 0) {
    console.log("[bug-fix] Extracted " + images.length + " screenshot(s) from issue body");
  }

  // Strip base64 images from text to avoid sending raw data as prompt noise
  const cleanBody = stripBase64Images(issueContext.body);
  const cleanTriageComment = issueContext.triageComment
    ? stripBase64Images(issueContext.triageComment)
    : null;

  const contextParts = [
    "Fix the following bug in the SortingHistory iOS game.",
    "",
    "## Bug Report (Issue #" + issueNumber + ")",
    "**Title:** " + issueContext.title,
    "",
    cleanBody,
  ];

  if (cleanTriageComment) {
    contextParts.push("");
    contextParts.push("## Triage Analysis");
    contextParts.push(cleanTriageComment);
  }

  contextParts.push("");
  contextParts.push("## Instructions");
  contextParts.push("1. Explore the codebase to understand the relevant code");
  contextParts.push("2. Identify the root cause of the bug");
  contextParts.push("3. Apply a targeted fix using Edit (not full file rewrites)");
  contextParts.push("4. Verify compilation passes with xcodebuild");
  contextParts.push("5. Output your JSON summary");

  const userPrompt = contextParts.join("\n");

  // --------------------------------------------------
  // Step 5: Dry run check
  // --------------------------------------------------
  if (dryRun) {
    console.log("[bug-fix] DRY RUN: Would spawn Opus 4.6 subagent with:");
    console.log("  Model: " + MODELS.COMPLEX_BUG);
    console.log("  Tools: [" + BUG_FIX_TOOLS.join(", ") + "]");
    console.log("  Prompt length: " + userPrompt.length + " chars");
    console.log("  System prompt length: " + systemPrompt.length + " chars");
    console.log("  cwd: " + gameRepoPath);
    console.log("");

    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      error: null,
    });

    return {
      success: true,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics: null,
      error: null,
    };
  }

  // --------------------------------------------------
  // Step 6: Spawn Opus 4.6 subagent
  // --------------------------------------------------
  console.log("[bug-fix] Spawning Opus 4.6 subagent...");
  await updateWorkflowState(state.workflow_id, {
    status: "fixing",
  });

  const hooks = buildBugFixHooksConfig(gameRepoPath);

  const result: SubagentResult = await spawnSubagent({
    model: MODELS.COMPLEX_BUG,
    tools: [...BUG_FIX_TOOLS],
    prompt: userPrompt,
    systemPrompt,
    hooks,
    cwd: gameRepoPath,
    maxTurns: 100,
    images,
  });

  // --------------------------------------------------
  // Step 7: Log metrics
  // --------------------------------------------------
  console.log("");
  console.log("[bug-fix] Subagent complete");
  console.log("  Model: " + (result.model ?? MODELS.COMPLEX_BUG));
  console.log("  Session ID: " + result.sessionId);
  console.log("  Input tokens: " + result.inputTokens);
  console.log("  Output tokens: " + result.outputTokens);
  console.log("  Duration: " + result.durationMs + "ms");
  console.log("  Cost: $" + result.costUsd.toFixed(4));
  console.log("  Tools used: [" + result.toolsUsed.join(", ") + "]");
  console.log("  Used write tools: " + result.usedWriteTools);
  console.log("");

  const metrics = {
    model: result.model ?? MODELS.COMPLEX_BUG,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    toolsUsed: result.toolsUsed,
  };

  if (!result.success) {
    console.error("[bug-fix] Subagent failed: " + result.error);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Subagent failed: " + (result.error ?? "unknown error"),
    });

    return {
      success: false,
      workflowId: state.workflow_id,
      issueNumber,
      summary: null,
      metrics,
      error: "Subagent failed: " + (result.error ?? "unknown error"),
    };
  }

  // --------------------------------------------------
  // Step 8: Parse JSON summary from response
  // --------------------------------------------------
  let summary: BugFixSummary | null = null;

  if (result.responseText) {
    try {
      const jsonText = extractJson(result.responseText, "files_modified");
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      if (
        Array.isArray(parsed.files_modified) &&
        typeof parsed.fix_summary === "string" &&
        typeof parsed.compilation_result === "string" &&
        typeof parsed.confidence === "string"
      ) {
        summary = {
          files_modified: parsed.files_modified as string[],
          fix_summary: parsed.fix_summary,
          compilation_result: parsed.compilation_result,
          confidence: parsed.confidence as "high" | "medium" | "low",
        };
        console.log("[bug-fix] Parsed fix summary:");
        console.log("  Files modified: " + summary.files_modified.length);
        console.log("  Summary: " + summary.fix_summary);
        console.log("  Compilation: " + summary.compilation_result);
        console.log("  Confidence: " + summary.confidence);
      } else {
        console.log("[bug-fix] WARNING: Response JSON missing expected fields");
        console.log("  Keys found: " + Object.keys(parsed).join(", "));
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log("[bug-fix] WARNING: Could not parse JSON from response: " + errMsg);
    }
  } else {
    console.log("[bug-fix] WARNING: No response text from subagent");
  }

  // --------------------------------------------------
  // Step 9: Update workflow state
  // --------------------------------------------------
  const finalStatus = summary?.compilation_result === "success" ? "complete" : "escalated";
  const finalError = finalStatus === "escalated"
    ? "Compilation " + (summary?.compilation_result ?? "unknown") + " -- manual review required"
    : null;

  await updateWorkflowState(state.workflow_id, {
    status: finalStatus,
    fix_attempts: 1,
    fix_results: summary ? [summary] : [],
    error: finalError,
  });

  console.log("");
  console.log("[bug-fix] Status: " + finalStatus);
  console.log("[bug-fix] Workflow " + state.workflow_id + " finished");
  console.log("");
  console.log("=== Bug Fix " + (finalStatus === "complete" ? "COMPLETE" : "ESCALATED") + " -- Issue #" + issueNumber + " ===");

  return {
    success: finalStatus === "complete",
    workflowId: state.workflow_id,
    issueNumber,
    summary,
    metrics,
    error: finalError,
  };
}
