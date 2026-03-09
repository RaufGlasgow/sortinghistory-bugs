#!/usr/bin/env npx tsx
/**
 * Story 3.4 AC2: Context download CLI script.
 *
 * Downloads full issue context into a local directory for Claude Code investigation.
 * Uses `gh` CLI for GitHub API access -- no separate token needed.
 *
 * Usage: npx tsx Scripts/sdk/download-context.ts --issue 152
 * Output: context/issue-152/ with context.md, screenshots/, comments.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// State file lookup (optional -- for triage reasoning and attempt history)
// ---------------------------------------------------------------------------

interface WorkflowState {
  workflow_id: string;
  workflow_type: string;
  status: string;
  issue_number: number | null;
  created_at: string;
  updated_at: string;
  attempt_log?: Array<{
    attempt_number: number;
    model: string;
    approach: string;
    result: string;
    error_output: string | null;
    timestamp: string;
  }>;
  qa_results?: Array<{
    attempt_number: number;
    verdict: string;
    findings: string[];
    summary: string;
    timestamp: string;
  }>;
  findings?: Array<{
    event_id: string;
    event_title: string;
    gates_failed: string[];
    details: string;
    severity: string;
  }>;
  [key: string]: unknown;
}

function findWorkflowByIssueSync(issueNumber: number): WorkflowState | null {
  const stateDir = process.env.SDK_STATE_DIR ?? "state/workflows";
  if (!fs.existsSync(stateDir)) return null;

  const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  let latest: WorkflowState | null = null;
  let latestTime = 0;

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf-8")) as WorkflowState;
      if (data.issue_number === issueNumber) {
        const t = new Date(data.created_at).getTime();
        if (t > latestTime) {
          latestTime = t;
          latest = data;
        }
      }
    } catch {
      // Skip corrupt state files
    }
  }

  return latest;
}

// ---------------------------------------------------------------------------
// GitHub API via `gh` CLI
// ---------------------------------------------------------------------------

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  state: string;
}

interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

function ghApiCall(endpoint: string): string {
  try {
    return execSync(
      `gh api "${endpoint}" --paginate`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[download-context] gh API call failed: ${msg}`);
    return "";
  }
}

function fetchIssue(repo: string, issueNumber: number): GitHubIssue | null {
  const raw = ghApiCall(`/repos/${repo}/issues/${issueNumber}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitHubIssue;
  } catch {
    return null;
  }
}

function fetchComments(repo: string, issueNumber: number): GitHubComment[] {
  const raw = ghApiCall(`/repos/${repo}/issues/${issueNumber}/comments`);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as GitHubComment[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Screenshot extraction and download
// ---------------------------------------------------------------------------

function extractImageUrls(text: string): string[] {
  const urls: string[] = [];
  const regex = /!\[.*?\]\((https?:\/\/[^)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

function downloadFile(url: string, destPath: string): boolean {
  try {
    execSync(`curl -sL -o "${destPath}" "${url}"`, { timeout: 30000 });
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Device info extraction
// ---------------------------------------------------------------------------

function extractDeviceInfo(body: string): { model: string; os: string; appVersion: string } | null {
  const section = body.match(/## Device Info\s*([\s\S]*?)(?=##|$)/);
  if (!section || !section[1]) return null;

  const text = section[1];
  const model = text.match(/(?:\*\*Model:\*\*|Model:)\s*(.+)/i)?.[1]?.trim() || "";
  const os = text.match(/(?:\*\*OS(?:\s*Version)?:\*\*|OS(?:\s*Version)?:)\s*(.+)/i)?.[1]?.trim() || "";
  const appVersion = text.match(/(?:\*\*App\s*Version:\*\*|App\s*Version:)\s*(.+)/i)?.[1]?.trim() || "";

  if (!model && !os && !appVersion) return null;
  return { model, os, appVersion };
}

// ---------------------------------------------------------------------------
// Context file builder
// ---------------------------------------------------------------------------

function buildContextMd(
  issue: GitHubIssue,
  comments: GitHubComment[],
  screenshotFiles: string[],
  state: WorkflowState | null,
): string {
  const labels = issue.labels.map((l) => l.name).join(", ") || "none";
  const deviceInfo = extractDeviceInfo(issue.body);

  let md = `# Issue #${issue.number}: ${issue.title}\n\n`;

  // Status
  md += `## Status\n`;
  md += `- Labels: ${labels}\n`;
  md += `- State: ${issue.state}\n`;
  md += `- Created: ${issue.created_at}\n`;
  md += `- Updated: ${issue.updated_at}\n\n`;

  // Triage (from state file if available)
  if (state) {
    const triageData = state as Record<string, unknown>;
    md += `## Triage\n`;
    md += `- Classification: ${triageData.workflow_type || "unknown"}\n`;
    md += `- Status: ${state.status}\n`;
    if (triageData.triage_classification) {
      md += `- Triage Classification: ${triageData.triage_classification}\n`;
    }
    if (triageData.triage_confidence) {
      md += `- Confidence: ${Math.round(Number(triageData.triage_confidence) * 100)}%\n`;
    }
    if (triageData.triage_reasoning) {
      md += `- Reasoning: ${triageData.triage_reasoning}\n`;
    }
    md += `\n`;
  } else {
    md += `## Triage\n- No state file found for this issue.\n\n`;
  }

  // Issue Body
  md += `## Issue Body\n${issue.body}\n\n`;

  // Device Info
  md += `## Device Info\n`;
  if (deviceInfo) {
    md += `- Model: ${deviceInfo.model || "unknown"}\n`;
    md += `- OS: ${deviceInfo.os || "unknown"}\n`;
    md += `- App Version: ${deviceInfo.appVersion || "unknown"}\n`;
  } else {
    md += `- No device info found in issue body.\n`;
  }
  md += `\n`;

  // Screenshots
  md += `## Screenshots\n`;
  if (screenshotFiles.length > 0) {
    for (const f of screenshotFiles) {
      md += `- ${f}\n`;
    }
  } else {
    md += `- No screenshots found.\n`;
  }
  md += `\n`;

  // Comments
  md += `## Comments (${comments.length})\n`;
  if (comments.length > 0) {
    for (const c of comments) {
      md += `### @${c.user.login} (${c.created_at})\n${c.body}\n\n`;
    }
  } else {
    md += `No comments.\n\n`;
  }

  // Attempt History (from state file)
  md += `## Attempt History\n`;
  if (state?.attempt_log && state.attempt_log.length > 0) {
    for (const attempt of state.attempt_log) {
      md += `### Attempt ${attempt.attempt_number} (${attempt.model})\n`;
      md += `- Approach: ${attempt.approach}\n`;
      md += `- Result: ${attempt.result}\n`;
      if (attempt.error_output) {
        md += `- Error: ${attempt.error_output}\n`;
      }
      md += `- Timestamp: ${attempt.timestamp}\n\n`;
    }
  } else {
    md += `No fix attempts recorded.\n\n`;
  }

  // QA Results (from state file)
  if (state?.qa_results && state.qa_results.length > 0) {
    md += `## QA Results\n`;
    for (const qa of state.qa_results) {
      md += `### Attempt ${qa.attempt_number} - ${qa.verdict}\n`;
      md += `- Summary: ${qa.summary}\n`;
      if (qa.findings.length > 0) {
        md += `- Findings: ${qa.findings.join("; ")}\n`;
      }
      md += `- Timestamp: ${qa.timestamp}\n\n`;
    }
  }

  // Suggested Source Files (from state file findings)
  md += `## Suggested Source Files\n`;
  if (state?.findings && state.findings.length > 0) {
    for (const f of state.findings) {
      md += `- ${f.event_title}: ${f.details}\n`;
    }
  } else {
    md += `No source file suggestions from state file.\n`;
  }
  md += `\n`;

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const issueIdx = args.indexOf("--issue");
  if (issueIdx === -1 || !args[issueIdx + 1]) {
    console.error("Usage: npx tsx Scripts/sdk/download-context.ts --issue <number>");
    process.exit(1);
  }

  const issueNumber = parseInt(args[issueIdx + 1], 10);
  if (isNaN(issueNumber)) {
    console.error(`Invalid issue number: ${args[issueIdx + 1]}`);
    process.exit(1);
  }

  const repo = "RaufGlasgow/Sorting-History";
  const contextDir = path.join("context", `issue-${issueNumber}`);
  const screenshotsDir = path.join(contextDir, "screenshots");

  console.log(`[download-context] Downloading context for issue #${issueNumber}...`);

  // 1. Fetch issue
  const issue = fetchIssue(repo, issueNumber);
  if (!issue) {
    console.error(`[download-context] Could not fetch issue #${issueNumber}`);
    process.exit(1);
  }
  console.log(`[download-context] Issue: ${issue.title}`);

  // 2. Fetch comments
  const comments = fetchComments(repo, issueNumber);
  console.log(`[download-context] ${comments.length} comments found`);

  // 3. Create directories
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // 4. Download screenshots
  const allText = [issue.body, ...comments.map((c) => c.body)].join("\n");
  const imageUrls = extractImageUrls(allText);
  const downloadedScreenshots: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const ext = url.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || "png";
    const filename = `screenshot-${i + 1}.${ext}`;
    const destPath = path.join(screenshotsDir, filename);

    if (downloadFile(url, destPath)) {
      downloadedScreenshots.push(`screenshots/${filename}`);
      console.log(`[download-context] Downloaded: ${filename}`);
    } else {
      console.warn(`[download-context] Failed to download: ${url}`);
    }
  }

  // 5. Look up state file
  const state = findWorkflowByIssueSync(issueNumber);
  if (state) {
    console.log(`[download-context] State file found: ${state.workflow_id}`);
  } else {
    console.log(`[download-context] No state file found for issue #${issueNumber}`);
  }

  // 6. Build context.md
  const contextMd = buildContextMd(issue, comments, downloadedScreenshots, state);
  fs.writeFileSync(path.join(contextDir, "context.md"), contextMd, "utf-8");
  console.log(`[download-context] Written: ${contextDir}/context.md`);

  // 7. Write comments.json
  fs.writeFileSync(
    path.join(contextDir, "comments.json"),
    JSON.stringify(comments, null, 2),
    "utf-8",
  );
  console.log(`[download-context] Written: ${contextDir}/comments.json`);

  console.log(`[download-context] Done. Context saved to ${contextDir}/`);
  console.log(`[download-context] Open Claude Code and point it at: ${contextDir}/context.md`);
}

main().catch((err) => {
  console.error("[download-context] Fatal error:", err);
  process.exit(1);
});
