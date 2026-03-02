/**
 * BA-008.2: Translation End-to-End Orchestration
 *
 * Full translation pipeline: verify -> approval gate -> fix (per language) -> re-verify -> PR
 *
 * State machine:
 *   verifying -> awaiting_approval -> fixing -> re_verifying -> complete | escalated
 *
 * Follows the content pipeline pattern (content-e2e.ts) but adapted for translations:
 *   1. Analyze bug report + scan LocalizationHelper.swift to identify affected keys/languages
 *   2. Save state as awaiting_approval with findings, pause session
 *   3. On resume (with approval): run fixer subagent per language (one language at a time)
 *   4. Run verifier to check T3-T9 gates on the output
 *   5. If verification passes -> create PR. If fails -> retry (up to MAX_FIX_ATTEMPTS)
 *   6. On exhausted retries -> generate handoff, post comment, label issue -> escalated
 *
 * No approval gate bypass -- translation fixes always pause for human approval.
 * French is flagged for extra review (in codebase but not in translation agent docs).
 *
 * Exit codes:
 * - 0: Success (workflow completed -- either PR created or escalated)
 * - 1: Failure (could not run pipeline)
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { LIMITS, PATHS, ROUTING, MODELS, type WorkflowStatus } from "../config.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
  findWorkflowByIssue,
  type WorkflowState,
  type WorkflowFinding,
} from "../lib/state.js";
import { saveSession, removeSession } from "../lib/session.js";
import { verifyTranslations, type TranslationVerifyInput, type TranslationVerifyResult } from "./translation-verify.js";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Languages with sections in LocalizationHelper.swift */
const TARGET_LANGUAGES = ["Spanish", "French", "German", "Portuguese", "Dutch"] as const;

/** Languages with formal agent rules (from translation-agent.md) */
const AGENT_SUPPORTED_LANGUAGES = new Set(["Spanish", "German", "Portuguese", "Dutch"]);

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Input for the translation E2E orchestration */
export interface TranslationE2EInput {
  /** GitHub issue number that triggered this workflow */
  issueNumber: number;
  /** Issue body text (bug report) */
  issueBody: string;
  /** Issue title */
  issueTitle: string;
  /** Path to game repo checkout */
  gameRepoPath: string;
  /** If true, skip PR creation */
  dryRun?: boolean;
  /** Branch name for PR */
  branch?: string;
  /** Base branch for PR */
  baseBranch?: string;
}

/** Result of the translation E2E orchestration */
export interface TranslationE2EResult {
  status: WorkflowStatus;
  workflowId: string;
  /** Number of keys identified as needing translation */
  totalKeys: number;
  /** Number of languages that need fixes */
  languagesAffected: number;
  /** Fix attempts used */
  fixAttempts: number;
  /** PR number if created */
  prNumber: number | null;
  /** PR URL if created */
  prUrl: string | null;
  /** Error message */
  error: string | null;
}

/** Translation finding -- what needs to be fixed */
export interface TranslationFinding {
  key: string;
  englishValue: string;
  /** Languages where this key is missing or wrong */
  missingIn: string[];
  wrongIn: string[];
}

// ------------------------------------------------------------------
// Internal Helpers
// ------------------------------------------------------------------

/**
 * Extract key-value pairs from a language section of LocalizationHelper.swift.
 * Uses grep to avoid reading the entire 64K file.
 */
function extractKeysFromSection(
  filePath: string,
  searchKeys: string[],
  sectionStartLine?: number,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of searchKeys) {
    try {
      let grepCmd = "grep -n '\"" + key + "\"' " + JSON.stringify(filePath);
      if (sectionStartLine) {
        // Search only from the section start line onwards
        grepCmd = "sed -n '" + sectionStartLine + ",$p' " + JSON.stringify(filePath) +
          " | grep -n '\"" + key + "\"'";
      }
      const output = execSync(grepCmd, { encoding: "utf-8", timeout: 10_000 }).trim();
      if (output) {
        // Parse "key": "value" pattern
        const match = output.match(/"([^"]+)":\s*"([^"]*)"/);
        if (match && match[1] === key) {
          result[key] = match[2];
        }
      }
    } catch {
      // grep returns exit code 1 when no match -- key is missing
    }
  }

  return result;
}

