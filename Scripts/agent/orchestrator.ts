#!/usr/bin/env npx tsx

/**
 * Agent SDK Orchestrator
 *
 * Triage mode: reads a GitHub issue, runs a Haiku sub-agent to classify and
 * search actual game files for evidence, then posts findings as a comment
 * and labels the issue.
 *
 * Fix mode: reads issue + triage comment, runs a Sonnet sub-agent to find
 * and fix the problem in game files, then creates a branch, commits, pushes,
 * and opens a PR.
 *
 * Usage:
 *   npx tsx orchestrator.ts --mode triage --issue 173 [--game-repo /path/to/SortingHistory] [--dry-run]
 *   npx tsx orchestrator.ts --mode fix --issue 173 [--game-repo /path/to/SortingHistory] [--dry-run]
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIVATE_REPO = "RaufGlasgow/Sorting-History";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  mode: "triage" | "fix";
  issue: number;
  gameRepo: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let mode: string | undefined;
  let issue: number | undefined;
  let gameRepo: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--mode":
        mode = argv[++i];
        break;
      case "--issue":
        issue = parseInt(argv[++i], 10);
        break;
      case "--game-repo":
        gameRepo = argv[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  if (!mode || !["triage", "fix"].includes(mode)) {
    console.error("Usage: orchestrator.ts --mode triage|fix --issue N [--game-repo PATH] [--dry-run]");
    process.exit(1);
  }
  if (!issue || isNaN(issue)) {
    console.error("Error: --issue N is required (must be a number)");
    process.exit(1);
  }

  // Default game repo: two levels up from Scripts/agent/
  const resolvedGameRepo = gameRepo
    ? resolve(gameRepo)
    : resolve(__dirname, "..", "..");

  return { mode: mode as "triage" | "fix", issue, gameRepo: resolvedGameRepo, dryRun };
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

interface IssueData {
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

function fetchIssue(issueNumber: number): IssueData {
  const raw = execSync(
    `gh issue view ${issueNumber} --repo ${PRIVATE_REPO} --json body,title,labels`,
    { encoding: "utf-8", timeout: 30_000 },
  );
  return JSON.parse(raw);
}

function postComment(issueNumber: number, comment: string): void {
  const tmpFile = join(tmpdir(), `agent-triage-${issueNumber}-${Date.now()}.md`);
  writeFileSync(tmpFile, comment, "utf-8");
  execSync(
    `gh issue comment ${issueNumber} --repo ${PRIVATE_REPO} --body-file "${tmpFile}"`,
    { encoding: "utf-8", timeout: 30_000 },
  );
  console.log(`[orchestrator] Posted comment on issue #${issueNumber}`);
}

function addLabels(issueNumber: number, labels: string[]): void {
  if (labels.length === 0) return;
  const labelArgs = labels.map((l) => `"${l}"`).join(",");
  execSync(
    `gh issue edit ${issueNumber} --repo ${PRIVATE_REPO} --add-label ${labelArgs}`,
    { encoding: "utf-8", timeout: 30_000 },
  );
  console.log(`[orchestrator] Added labels: ${labels.join(", ")}`);
}

function postFailureComment(issueNumber: number, error: string): void {
  const comment = [
    "## Agent Triage Failed",
    "",
    `**Error:** ${error}`,
    "",
    "### Fix Locally",
    "",
    "Run this command to download full context:",
    "",
    "```",
    `npx tsx Scripts/sdk/download-context.ts --issue ${issueNumber}`,
    "```",
    "",
    `This will create a \`context/issue-${issueNumber}/\` directory with the issue body, device info, triage context, and relevant files.`,
  ].join("\n");

  const tmpFile = join(tmpdir(), `agent-failure-${issueNumber}-${Date.now()}.md`);
  writeFileSync(tmpFile, comment, "utf-8");
  try {
    execSync(
      `gh issue comment ${issueNumber} --repo ${PRIVATE_REPO} --body-file "${tmpFile}"`,
      { encoding: "utf-8", timeout: 30_000 },
    );
  } catch {
    console.error("[orchestrator] Failed to post failure comment");
  }
}

// ---------------------------------------------------------------------------
// GitHub helpers (fix mode)
// ---------------------------------------------------------------------------

interface IssueDataWithComments {
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  comments: Array<{ body: string; author: { login: string }; createdAt: string }>;
}

function fetchIssueWithComments(issueNumber: number): IssueDataWithComments {
  const raw = execSync(
    `gh issue view ${issueNumber} --repo ${PRIVATE_REPO} --json body,title,labels,comments`,
    { encoding: "utf-8", timeout: 30_000 },
  );
  return JSON.parse(raw);
}

function findTriageComment(
  comments: IssueDataWithComments["comments"],
): string | null {
  // Look for the triage report comment (posted by the triage agent)
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes("## Agent Triage Report")) {
      return comments[i].body;
    }
  }
  return null;
}

function createBranchAndPR(
  args: Args,
  filesChanged: string[],
  summary: string,
): { prNumber: number; prUrl: string; branch: string } | null {
  const branch = `sdk-fix-${args.issue}`;
  const gameRepo = args.gameRepo;

  try {
    // Create branch from current HEAD
    execSync(`git checkout -b ${branch}`, { cwd: gameRepo, encoding: "utf-8" });

    // Stage all changes
    execSync(`git add -A`, { cwd: gameRepo, encoding: "utf-8" });

    // Check if there are actual changes
    try {
      execSync(`git diff --cached --quiet`, { cwd: gameRepo, encoding: "utf-8" });
      // If this succeeds, there are no changes
      console.log("[orchestrator] No changes to commit. Cleaning up branch.");
      execSync(`git checkout -`, { cwd: gameRepo, encoding: "utf-8" });
      execSync(`git branch -D ${branch}`, { cwd: gameRepo, encoding: "utf-8" });
      return null;
    } catch {
      // git diff --cached --quiet exits non-zero when there ARE changes — this is good
    }

    // Commit
    execSync(
      `git commit -m "fix: agent fix for issue #${args.issue}\n\n${summary}"`,
      { cwd: gameRepo, encoding: "utf-8" },
    );

    // Push
    execSync(`git push origin ${branch}`, { cwd: gameRepo, encoding: "utf-8" });

    // Build PR body
    const prBody = [
      `## Automated Fix for #${args.issue}`,
      "",
      "### Summary",
      "",
      summary,
      "",
      "### Files Changed",
      "",
      ...filesChanged.map((f) => `- \`${f}\``),
      "",
      "---",
      "_Generated by Agent SDK (Sonnet, fix mode)_",
    ].join("\n");

    const prBodyFile = join(tmpdir(), `agent-fix-pr-${args.issue}-${Date.now()}.md`);
    writeFileSync(prBodyFile, prBody, "utf-8");

    // Create PR
    const prOutput = execSync(
      `gh pr create --repo ${PRIVATE_REPO} --head ${branch} --base main ` +
        `--title "fix: agent fix for issue #${args.issue}" ` +
        `--body-file "${prBodyFile}"`,
      { cwd: gameRepo, encoding: "utf-8", timeout: 30_000 },
    ).trim();

    // Parse PR URL and number
    const prUrl = prOutput;
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;

    return { prNumber, prUrl, branch };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] Failed to create branch/PR: ${msg}`);
    // Cleanup: try to switch back
    try {
      execSync(`git checkout -`, { cwd: gameRepo, encoding: "utf-8" });
      execSync(`git branch -D ${branch}`, { cwd: gameRepo, encoding: "utf-8" });
    } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

function postFixComment(
  issueNumber: number,
  prNumber: number,
  prUrl: string,
  filesChanged: string[],
  summary: string,
): void {
  const comment = [
    "## Fix Generated",
    "",
    `**PR:** ${prUrl}`,
    `**Changes:** ${filesChanged.map((f) => `\`${f}\``).join(", ")}`,
    `**Summary:** ${summary}`,
    "",
    "Awaiting your approval. Check your email for Approve/Reject/Fix Locally buttons.",
  ].join("\n");

  postComment(issueNumber, comment);
}

function postFixFailureComment(issueNumber: number, reason: string): void {
  const comment = [
    "## Fix Agent Could Not Fix This",
    "",
    `**Reason:** ${reason}`,
    "",
    "### Fix Locally",
    "",
    "Run this command to download full context:",
    "",
    "```",
    `npx tsx Scripts/sdk/download-context.ts --issue ${issueNumber}`,
    "```",
    "",
    `This will create a \`context/issue-${issueNumber}/\` directory with the issue body, device info, triage context, and relevant files.`,
  ].join("\n");

  const tmpFile = join(tmpdir(), `agent-fix-failure-${issueNumber}-${Date.now()}.md`);
  writeFileSync(tmpFile, comment, "utf-8");
  try {
    execSync(
      `gh issue comment ${issueNumber} --repo ${PRIVATE_REPO} --body-file "${tmpFile}"`,
      { encoding: "utf-8", timeout: 30_000 },
    );
  } catch {
    console.error("[orchestrator] Failed to post fix failure comment");
  }
}

// ---------------------------------------------------------------------------
// Triage prompt builder
// ---------------------------------------------------------------------------

function buildTriagePrompt(issueTitle: string, issueBody: string): string {
  const template = readFileSync(
    join(__dirname, "prompts", "triage.md"),
    "utf-8",
  );
  return template.replace(
    "{ISSUE_BODY}",
    `**Title:** ${issueTitle}\n\n${issueBody}`,
  );
}

// ---------------------------------------------------------------------------
// Parse triage result from agent output
// ---------------------------------------------------------------------------

interface TriageResult {
  classification: string;
  severity: string;
  confidence: number;
  description: string;
  affectedFiles: string[];
}

function parseTriageResult(agentOutput: string): TriageResult | null {
  const startMarker = "---TRIAGE-RESULT---";
  const endMarker = "---END-TRIAGE-RESULT---";

  const startIdx = agentOutput.lastIndexOf(startMarker);
  const endIdx = agentOutput.lastIndexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const block = agentOutput.slice(startIdx + startMarker.length, endIdx).trim();
  const lines = block.split("\n");

  const result: Record<string, string> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    result[key] = value;
  }

  if (!result["CLASSIFICATION"] || !result["SEVERITY"] || !result["CONFIDENCE"]) {
    return null;
  }

  const affectedFiles =
    result["AFFECTED_FILES"] === "none" || !result["AFFECTED_FILES"]
      ? []
      : result["AFFECTED_FILES"].split(",").map((f) => f.trim()).filter(Boolean);

  return {
    classification: result["CLASSIFICATION"],
    severity: result["SEVERITY"],
    confidence: parseInt(result["CONFIDENCE"], 10),
    description: result["DESCRIPTION"] || "No description provided",
    affectedFiles,
  };
}

// ---------------------------------------------------------------------------
// Build the GitHub comment from triage results
// ---------------------------------------------------------------------------

function buildTriageComment(
  triage: TriageResult,
  agentOutput: string,
): string {
  // Extract the agent's investigation notes (everything before the structured block)
  const markerIdx = agentOutput.lastIndexOf("---TRIAGE-RESULT---");
  const investigation = markerIdx > 0
    ? agentOutput.slice(0, markerIdx).trim()
    : "";

  // Truncate investigation if very long (keep last 3000 chars which has the findings)
  const maxInvestigation = 3000;
  const trimmedInvestigation =
    investigation.length > maxInvestigation
      ? "...\n\n" + investigation.slice(-maxInvestigation)
      : investigation;

  const lines = [
    "## Agent Triage Report",
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Classification | \`${triage.classification}\` |`,
    `| Severity | \`${triage.severity}\` |`,
    `| Confidence | ${triage.confidence}% |`,
    "",
    `### Summary`,
    "",
    triage.description,
    "",
  ];

  if (triage.affectedFiles.length > 0) {
    lines.push("### Affected Files", "");
    for (const f of triage.affectedFiles) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  if (trimmedInvestigation) {
    lines.push(
      "<details>",
      "<summary>Agent Investigation Notes</summary>",
      "",
      trimmedInvestigation,
      "",
      "</details>",
      "",
    );
  }

  lines.push("---", "_Triaged by Agent SDK (Haiku, read-only)_");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Classification -> label mapping
// ---------------------------------------------------------------------------

function classificationToLabel(classification: string): string {
  const map: Record<string, string> = {
    content_error: "content-error",
    content_category_error: "content-category-error",
    content_duplicate: "content-duplicate",
    translation_error: "translation-error",
    code_bug: "code-bug",
    gameplay_bug: "gameplay-bug",
    crash_bug: "crash-bug",
    purchase_error: "purchase-error",
    ui_bug: "ui-bug",
    performance_issue: "performance-issue",
    data_corruption: "data-corruption",
    multiplayer_error: "multiplayer-error",
    feature_request: "feature-request",
    needs_human_review: "needs-human-review",
  };
  return map[classification] || "needs-human-review";
}

function severityToLabel(severity: string): string {
  // Normalize: P1 -> severity/P1
  const normalized = severity.toUpperCase().replace(/^P/, "");
  return `severity/P${normalized}`;
}

// ---------------------------------------------------------------------------
// Write output JSON
// ---------------------------------------------------------------------------

function writeOutputJson(
  issueNumber: number,
  mode: string,
  triage: TriageResult | null,
  status: "success" | "failure",
  error?: string,
): void {
  const outputPath = join(__dirname, "agent-output.json");
  const output = {
    issue_number: issueNumber,
    mode,
    classification: triage?.classification || "unknown",
    severity: triage?.severity || "unknown",
    confidence: triage?.confidence || 0,
    description: triage?.description || error || "No result",
    affected_files: triage?.affectedFiles || [],
    status,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`[orchestrator] Wrote ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Fix prompt builder
// ---------------------------------------------------------------------------

function buildFixPrompt(
  issueTitle: string,
  issueBody: string,
  triageComment: string,
): string {
  const template = readFileSync(
    join(__dirname, "prompts", "fix.md"),
    "utf-8",
  );
  return template
    .replace("{ISSUE_BODY}", `**Title:** ${issueTitle}\n\n${issueBody}`)
    .replace("{TRIAGE_COMMENT}", triageComment);
}

// ---------------------------------------------------------------------------
// Parse fix result from agent output
// ---------------------------------------------------------------------------

interface FixResult {
  status: "success" | "cannot_fix";
  filesChanged: string[];
  summary: string;
  eventsModified: number;
}

function parseFixResult(agentOutput: string): FixResult | null {
  const startMarker = "---FIX-RESULT---";
  const endMarker = "---END-FIX-RESULT---";

  const startIdx = agentOutput.lastIndexOf(startMarker);
  const endIdx = agentOutput.lastIndexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const block = agentOutput.slice(startIdx + startMarker.length, endIdx).trim();
  const lines = block.split("\n");

  const result: Record<string, string> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    result[key] = value;
  }

  if (!result["STATUS"]) {
    return null;
  }

  const filesChanged =
    result["FILES_CHANGED"] === "none" || !result["FILES_CHANGED"]
      ? []
      : result["FILES_CHANGED"].split(",").map((f) => f.trim()).filter(Boolean);

  return {
    status: result["STATUS"] === "success" ? "success" : "cannot_fix",
    filesChanged,
    summary: result["SUMMARY"] || "No summary provided",
    eventsModified: parseInt(result["EVENTS_MODIFIED"] || "0", 10),
  };
}

// ---------------------------------------------------------------------------
// Write fix output JSON
// ---------------------------------------------------------------------------

function writeFixOutputJson(
  issueNumber: number,
  fixResult: FixResult | null,
  prNumber: number | null,
  prUrl: string | null,
  branch: string | null,
  status: "success" | "failure",
  error?: string,
): void {
  const outputPath = join(__dirname, "agent-output.json");
  const output = {
    issue_number: issueNumber,
    mode: "fix",
    pr_number: prNumber || null,
    pr_url: prUrl || null,
    branch: branch || null,
    files_changed: fixResult?.filesChanged || [],
    summary: fixResult?.summary || error || "No result",
    events_modified: fixResult?.eventsModified || 0,
    status,
    timestamp: new Date().toISOString(),
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`[orchestrator] Wrote ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Run fix
// ---------------------------------------------------------------------------

async function runFix(args: Args): Promise<void> {
  console.log(`[orchestrator] Fix mode: issue #${args.issue}`);
  console.log(`[orchestrator] Game repo: ${args.gameRepo}`);
  console.log(`[orchestrator] Dry run: ${args.dryRun}`);

  // 1. Fetch issue with comments
  console.log(`[orchestrator] Fetching issue #${args.issue} with comments...`);
  const issue = fetchIssueWithComments(args.issue);
  console.log(`[orchestrator] Title: ${issue.title}`);
  console.log(`[orchestrator] Comments: ${issue.comments.length}`);

  // 2. Find triage comment (optional — fix works with or without it)
  const triageComment = findTriageComment(issue.comments);
  if (triageComment) {
    console.log("[orchestrator] Found triage comment — using it for context.");
  } else {
    console.log("[orchestrator] No triage comment found — using issue body only.");
  }

  // 3. Build fix prompt (works with or without triage comment)
  const prompt = buildFixPrompt(issue.title, issue.body, triageComment || "No prior triage available. Read the issue body carefully and investigate the problem yourself by searching the game files.");

  // 4. Run Agent SDK sub-agent (Sonnet, read+write)
  console.log("[orchestrator] Starting Agent SDK fix sub-agent (Sonnet)...");

  const result = query({
    prompt,
    options: {
      model: "sonnet",
      tools: ["Read", "Edit", "Write", "Grep", "Glob", "Bash"],
      maxTurns: 30,
      cwd: args.gameRepo,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let agentOutput = "";
  for await (const message of result) {
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === "text") {
          agentOutput += block.text + "\n";
        }
      }
    }
  }

  console.log("\n[orchestrator] Agent finished. Output length:", agentOutput.length);

  // 5. Detect what changed using git (reliable) — don't depend on agent text output
  let changedFiles: string[] = [];
  try {
    const diffOutput = execSync(`git diff --name-only && git diff --cached --name-only`, {
      cwd: args.gameRepo, encoding: "utf-8",
    });
    changedFiles = [...new Set(diffOutput.trim().split("\n").filter(f => f.length > 0))];
  } catch {
    changedFiles = [];
  }

  // Also try to parse the agent's structured output (bonus context, not required)
  const fixResult = parseFixResult(agentOutput);

  if (fixResult) {
    console.log("\n[orchestrator] Agent provided structured result:");
    console.log(`  Status: ${fixResult.status}`);
    console.log(`  Summary: ${fixResult.summary}`);
  } else {
    console.log("[orchestrator] Agent did not produce structured output — using git diff instead.");
  }

  // Use git diff as the source of truth for changed files
  if (changedFiles.length === 0 && (!fixResult || fixResult.filesChanged.length === 0)) {
    const msg = "Agent ran but made no file changes.";
    console.error(`[orchestrator] ${msg}`);
    if (!args.dryRun) {
      postFixFailureComment(args.issue, msg + "\n\nAgent output:\n" + agentOutput.slice(-500));
      addLabels(args.issue, ["needs-dev-handoff"]);
    }
    writeFixOutputJson(args.issue, fixResult, null, null, null, "failure", msg);
    process.exit(1);
  }

  // Merge file lists (git diff is authoritative, agent output is supplementary)
  const allChangedFiles = changedFiles.length > 0 ? changedFiles : (fixResult?.filesChanged || []);
  const summary = fixResult?.summary || `Agent modified ${allChangedFiles.length} file(s): ${allChangedFiles.join(", ")}`;
  const eventsModified = fixResult?.eventsModified || allChangedFiles.length;

  console.log(`\n[orchestrator] Files changed (from git): ${allChangedFiles.join(", ")}`);
  console.log(`[orchestrator] Summary: ${summary}`);

  // 6. Handle cannot_fix (only if agent explicitly said so)
  if (fixResult?.status === "cannot_fix") {
    console.log("[orchestrator] Agent explicitly reported it could not fix this issue.");
    if (!args.dryRun) {
      postFixFailureComment(args.issue, fixResult.summary);
      addLabels(args.issue, ["needs-dev-handoff"]);
    } else {
      console.log("[orchestrator] DRY RUN: Would post failure comment and add needs-dev-handoff label.");
    }
    writeFixOutputJson(args.issue, fixResult, null, null, null, "failure", fixResult.summary);
    return;
  }

  // 7. Show diff (always, for visibility)
  console.log("\n[orchestrator] === GIT DIFF ===");
  try {
    const diff = execSync(`git diff`, { cwd: args.gameRepo, encoding: "utf-8" });
    console.log(diff || "(no unstaged changes — agent may have used Edit which stages automatically)");
    // Also show staged changes
    const stagedDiff = execSync(`git diff --cached`, { cwd: args.gameRepo, encoding: "utf-8" });
    if (stagedDiff) {
      console.log("\n=== STAGED CHANGES ===");
      console.log(stagedDiff);
    }
  } catch {
    console.log("(could not get diff)");
  }
  console.log("[orchestrator] === END DIFF ===\n");

  // 8. Create branch and PR (unless dry-run)
  if (args.dryRun) {
    console.log("[orchestrator] DRY RUN: Skipping branch/PR creation.");
    console.log(`[orchestrator] DRY RUN: Would create branch sdk-fix-${args.issue}`);
    console.log(`[orchestrator] DRY RUN: Would create PR with title: "fix: agent fix for issue #${args.issue}"`);
    console.log(`[orchestrator] DRY RUN: Would add label: fix-generated`);

    // Revert only the files the agent changed (preserve pre-existing uncommitted changes)
    console.log("[orchestrator] DRY RUN: Reverting agent changes...");
    if (allChangedFiles.length > 0) {
      for (const file of allChangedFiles) {
        try {
          execSync(`git checkout -- "${file}"`, { cwd: args.gameRepo, encoding: "utf-8" });
          console.log(`[orchestrator] DRY RUN: Reverted ${file}`);
        } catch {
          console.log(`[orchestrator] DRY RUN: Warning — could not revert ${file} (may be a new file)`);
        }
      }
    } else {
      console.log("[orchestrator] DRY RUN: No files reported changed — nothing to revert.");
    }

    writeFixOutputJson(
      args.issue,
      fixResult || { status: "fixed", filesChanged: allChangedFiles, summary, eventsModified },
      null,
      null,
      `sdk-fix-${args.issue}`,
      "success",
    );
  } else {
    const pr = createBranchAndPR(args, allChangedFiles, summary);

    if (!pr) {
      const msg = "No changes were actually made to any files.";
      console.error(`[orchestrator] ${msg}`);
      postFixFailureComment(args.issue, msg);
      addLabels(args.issue, ["needs-dev-handoff"]);
      writeFixOutputJson(args.issue, fixResult, null, null, null, "failure", msg);
      return;
    }

    console.log(`[orchestrator] PR created: ${pr.prUrl}`);

    // Post summary comment on issue
    postFixComment(
      args.issue,
      pr.prNumber,
      pr.prUrl,
      allChangedFiles,
      summary,
    );

    // Label the issue
    addLabels(args.issue, ["fix-generated"]);

    // Write output JSON
    writeFixOutputJson(
      args.issue,
      fixResult || { status: "fixed", filesChanged: allChangedFiles, summary, eventsModified },
      pr.prNumber,
      pr.prUrl,
      pr.branch,
      "success",
    );
  }

  console.log("[orchestrator] Fix complete.");
}

// ---------------------------------------------------------------------------
// Run triage
// ---------------------------------------------------------------------------

async function runTriage(args: Args): Promise<void> {
  console.log(`[orchestrator] Triage mode: issue #${args.issue}`);
  console.log(`[orchestrator] Game repo: ${args.gameRepo}`);
  console.log(`[orchestrator] Dry run: ${args.dryRun}`);

  // 1. Fetch issue
  console.log(`[orchestrator] Fetching issue #${args.issue}...`);
  const issue = fetchIssue(args.issue);
  console.log(`[orchestrator] Title: ${issue.title}`);

  // 2. Build prompt
  const prompt = buildTriagePrompt(issue.title, issue.body);

  // 3. Run Agent SDK sub-agent
  console.log("[orchestrator] Starting Agent SDK triage sub-agent (Haiku)...");

  const result = query({
    prompt,
    options: {
      model: "haiku",
      tools: ["Read", "Grep", "Glob"],
      maxTurns: 25,
      cwd: args.gameRepo,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let agentOutput = "";
  for await (const message of result) {
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === "text") {
          agentOutput += block.text + "\n";
        }
      }
    }
  }

  console.log("\n[orchestrator] Agent finished. Output length:", agentOutput.length);

  // 4. Parse structured result
  const triage = parseTriageResult(agentOutput);

  if (!triage) {
    console.error("[orchestrator] Failed to parse triage result from agent output.");
    console.error("[orchestrator] Raw agent output (last 2000 chars):");
    console.error(agentOutput.slice(-2000));

    if (!args.dryRun) {
      postFailureComment(args.issue, "Agent did not produce a parseable triage result");
      addLabels(args.issue, ["needs-dev-handoff"]);
    }
    writeOutputJson(args.issue, "triage", null, "failure", "Unparseable agent output");
    process.exit(1);
  }

  console.log("\n[orchestrator] Triage result:");
  console.log(`  Classification: ${triage.classification}`);
  console.log(`  Severity: ${triage.severity}`);
  console.log(`  Confidence: ${triage.confidence}%`);
  console.log(`  Description: ${triage.description}`);
  console.log(`  Affected files: ${triage.affectedFiles.join(", ") || "none"}`);

  // 5. Build comment
  const comment = buildTriageComment(triage, agentOutput);

  console.log("\n[orchestrator] === COMMENT TO POST ===");
  console.log(comment);
  console.log("[orchestrator] === END COMMENT ===\n");

  // 6. Post comment and labels (unless dry-run)
  if (args.dryRun) {
    console.log("[orchestrator] DRY RUN: Skipping comment post and label application.");
    const labels = [
      classificationToLabel(triage.classification),
      severityToLabel(triage.severity),
      "sdk-routed",
    ];
    console.log(`[orchestrator] DRY RUN: Would add labels: ${labels.join(", ")}`);
  } else {
    postComment(args.issue, comment);
    const labels = [
      classificationToLabel(triage.classification),
      severityToLabel(triage.severity),
      "sdk-routed",
    ];
    addLabels(args.issue, labels);
  }

  // 7. Write output JSON
  writeOutputJson(args.issue, "triage", triage, "success");

  console.log("[orchestrator] Triage complete.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  try {
    switch (args.mode) {
      case "triage":
        await runTriage(args);
        break;
      case "fix":
        await runFix(args);
        break;
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] Fatal error: ${errorMessage}`);

    // Failsafe: post failure comment and label
    try {
      if (args.issue && !args.dryRun) {
        if (args.mode === "fix") {
          postFixFailureComment(args.issue, errorMessage);
        } else {
          postFailureComment(args.issue, errorMessage);
        }
        addLabels(args.issue, ["needs-dev-handoff"]);
      }
    } catch (commentErr) {
      console.error("[orchestrator] Failed to post failure comment:", commentErr);
    }

    if (args.mode === "fix") {
      writeFixOutputJson(args.issue, null, null, null, null, "failure", errorMessage);
    } else {
      writeOutputJson(args.issue, args.mode, null, "failure", errorMessage);
    }
    process.exit(1);
  }
}

main();
