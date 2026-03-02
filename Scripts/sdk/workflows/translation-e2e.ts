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
import { LIMITS, PATHS, ROUTING, MODELS, FIXER_TOOLS, type WorkflowStatus } from "../config.js";
import { spawnSubagent } from "../lib/subagent.js";
import { buildHooksConfig } from "../lib/hooks.js";
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

/** Language name to ISO code mapping (for grep patterns in LocalizationHelper.swift) */
const LANGUAGE_CODES: Record<string, string> = {
  English: "en",
  Spanish: "es",
  French: "fr",
  German: "de",
  Portuguese: "pt",
  Dutch: "nl",
};

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
 * Uses sed + grep to search only within bounded line ranges, avoiding false
 * matches from other language sections.
 */
function extractKeysFromSection(
  filePath: string,
  searchKeys: string[],
  sectionStartLine?: number,
  sectionEndLine?: number,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of searchKeys) {
    try {
      let grepCmd: string;
      if (sectionStartLine) {
        const endExpr = sectionEndLine ? String(sectionEndLine) : "$";
        grepCmd = "sed -n '" + sectionStartLine + "," + endExpr + "p' " + JSON.stringify(filePath) +
          " | grep '\"" + key + "\"'";
      } else {
        grepCmd = "grep '\"" + key + "\"' " + JSON.stringify(filePath);
      }
      const output = execSync(grepCmd, { encoding: "utf-8", timeout: 10_000 }).trim();
      if (output) {
        // Parse "key": "value" pattern -- take first match line
        const firstLine = output.split("\n")[0];
        const match = firstLine.match(/"([^"]+)":\s*"([^"]*)"/);
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
 * Dynamically detect language section boundaries in LocalizationHelper.swift.
 * Greps for `localizedStrings["XX"]` patterns and computes start/end line pairs.
 * Returns empty object if detection fails (caller should handle gracefully).
 */
function findLanguageSections(
  filePath: string,
): Record<string, { start: number; end: number }> {
  const sections: Array<{ language: string; start: number }> = [];

  try {
    const output = execSync(
      "grep -n 'localizedStrings\\[\"' " + JSON.stringify(filePath),
      { encoding: "utf-8", timeout: 10_000 },
    ).trim();

    for (const line of output.split("\n")) {
      // Pattern: "31:        localizedStrings["en"] = ["
      const lineMatch = line.match(/^(\d+):.*localizedStrings\["(\w+)"\]/);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1], 10);
        const code = lineMatch[2];
        // Reverse lookup: code -> language name
        const langEntry = Object.entries(LANGUAGE_CODES).find(([, c]) => c === code);
        if (langEntry) {
          sections.push({ language: langEntry[0], start: lineNum });
        }
      }
    }
  } catch {
    console.error("[translation-e2e] WARNING: Could not detect language sections via grep");
    return {};
  }

  // Sort by start line
  sections.sort((a, b) => a.start - b.start);

  // Get total line count for the last section's end boundary
  let totalLines: number;
  try {
    const wcOutput = execSync(
      "wc -l < " + JSON.stringify(filePath),
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
    totalLines = parseInt(wcOutput, 10);
  } catch {
    totalLines = 999999;
  }

  // Build result with end boundaries (each section ends where the next begins)
  const result: Record<string, { start: number; end: number }> = {};
  for (let i = 0; i < sections.length; i++) {
    const endLine = i + 1 < sections.length ? sections[i + 1].start - 1 : totalLines;
    result[sections[i].language] = { start: sections[i].start, end: endLine };
  }

  console.log("[translation-e2e] Detected language sections:");
  for (const [lang, bounds] of Object.entries(result)) {
    console.log("  " + lang + ": lines " + bounds.start + "-" + bounds.end);
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

  // Dynamically detect language section boundaries
  const languageSections = findLanguageSections(locHelperPath);
  if (Object.keys(languageSections).length === 0) {
    throw new Error("Could not detect language sections in LocalizationHelper.swift");
  }

  const findings: TranslationFinding[] = [];

  for (const key of Object.keys(englishKeys)) {
    const missingIn: string[] = [];
    const wrongIn: string[] = [];

    for (const language of TARGET_LANGUAGES) {
      const section = languageSections[language];
      if (!section) continue;
      const langKeys = extractKeysFromSection(locHelperPath, [key], section.start, section.end);
      if (!(key in langKeys)) {
        missingIn.push(language);
      }
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
// Fixer Helpers
// ------------------------------------------------------------------

/**
 * Build the user prompt for a translation fixer subagent.
 * Tells the subagent exactly which file to edit, what keys to translate,
 * and which language section to target.
 */
function buildFixerUserPrompt(
  language: string,
  keys: Array<{ key: string; englishValue: string; fixType: "missing" | "wrong" }>,
  locHelperPath: string,
): string {
  const langCode = LANGUAGE_CODES[language] ?? language.toLowerCase();
  const keysBlock = keys.map(k =>
    '"' + k.key + '": "' + k.englishValue + '",'
  ).join("\n");

  const missingKeys = keys.filter(k => k.fixType === "missing");
  const wrongKeys = keys.filter(k => k.fixType === "wrong");

  const instructions: string[] = [
    "Fix translation keys in LocalizationHelper.swift for **" + language + "** (" + langCode + ").",
    "",
    "FILE: " + locHelperPath,
    "",
    "ENGLISH SOURCE KEYS:",
    "```swift",
    keysBlock,
    "```",
    "",
  ];

  if (missingKeys.length > 0) {
    instructions.push(
      "MISSING KEYS (add to the " + language + " section):",
      missingKeys.map(k => "- `" + k.key + "`").join("\n"),
      "",
    );
  }

  if (wrongKeys.length > 0) {
    instructions.push(
      "WRONG KEYS (replace existing translation in the " + language + " section):",
      wrongKeys.map(k => "- `" + k.key + "`").join("\n"),
      "",
    );
  }

  instructions.push(
    "INSTRUCTIONS:",
    "1. Read " + locHelperPath + " to find the " + language + " section (look for `localizedStrings[\"" + langCode + "\"]`)",
    "2. For MISSING keys: translate each English value to " + language + ", then use the Edit tool to add the entries inside the " + language + " dictionary, before the closing bracket `]`",
    "3. For WRONG keys: translate correctly, then use Edit to replace the existing entry",
    "4. Match the file's existing indentation (typically 12 spaces before each key)",
    "5. After editing, use Read to verify your changes are present in the " + language + " section",
    "",
    "CRITICAL RULES:",
    "- NEVER modify the English section or any other language section",
    "- NEVER translate the key names (left side of colon) — only translate values (right side)",
    "- Preserve ALL format specifiers exactly: %d, %@, %lld, %.1f",
    "- Use proper Unicode diacritics for " + language + " (NEVER ASCII substitutes)",
    "",
    "After completing, output a JSON summary:",
    '{"language": "' + language + '", "keys_fixed": [' +
      keys.map(k => '"' + k.key + '"').join(", ") +
    '], "success": true}',
  );

  return instructions.join("\n");
}

/**
 * Re-check specific translation keys after a fix attempt.
 * Returns only the keys that are STILL missing (empty = all fixed).
 */
function recheckTranslationKeys(
  filePath: string,
  keys: string[],
  languages: string[],
  sections: Record<string, { start: number; end: number }>,
): TranslationFinding[] {
  const englishKeys = extractKeysFromSection(filePath, keys);
  const findings: TranslationFinding[] = [];

  for (const key of keys) {
    if (!(key in englishKeys)) continue;
    const missingIn: string[] = [];

    for (const language of languages) {
      const section = sections[language];
      if (!section) continue;
      const langKeys = extractKeysFromSection(filePath, [key], section.start, section.end);
      if (!(key in langKeys)) {
        missingIn.push(language);
      }
    }

    if (missingIn.length > 0) {
      findings.push({ key, englishValue: englishKeys[key], missingIn, wrongIn: [] });
    }
  }

  return findings;
}

/**
 * Create a branch, commit changes, push, and create a PR in the game repo.
 * Returns { prNumber, prUrl } or null on failure.
 */
function createTranslationPR(
  gameRepoPath: string,
  branch: string,
  baseBranch: string,
  findings: TranslationFinding[],
  workflowId: string,
  fixAttempts: number,
  issueNumber: number,
): { prNumber: number; prUrl: string } | null {
  const repo = ROUTING.PRIVATE_REPO;
  const prDescription = buildTranslationPrDescription(findings, workflowId, fixAttempts, issueNumber);

  try {
    // Create branch and commit
    execSync("git checkout -b " + branch, { cwd: gameRepoPath, encoding: "utf-8", timeout: 15_000 });
    execSync('git config user.name "sdk-bot"', { cwd: gameRepoPath, encoding: "utf-8", timeout: 5_000 });
    execSync('git config user.email "sdk-bot@users.noreply.github.com"', { cwd: gameRepoPath, encoding: "utf-8", timeout: 5_000 });
    execSync("git add Localization/LocalizationHelper.swift", { cwd: gameRepoPath, encoding: "utf-8", timeout: 10_000 });

    // Check if there are actual changes
    try {
      execSync("git diff --cached --quiet", { cwd: gameRepoPath, encoding: "utf-8", timeout: 5_000 });
      console.log("[translation-e2e] WARNING: No changes to commit in game repo");
      return null;
    } catch {
      // Non-zero exit = there ARE changes, which is what we want
    }

    execSync(
      'git commit -m "fix(i18n): add missing translations for #' + issueNumber + '"',
      { cwd: gameRepoPath, encoding: "utf-8", timeout: 15_000 },
    );
    execSync("git push origin " + branch, { cwd: gameRepoPath, encoding: "utf-8", timeout: 30_000 });

    // Create PR
    const tmpFile = path.join(tmpdir(), "pr-body-" + Date.now() + ".md");
    fs.writeFileSync(tmpFile, prDescription, "utf-8");

    const prOutput = execSync(
      "gh pr create --repo " + repo +
      " --head " + branch +
      " --base " + baseBranch +
      ' --title "fix(i18n): missing translations for #' + issueNumber + '"' +
      " --body-file " + tmpFile,
      { cwd: gameRepoPath, encoding: "utf-8", timeout: 30_000 },
    ).trim();

    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }

    // Parse PR URL and number from gh output
    const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
    if (prUrlMatch) {
      return {
        prNumber: parseInt(prUrlMatch[1], 10),
        prUrl: prUrlMatch[0],
      };
    }

    console.log("[translation-e2e] PR created but could not parse URL: " + prOutput);
    return null;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[translation-e2e] Failed to create PR: " + errMsg);
    return null;
  }
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

  // Load fixer system prompt
  const repoRoot = process.env.GITHUB_WORKSPACE ?? path.resolve(process.cwd(), "../..");
  const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "translation-fixer.md");
  let fixerSystemPrompt: string;
  try {
    fixerSystemPrompt = fs.readFileSync(promptPath, "utf-8");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[translation-e2e] Could not read fixer prompt at " + promptPath);
    await updateWorkflowState(workflowId, { status: "escalated", error: "Missing fixer prompt: " + errMsg });
    return {
      status: "escalated",
      workflowId,
      totalKeys: translationFindings.length,
      languagesAffected: allMissingLanguages.size,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: "Missing fixer prompt: " + errMsg,
    };
  }

  // Detect current section boundaries (fresh read, post-approval)
  const sections = findLanguageSections(locHelperPath);
  if (Object.keys(sections).length === 0) {
    const secErr = "Could not detect language sections in LocalizationHelper.swift";
    await updateWorkflowState(workflowId, { status: "escalated", error: secErr });
    return {
      status: "escalated",
      workflowId,
      totalKeys: translationFindings.length,
      languagesAffected: allMissingLanguages.size,
      fixAttempts: 0,
      prNumber: null,
      prUrl: null,
      error: secErr,
    };
  }

  // ---------------------------------------------------
  // Fix loop with retry
  // ---------------------------------------------------
  let fixAttempt = 0;
  let remainingFindings = translationFindings;

  while (fixAttempt < LIMITS.MAX_FIX_ATTEMPTS && remainingFindings.length > 0) {
    fixAttempt++;
    console.log("");
    console.log("--- Fix Attempt " + fixAttempt + "/" + LIMITS.MAX_FIX_ATTEMPTS + " ---");

    await updateWorkflowState(workflowId, {
      status: "fixing",
      fix_attempts: fixAttempt,
    });

    // Run fixer for each affected language (one at a time to avoid conflicts)
    for (const language of Array.from(allMissingLanguages)) {
      const keysForLang = remainingFindings
        .filter(f => f.missingIn.includes(language) || f.wrongIn.includes(language))
        .map(f => ({
          key: f.key,
          englishValue: englishKeys[f.key] ?? f.englishValue,
          fixType: (f.missingIn.includes(language) ? "missing" : "wrong") as "missing" | "wrong",
        }));

      if (keysForLang.length === 0) continue;

      const userPrompt = buildFixerUserPrompt(language, keysForLang, locHelperPath);

      console.log("[translation-e2e] Fixing " + keysForLang.length + " key(s) in " + language + "...");

      const fixResult = await spawnSubagent({
        model: MODELS.FIXER,
        tools: [...FIXER_TOOLS],
        prompt: userPrompt,
        systemPrompt: fixerSystemPrompt,
        hooks: buildHooksConfig(),
        cwd: repoRoot,
        maxTurns: 15,
      });

      console.log("[translation-e2e] Fixer " + language + ": success=" + fixResult.success +
        " cost=$" + fixResult.costUsd.toFixed(4) +
        " tools=[" + fixResult.toolsUsed.join(",") + "]");

      if (!fixResult.success) {
        console.error("[translation-e2e] Fixer failed for " + language + ": " + fixResult.error);
      }
    }

    // ---------------------------------------------------
    // Verify: re-detect sections (may have shifted) and re-check keys
    // ---------------------------------------------------
    await updateWorkflowState(workflowId, { status: "re_verifying" });

    const freshSections = findLanguageSections(locHelperPath);
    const languagesToCheck = Array.from(allMissingLanguages);

    remainingFindings = recheckTranslationKeys(
      locHelperPath,
      keysToTranslate,
      languagesToCheck,
      freshSections,
    );

    if (remainingFindings.length === 0) {
      console.log("[translation-e2e] All keys verified present after attempt " + fixAttempt);
    } else {
      console.log("[translation-e2e] Still " + remainingFindings.length +
        " finding(s) after attempt " + fixAttempt + ":");
      for (const f of remainingFindings) {
        console.log("  - " + f.key + ": still missing in [" + f.missingIn.join(", ") + "]");
      }
    }
  }

  // Clean up session
  await removeSession(workflowId);

  // ---------------------------------------------------
  // Result: Create PR or escalate
  // ---------------------------------------------------
  if (remainingFindings.length === 0) {
    // All keys fixed — create PR
    console.log("");
    console.log("--- Creating PR ---");

    const pr = createTranslationPR(
      gameRepoPath, branch, baseBranch,
      translationFindings, workflowId, fixAttempt,
      state.issue_number ?? 0,
    );

    if (pr) {
      await updateWorkflowState(workflowId, {
        status: "complete",
        pr_number: pr.prNumber,
        fix_attempts: fixAttempt,
      });

      if (state.issue_number) {
        postIssueComment(
          state.issue_number,
          "## Translation Fix Complete\n\n" +
          "PR #" + pr.prNumber + " created with translations for " +
          translationFindings.length + " key(s) across " + allMissingLanguages.size + " language(s).\n\n" +
          "**Fix attempts:** " + fixAttempt + "\n" +
          "**Workflow:** `" + workflowId + "`\n\n" +
          "*Do NOT auto-merge — human review required.*",
        );
      }

      console.log("[translation-e2e] PR created: " + pr.prUrl);

      return {
        status: "complete",
        workflowId,
        totalKeys: translationFindings.length,
        languagesAffected: allMissingLanguages.size,
        fixAttempts: fixAttempt,
        prNumber: pr.prNumber,
        prUrl: pr.prUrl,
        error: null,
      };
    }

    // PR creation failed but fixes were applied
    console.error("[translation-e2e] Fixes applied but PR creation failed");
    await updateWorkflowState(workflowId, {
      status: "escalated",
      fix_attempts: fixAttempt,
      error: "Fixes applied but PR creation failed",
    });

    return {
      status: "escalated",
      workflowId,
      totalKeys: translationFindings.length,
      languagesAffected: allMissingLanguages.size,
      fixAttempts: fixAttempt,
      prNumber: null,
      prUrl: null,
      error: "Fixes applied but PR creation failed — check game-repo for uncommitted changes",
    };
  }

  // Exhausted retries — escalate
  console.error("[translation-e2e] Exhausted " + LIMITS.MAX_FIX_ATTEMPTS + " fix attempts");

  await updateWorkflowState(workflowId, {
    status: "escalated",
    fix_attempts: fixAttempt,
    error: "Exhausted " + fixAttempt + " fix attempts, " + remainingFindings.length + " finding(s) remain",
  });

  if (state.issue_number) {
    addHandoffLabel(state.issue_number);
    postIssueComment(
      state.issue_number,
      "## Translation Fix Escalated\n\n" +
      "After **" + fixAttempt + "** attempt(s), **" + remainingFindings.length +
      "** finding(s) still need manual translation.\n\n" +
      "### Remaining Issues\n" +
      remainingFindings.map(f =>
        "- `" + f.key + "`: missing in " + f.missingIn.join(", "),
      ).join("\n") + "\n\n" +
      "**Workflow:** `" + workflowId + "`\n\n" +
      "Manual intervention is required.",
    );
  }

  return {
    status: "escalated",
    workflowId,
    totalKeys: translationFindings.length,
    languagesAffected: allMissingLanguages.size,
    fixAttempts: fixAttempt,
    prNumber: null,
    prUrl: null,
    error: "Exhausted " + fixAttempt + " fix attempts",
  };
}