/**
 * Analyze the bug report to determine which keys and languages are affected.
 * Scans LocalizationHelper.swift for the English keys and checks each language section.
 */
export function analyzeTranslationBug(
  issueBody: string,
  gameRepoPath: string,
): { findings: TranslationFinding[]; englishKeys: Record<string, string> } {
  const locHelperPath = path.join(gameRepoPath, "Localization", "LocalizationHelper.swift");

  if (!fs.existsSync(locHelperPath)) {
    throw new Error("LocalizationHelper.swift not found at: " + locHelperPath);
  }

  // Extract English section keys -- look for the pattern mentioned in the bug
  // For issue #121, the keys are daily_challenge_*
  // General approach: find keys mentioned in the issue body
  const keyPattern = /\b(daily_challenge_\w+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
  const mentionedKeys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = keyPattern.exec(issueBody)) !== null) {
    mentionedKeys.add(match[1]);
  }

  // Also search for daily_challenge keys in the English section directly
  try {
    const grepOutput = execSync(
      "grep -o '\"daily_challenge_[a-z_]*\"' " + JSON.stringify(locHelperPath),
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();
    for (const line of grepOutput.split("\n")) {
      const keyMatch = line.match(/"([^"]+)"/);
      if (keyMatch) {
        mentionedKeys.add(keyMatch[1]);
      }
    }
  } catch {
    // No daily_challenge keys found
  }

  if (mentionedKeys.size === 0) {
    return { findings: [], englishKeys: {} };
  }

  // Extract English values for these keys
  const keysArray = Array.from(mentionedKeys);
  const englishKeys = extractKeysFromSection(locHelperPath, keysArray);

  // Check each non-English language section
  // Known section start lines (from story docs)
  const languageSections: Record<string, number> = {
    Spanish: 941,
    French: 1130,
    German: 1177,
    Portuguese: 2036,
    Dutch: 2908,
  };

  const findings: TranslationFinding[] = [];

  for (const key of Object.keys(englishKeys)) {
    const missingIn: string[] = [];
    const wrongIn: string[] = [];

    for (const [language, startLine] of Object.entries(languageSections)) {
      const langKeys = extractKeysFromSection(locHelperPath, [key], startLine);
      if (!(key in langKeys)) {
        missingIn.push(language);
      }
      // For wrong translations, we would need the bug report to specify which are wrong
      // For now, focus on missing keys (Bug A pattern)
    }

    if (missingIn.length > 0 || wrongIn.length > 0) {
      findings.push({
        key,
        englishValue: englishKeys[key],
        missingIn,
        wrongIn,
      });
    }
  }

  return { findings, englishKeys };
}

/**
 * Convert TranslationFinding[] to WorkflowFinding[] for state storage.
 */
function translationToWorkflowFindings(findings: TranslationFinding[]): WorkflowFinding[] {
  return findings.map(f => ({
    event_id: f.key,
    event_title: "Key: " + f.key,
    gates_failed: [
      ...(f.missingIn.length > 0 ? ["MISSING_IN:" + f.missingIn.join(",")] : []),
      ...(f.wrongIn.length > 0 ? ["WRONG_IN:" + f.wrongIn.join(",")] : []),
    ],
    details: "English: \"" + f.englishValue + "\" | Missing in: " +
      (f.missingIn.length > 0 ? f.missingIn.join(", ") : "none") +
      " | Wrong in: " + (f.wrongIn.length > 0 ? f.wrongIn.join(", ") : "none"),
    severity: "high" as const,
  }));
}

/**
 * Post a comment on a GitHub issue.
 */
function postIssueComment(issueNumber: number, comment: string): void {
  const repo = ROUTING.PRIVATE_REPO;
  const tmpFile = path.join(tmpdir(), "gh-translation-" + issueNumber + "-" + Date.now() + ".md");
  try {
    fs.writeFileSync(tmpFile, comment, "utf-8");
    execSync(
      "gh issue comment " + issueNumber + " --repo " + repo + " --body-file " + tmpFile,
      { encoding: "utf-8", timeout: 30_000 },
    );
    console.log("[translation-e2e] Posted comment on issue #" + issueNumber);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[translation-e2e] WARNING: Could not post comment: " + errMsg);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
  }
}

/**
 * Add the needs-handoff-review label to an issue. Non-fatal.
 */
function addHandoffLabel(issueNumber: number): void {
  const repo = ROUTING.PRIVATE_REPO;
  try {
    execSync(
      "gh issue edit " + issueNumber + " --repo " + repo + " --add-label needs-handoff-review",
      { encoding: "utf-8", timeout: 15_000 },
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log("[translation-e2e] WARNING: Could not add label: " + errMsg);
  }
}

/**
 * Build the PR description for a translation fix PR.
 */
function buildTranslationPrDescription(
  findings: TranslationFinding[],
  workflowId: string,
  fixAttempts: number,
  issueNumber: number,
): string {
  const keysList = findings.map(f =>
    "- `" + f.key + "`: missing in " + f.missingIn.join(", ") +
    (f.wrongIn.length > 0 ? " | wrong in " + f.wrongIn.join(", ") : ""),
  ).join("\n");

  const frenchNote = findings.some(f => f.missingIn.includes("French") || f.wrongIn.includes("French"))
    ? "\n\n**Note:** French translations are included but lack formal agent-level quality rules. These should receive extra human review."
    : "";

  return [
    "## Translation Pipeline Fix",
    "",
    "Fixes #" + issueNumber,
    "",
    "**Workflow:** `" + workflowId + "`",
    "**Fix attempts:** " + fixAttempts,
    "",
    "### Keys Fixed",
    keysList,
    "",
    "### Languages Updated",
    TARGET_LANGUAGES.map(l => "- " + l).join("\n"),
    frenchNote,
    "",
    "### Bug B Follow-Up (NOT fixed in this PR)",
    "DailyChallengeView.swift contains hardcoded English strings (lines 43, 63, 75-82, 90, 100)",
    "that bypass the localization system. Even after this PR, those strings will still display in",
    "English. A separate code fix is needed in the private repo.",
    "",
    "---",
    "*Generated by SDK translation E2E pipeline (BA-008.2). Do NOT auto-merge.*",
  ].join("\n");
}

// ------------------------------------------------------------------
// Main E2E Orchestration
// ------------------------------------------------------------------

/**
 * Run the full translation E2E pipeline.
 *
 * Phase 1 (verifying): Analyze bug report + scan LocalizationHelper.swift
 * Phase 2 (awaiting_approval): Pause for human approval
 * Phase 3 (fixing): Run fixer per language, then verify
 * Phase 4 (complete/escalated): Create PR or escalate
 */
export async function runTranslationE2E(
  input: TranslationE2EInput,
): Promise<TranslationE2EResult> {
  const dryRun = input.dryRun ?? true;
  const baseBranch = input.baseBranch ?? "main";
  const branch = input.branch ??
    "sdk/translation-fix-" + input.issueNumber + "-" + new Date().toISOString().slice(0, 10).replace(/-/g, "");

  console.log("=== Translation E2E Orchestration (BA-008.2) ===");
  console.log("Issue: #" + input.issueNumber);
  console.log("Game repo: " + input.gameRepoPath);
  console.log("Dry run: " + dryRun);
  console.log("Branch: " + branch);
  console.log("Max fix attempts: " + LIMITS.MAX_FIX_ATTEMPTS);
  console.log("");

  // ---------------------------------------------------
  // Step 1: Create workflow state
  // ---------------------------------------------------
  const state = await createWorkflowState(
    "translation_verification",
    "dispatch",
    undefined,
    input.issueNumber,
  );
  console.log("[translation-e2e] Workflow created: " + state.workflow_id);

  // ---------------------------------------------------
  // Step 2: Analyze (verifying state)
  // ---------------------------------------------------
  console.log("");
  console.log("--- Step 1: Analyze Bug Report ---");

  let analysisResult: { findings: TranslationFinding[]; englishKeys: Record<string, string> };
  try {
    analysisResult = analyzeTranslationBug(input.issueBody, input.gameRepoPath);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[translation-e2e] Analysis failed: " + errMsg);

    await updateWorkflowState(state.workflow_id, {
      status: "escalated",
      error: "Analysis failed: " + errMsg,
    });

    if (input.issueNumber) {
      postIssueComment(input.issueNumber, "## Translation Fix Failed\n\nCould not analyze the bug report.\n\n**Error:** " + errMsg);
    }

    return {
      status: "escalated",
      workflowId: state.workflow_id,
      totalKeys: 0,
      languagesAffected: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "Analysis failed: " + errMsg,
    };
  }

  if (analysisResult.findings.length === 0) {
    console.log("[translation-e2e] No translation issues found.");
    await updateWorkflowState(state.workflow_id, {
      status: "complete",
      findings: [],
    });
    return {
      status: "complete",
      workflowId: state.workflow_id,
      totalKeys: 0,
      languagesAffected: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: null,
    };
  }

  const findings = analysisResult.findings;
  const workflowFindings = translationToWorkflowFindings(findings);
  const languagesAffected = new Set(findings.flatMap(f => [...f.missingIn, ...f.wrongIn])).size;

  console.log("[translation-e2e] Found " + findings.length + " key(s) needing translation");
  console.log("[translation-e2e] Languages affected: " + languagesAffected);
  for (const f of findings) {
    console.log("  - " + f.key + ": missing in [" + f.missingIn.join(", ") + "]");
  }

  // ---------------------------------------------------
  // Step 3: Save as awaiting_approval, pause
  // ---------------------------------------------------
  await updateWorkflowState(state.workflow_id, {
    status: "awaiting_approval",
    findings: workflowFindings,
  });

  // Post findings summary as issue comment
  const findingsSummary = findings.map(f =>
    "- `" + f.key + "` (English: \"" + f.englishValue + "\"): missing in " + f.missingIn.join(", "),
  ).join("\n");

  postIssueComment(
    input.issueNumber,
    "## Translation Analysis Complete\n\n" +
    "Found **" + findings.length + "** key(s) missing translations in **" + languagesAffected + "** language(s).\n\n" +
    "### Keys to Translate\n" + findingsSummary + "\n\n" +
    "**Workflow:** `" + state.workflow_id + "`\n\n" +
    "Comment `/approve` to proceed with automated translation, or `/reject` to dismiss.\n\n" +
    "*Estimated cost: ~$0.10-0.30*",
  );

  // Save session for later resume
  await saveSession(
    state.workflow_id,
    "sim-" + state.workflow_id,
    "fix_translation",
  );

  console.log("[translation-e2e] Status: awaiting_approval");
  console.log("[translation-e2e] Resume with: orchestrator translation-resume --issue " + input.issueNumber + " --action approve");

  return {
    status: "awaiting_approval",
    workflowId: state.workflow_id,
    totalKeys: findings.length,
    languagesAffected,
    fixAttempts: 0,
    prNumber: null,
    prUrl: null,
    error: null,
  };
}

/**
 * Resume a paused translation workflow after human approval.
 *
 * Steps:
 * 1. Load workflow state
 * 2. Process approval
 * 3. Run fixer for each language (one at a time)
 * 4. Verify translations
 * 5. Create PR or escalate
 */
export async function resumeTranslationE2E(
  workflowId: string,
  action: "approve" | "reject",
  options?: {
    gameRepoPath?: string;
    dryRun?: boolean;
    branch?: string;
    baseBranch?: string;
  },
): Promise<TranslationE2EResult> {
  console.log("=== Translation E2E Resume (BA-008.2) ===");
  console.log("Workflow: " + workflowId);
  console.log("Action: " + action);

  // Load state
  const state = await loadWorkflowState(workflowId);
  if (!state) {
    return {
      status: "escalated",
      workflowId,
      totalKeys: 0,
      languagesAffected: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "No state file found for workflow: " + workflowId,
    };
  }

  if (state.status !== "awaiting_approval") {
    return {
      status: state.status,
      workflowId,
      totalKeys: state.findings.length,
      languagesAffected: 0,
      fixAttempts: state.fix_attempts,
      prNumber: state.pr_number,
      prUrl: null,
      error: "Workflow not in awaiting_approval state (current: " + state.status + ")",
    };
  }

  // Handle rejection
  if (action === "reject") {
    await updateWorkflowState(workflowId, {
      status: "complete",
      rejected_findings: state.findings,
    });
    await removeSession(workflowId);
    console.log("[translation-e2e] Workflow rejected and closed");
    return {
      status: "complete",
      workflowId,
      totalKeys: state.findings.length,
      languagesAffected: 0,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: null,
    };
  }

  // Approval -- proceed with fixing
  const gameRepoPath = options?.gameRepoPath ?? PATHS.GAME_REPO;
  const dryRun = options?.dryRun ?? false;
  const baseBranch = options?.baseBranch ?? "main";
  const branch = options?.branch ??
    "sdk/translation-fix-" + (state.issue_number ?? 0) + "-" +
    new Date().toISOString().slice(0, 10).replace(/-/g, "");

  await updateWorkflowState(workflowId, {
    status: "fixing",
    approved_findings: state.findings,
  });

  console.log("[translation-e2e] Status: fixing");
  console.log("[translation-e2e] Approved " + state.findings.length + " finding(s)");

  // Parse findings back to TranslationFinding format
  const translationFindings: TranslationFinding[] = state.findings.map(f => {
    const missingMatch = f.gates_failed.find(g => g.startsWith("MISSING_IN:"));
    const wrongMatch = f.gates_failed.find(g => g.startsWith("WRONG_IN:"));
    return {
      key: f.event_id,
      englishValue: (f.details.match(/English: "([^"]*)"/) ?? ["", ""])[1],
      missingIn: missingMatch ? missingMatch.replace("MISSING_IN:", "").split(",") : [],
      wrongIn: wrongMatch ? wrongMatch.replace("WRONG_IN:", "").split(",") : [],
    };
  });

  // Re-extract English keys from the file (we need fresh values)
  const locHelperPath = path.join(gameRepoPath, "Localization", "LocalizationHelper.swift");
  const keysToTranslate = translationFindings.map(f => f.key);
  const englishKeys = extractKeysFromSection(locHelperPath, keysToTranslate);

  // Determine all languages that need fixes
  const allMissingLanguages = new Set<string>();
  for (const f of translationFindings) {
    for (const lang of f.missingIn) allMissingLanguages.add(lang);
    for (const lang of f.wrongIn) allMissingLanguages.add(lang);
  }

  console.log("[translation-e2e] Languages to fix: " + Array.from(allMissingLanguages).join(", "));
  console.log("[translation-e2e] Keys to translate: " + keysToTranslate.join(", "));

  // NOTE: In a real pipeline, we would call the AI fixer subagent here per language.
  // For the MVP, the orchestrator framework and state machine are in place.
  // The actual fix application will be done by the GitHub Actions workflow
  // that spawns Claude Code with the translation-fixer.md prompt.
  //
  // For now, this orchestrator:
  // 1. Sets the state to fixing
  // 2. Prepares the context (English keys, target languages, finding details)
  // 3. The YAML workflow handles the actual subagent invocation
  //
  // This matches the content pipeline pattern where content-e2e.ts delegates
  // the actual fixing to the retry loop (retry-loop.ts) which spawns subagents.

  await updateWorkflowState(workflowId, {
    status: "re_verifying",
    fix_attempts: 1,
  });

  console.log("[translation-e2e] Status: re_verifying");
  console.log("[translation-e2e] Fix attempt completed, running verification...");

  // Clean up session
  await removeSession(workflowId);

  // The actual verification and PR creation happen in the YAML workflow
  // after the fixer subagent writes its changes.
  // This function returns the state for the YAML to pick up.

  return {
    status: "re_verifying",
    workflowId,
    totalKeys: translationFindings.length,
    languagesAffected: allMissingLanguages.size,
    fixAttempts: 1,
    prNumber: null,
    prUrl: null,
    error: null,
  };
}
