/**
 * Bug Webhook - Cloudflare Worker
 *
 * Receives bug reports from Sorting History app and creates GitHub Issues.
 * Also handles /approve, /reject, and /merge commands via GitHub webhook.
 *
 * BUG-002: Webhook to GitHub Issue
 * BA-007.14: /approve and /reject via GitHub Webhook
 * PIPE-v2-1.2: /merge endpoint for fix PRs
 */

import { truncateDescription, WORKER_LABEL_TO_SDK_CLASSIFICATION } from './utils';
import { sendOwnerEmail } from './lib/send-owner-email';
import {
  initSchemaAndImport as bbeInitSchemaAndImport,
  dispatchReward as bbeDispatchReward,
  fetchReporterEmailFromIssue as bbeFetchReporterEmail,
  handleManualSend as bbeHandleManualSend,
  invalidateAvailableCodes as bbeInvalidateAvailableCodes,
  runInventoryAlertCheck as bbeRunInventoryAlertCheck,
  runWeeklyDigest as bbeRunWeeklyDigest,
  getInventoryStatus as bbeGetInventoryStatus,
  type BBEEnv,
  type D1DatabaseLike,
} from './bbe';

interface Env {
  GITHUB_TOKEN: string;      // PAT for private repo issues (Sorting-History)
  GITHUB_REPO: string;       // "RaufGlasgow/Sorting-History"
  BUGS_REPO_PAT: string;     // PAT for dispatching to public repo
  BUGS_REPO: string;         // "RaufGlasgow/sortinghistory-bugs"
  WEBHOOK_SECRET: string;    // HMAC secret for GitHub webhook signature validation
  AUTHORIZED_USERS: string;  // Comma-separated GitHub usernames allowed to /approve and /reject
  AUTH_TOKEN: string;         // Token for pipeline email action links (approve/reject/rework/merge)
  SCREENSHOTS_BUCKET: R2Bucket;
  PIPELINE_KV: KVNamespace;  // KV namespace for pipeline action idempotency (approve, reject, merge)
  RESEND_API_KEY: string;    // FR-160: Resend API key for thank-you emails
  OWNER_EMAIL: string;       // Story 5.2: Owner email for digest failure alerts
  USE_AGENT_PIPELINE?: string; // PIPE-SDK-4: When truthy, dispatch agent-triage alongside old analyze. Default: "true"

  // BBE-002: Bug bounty reward email automation (ported from private repo)
  BBE_DB?: D1Database;                     // Cloudflare D1 binding for bug_bounty_codes
  BBE_CSV?: string;                        // One-shot CSV payload (set via `wrangler secret put BBE_CSV`)
  BBE_ADMIN_TOKEN?: string;                // Bearer token for /api/bbe/* admin endpoints
  BBE_ALERT_EMAIL?: string;                // Ra'uf's email for alerts + digest
  BBE_BATCH_ID?: string;                   // e.g. "bug-bounty-batch-NNNNNN"
  BBE_BATCH_EXPIRATION?: string;           // ISO date, e.g. "2026-10-24"
  BBE_REDEEM_BASE?: string;                // Apple redeem URL prefix
  BBE_LOW_INVENTORY_THRESHOLD?: string;    // Default "100"
  BBE_EXPIRATION_WARN_DAYS?: string;       // Default "30"
}

// BBE-002: Adapter from Worker Env to BBE module's minimal D1 interface.
// Returns null when BBE_DB is not yet bound (pre-deploy state) so callers
// can short-circuit gracefully instead of crashing the worker.
function bbeEnv(env: Env): BBEEnv | null {
  if (!env.BBE_DB) return null;
  return {
    BBE_DB: env.BBE_DB as unknown as D1DatabaseLike,
    BBE_CSV: env.BBE_CSV,
    BBE_ADMIN_TOKEN: env.BBE_ADMIN_TOKEN,
    RESEND_API_KEY: env.RESEND_API_KEY,
    GITHUB_TOKEN: env.GITHUB_TOKEN,
    GITHUB_REPO: env.GITHUB_REPO,
    BBE_ALERT_EMAIL: env.BBE_ALERT_EMAIL,
    BBE_BATCH_ID: env.BBE_BATCH_ID,
    BBE_BATCH_EXPIRATION: env.BBE_BATCH_EXPIRATION,
    BBE_REDEEM_BASE: env.BBE_REDEEM_BASE,
    BBE_LOW_INVENTORY_THRESHOLD: env.BBE_LOW_INVENTORY_THRESHOLD,
    BBE_EXPIRATION_WARN_DAYS: env.BBE_EXPIRATION_WARN_DAYS,
  };
}

interface BugReport {
  description: string;
  category?: string;
  screenshot?: string; // base64 encoded
  email?: string;
  deviceInfo?: {
    model?: string;
    osVersion?: string;
    appVersion?: string;
    buildNumber?: string;
    currentScreen?: string;
    gameLanguage?: string;
    locale?: string;
    networkStatus?: string;
    availableMemoryMB?: number;
  };
}

interface ValidationError {
  field: string;
  message: string;
}

interface GitHubIssueResponse {
  number: number;
  html_url: string;
}

interface GitHubLabel {
  name: string;
}

interface WebhookPayload {
  action?: string;
  comment?: {
    body?: string;
  };
  issue?: {
    number?: number;
    title?: string;
    labels?: GitHubLabel[];
    pull_request?: { url?: string };
  };
  sender?: {
    login?: string;
  };
}

// WORKER_LABEL_TO_SDK_CLASSIFICATION imported from ./utils (Story 3.14)

// OLD: CLASSIFICATION_TO_WORKFLOW — will be removed in Phase 5 cutover
// PIPE-SDK-4: Replaced by agent-triage / agent-fix two-dispatch model.
// The Agent SDK orchestrator handles classification routing internally.
//
// const CLASSIFICATION_TO_WORKFLOW: Record<string, string | null> = {
//   'content-error': 'sdk-content-verify',
//   'content-category-error': 'sdk-content-verify',
//   'code-bug': 'sdk-bug-fix',
//   'translation-error': 'sdk-translation-fix',
//   'feature-request': null,
//   'crash-bug': null,
//   'purchase-error': null,
//   'data-corruption': null,
//   'multiplayer-error': null,
//   'performance-issue': null,
//   'needs-human-review': null,
//   'ux-bug': 'sdk-bug-fix',
//   'ui-bug': 'sdk-bug-fix',
//   'gameplay-bug': 'sdk-bug-fix',
//   'content-duplication': 'sdk-bug-fix',
// };

// OLD: WORKFLOW_TO_RESUME — will be removed in Phase 5 cutover
// const WORKFLOW_TO_RESUME: Record<string, string> = {
//   'sdk-content-verify': 'sdk-content-resume',
//   'sdk-translation-fix': 'sdk-translation-resume',
// };

// Story 1.7: Valid labels for error page display
// PIPE-SDK-4: Hardcoded since CLASSIFICATION_TO_WORKFLOW is commented out
const validLabels = [
  'content-error', 'content-category-error', 'code-bug', 'translation-error',
  'feature-request', 'crash-bug', 'purchase-error', 'data-corruption',
  'multiplayer-error', 'performance-issue', 'needs-human-review',
  'ui-bug', 'gameplay-bug', 'content-duplication',
].join(', ');

// PIPE-008: Duplicate detection constants and types
const DEDUP_WINDOW_SECONDS = 604800; // 7 days

interface DedupEntry {
  issueNumber: number;
  issueUrl: string;
  createdAt: string;
  reportCount: number;
  fingerprint: string;
}

interface DedupResult {
  isDuplicate: boolean;
  originalIssueNumber?: number;
  originalIssueUrl?: string;
  reportCount?: number;
}

// The four primary classification labels used for routing from email approve
const PRIMARY_CLASSIFICATION_LABELS = new Set([
  'content-error',
  'code-bug',
  'translation-error',
  'feature-request',
  'ux-bug',
  'ui-bug',
  'gameplay-bug',
  'content-duplication',
  'crash-bug',
  'purchase-error',
  'data-corruption',
  'multiplayer-error',
  'performance-issue',
  'needs-human-review',
]);

// Check if issue labels indicate an SDK content/translation pipeline issue
// Used by handleApprove() and handleReject() to route to the correct pipeline
// Only fact-check issues (wrong data) and translation errors use the content pipeline
const CONTENT_PIPELINE_LABELS = new Set([
  'content-error',
  'translation-error',
]);

// ROBUST-B: Known game category names for text extraction from issue body.
// Sorted longest-first so "Sports History Epic" matches before "Sports History".
// SYNC REQUIRED: Must match Scripts/sdk/lib/categories.ts CATEGORY_FILE_MAP keys.
const KNOWN_CATEGORY_NAMES = [
  "Revolutions & Independence",
  "Technological Inventions",
  "Scientific Discoveries",
  "South American History",
  "Music & Entertainment",
  "Ancient Civilizations",
  "Medical Breakthroughs",
  "Artists & Literature",
  "Sports History Epic",
  "Natural Disasters",
  "Portuguese History",
  "World Wars Epic",
  "US History Epic",
  "Film History Epic",
  "TV History Epic",
  "Space Exploration",
  "European History",
  "Medieval History",
  "Economic Events",
  "Political Events",
  "Religious Events",
  "Geography History",
  "African History",
  "Sports History",
  "Women's History",
  "German History",
  "Animal History",
  "LGBTQ History",
  "Black History",
  "Asian History",
  "Film History",
  "Food & Drink",
  "TV History",
  "US History",
  "World Wars",
];

/**
 * Extract a known category name from free text (e.g., issue body).
 * Returns the first match (longest-first to prefer more specific names), or null.
 */
function extractCategoryFromText(text: string): string | null {
  if (!text) return null;
  const lowerText = text.toLowerCase();
  for (const name of KNOWN_CATEGORY_NAMES) {
    if (lowerText.includes(name.toLowerCase())) {
      return name;
    }
  }
  return null;
}

function isSDKContentPipelineIssue(labels: GitHubLabel[]): boolean {
  return labels.some(l => CONTENT_PIPELINE_LABELS.has(l.name));
}

// Check if issue labels indicate an SDK bug fix pipeline issue (code/UX bugs)
// SDK-BF.3: ui-bug, gameplay-bug, content-duplication, and code-bug are routed through sdk-bug-fix
// content-duplication = duplicate events across JSON files - the dedup agent removes the duplicate
// Story 3.14: Added code-bug (was missing, preventing approved code-bug issues from routing to fix pipeline)
function isSDKBugFixIssue(labels: GitHubLabel[]): boolean {
  return labels.some(l => l.name === 'ui-bug' || l.name === 'gameplay-bug' || l.name === 'content-duplication' || l.name === 'code-bug');
}

// Determine the primary classification label from an issue's labels
// Returns the first matching classification label, or null if none found
function getClassificationLabel(labels: GitHubLabel[]): string | null {
  for (const label of labels) {
    if (PRIMARY_CLASSIFICATION_LABELS.has(label.name)) {
      return label.name;
    }
  }
  return null;
}

// Fetch issue labels and body from GitHub API
async function fetchIssueLabels(env: Env, issueNumber: string): Promise<{ labels: GitHubLabel[]; body: string }> {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch issue #${issueNumber}: ${resp.status}`);
  }
  const issue = await resp.json() as { labels: GitHubLabel[]; body?: string };
  return { labels: issue.labels || [], body: issue.body || '' };
}

// Extract category from issue body markdown (bug report form)
// Looks for patterns like "### Category\n\nSome Category" or "**Category:** Some Category"
function extractCategoryFromBody(body: string): string {
  // Pattern 1: GitHub issue form "### Category\n\nValue"
  const sectionMatch = body.match(/###\s*Category\s*\n+([^\n#]+)/i);
  if (sectionMatch) return sectionMatch[1].trim();
  // Pattern 2: Bold label "**Category:** Value"
  const boldMatch = body.match(/\*\*Category[:\s]*\*\*\s*([^\n]+)/i);
  if (boldMatch) return boldMatch[1].trim();
  return '';
}

// Story 1.6: Fire-and-forget training verdict dispatch to sortinghistory-bugs.
// Non-fatal — errors are logged but never block the primary action.
function dispatchTrainingVerdict(
  env: Env,
  issueNumber: number | string,
  verdict: 'approved' | 'rejected' | 'reworked',
): Promise<void> {
  if (!env.BUGS_REPO_PAT || !env.BUGS_REPO) {
    console.log(`[training-verdict] Skipping verdict dispatch — BUGS_REPO_PAT or BUGS_REPO not configured`);
    return Promise.resolve();
  }
  const workflowId = `bf-issue-${issueNumber}`;
  return fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'SortingHistory-BugWebhook/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      event_type: 'record-verdict',
      client_payload: {
        workflow_id: workflowId,
        verdict,
      },
    }),
  }).then((resp) => {
    if (resp.ok || resp.status === 204) {
      console.log(`[training-verdict] Dispatched ${verdict} for ${workflowId}`);
    } else {
      console.error(`[training-verdict] Dispatch failed: ${resp.status} for ${workflowId}`);
    }
  }).catch((err) => {
    console.error(`[training-verdict] Dispatch error for ${workflowId}:`, err);
  });
}

// C4 fix: Normalize snake_case device info keys from Swift's .convertToSnakeCase encoder
function normalizeDeviceInfo(raw: Record<string, unknown> | undefined): BugReport['deviceInfo'] {
  if (!raw) return undefined;
  return {
    model: (raw.model ?? raw.device_model) as string | undefined,
    osVersion: (raw.osVersion ?? raw.os_version) as string | undefined,
    appVersion: (raw.appVersion ?? raw.app_version) as string | undefined,
    buildNumber: (raw.buildNumber ?? raw.build_number) as string | undefined,
    currentScreen: (raw.currentScreen ?? raw.current_screen) as string | undefined,
    gameLanguage: (raw.gameLanguage ?? raw.game_language) as string | undefined,
    locale: raw.locale as string | undefined,
    networkStatus: (raw.networkStatus ?? raw.network_status) as string | undefined,
    availableMemoryMB: (raw.availableMemoryMB ?? raw.available_memory_mb ?? raw.available_memory_MB) as number | undefined,
  };
}

// Generate a unique confirmation ID
function generateConfirmationId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `BUG-${timestamp}-${random}`.toUpperCase();
}

// Strip HTML tags from text
function sanitizeText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/&[^;]+;/g, ' ') // Remove HTML entities
    .trim();
}

// Upload screenshot to R2 and return the public URL served by this worker
async function uploadScreenshot(
  env: Env,
  base64Data: string,
  confirmationId: string,
  workerOrigin: string
): Promise<string | null> {
  try {
    // Decode base64 to binary
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const key = `screenshots/${confirmationId}.png`;

    await env.SCREENSHOTS_BUCKET.put(key, bytes.buffer, {
      httpMetadata: { contentType: 'image/png' },
    });

    // Return the URL served by this worker's /screenshots/ route
    return `${workerOrigin}/screenshots/${confirmationId}.png`;
  } catch (error) {
    console.error('Screenshot upload to R2 failed:', error);
    return null;
  }
}

// Serve a screenshot from R2
async function handleScreenshotGet(env: Env, key: string): Promise<Response> {
  const object = await env.SCREENSHOTS_BUCKET.get(`screenshots/${key}`);
  if (!object) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  // Allow GitHub and browsers to embed the image
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(object.body, { headers });
}

// Validate the bug report payload
function validateBugReport(data: unknown): { valid: true; report: BugReport } | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be a JSON object' }] };
  }

  const report = data as Record<string, unknown>;

  // Validate description (required, 10-5000 chars)
  if (!report.description || typeof report.description !== 'string') {
    errors.push({ field: 'description', message: 'Description is required and must be a string' });
  } else {
    const desc = report.description.trim();
    if (desc.length < 10) {
      errors.push({ field: 'description', message: 'Description must be at least 10 characters' });
    } else if (desc.length > 5000) {
      errors.push({ field: 'description', message: 'Description must be 5000 characters or less' });
    }
  }

  // Validate category (optional, string)
  if (report.category !== undefined && typeof report.category !== 'string') {
    errors.push({ field: 'category', message: 'Category must be a string' });
  }

  // Validate screenshot (optional, base64 string)
  if (report.screenshot !== undefined) {
    if (typeof report.screenshot !== 'string') {
      errors.push({ field: 'screenshot', message: 'Screenshot must be a base64-encoded string' });
    } else if (report.screenshot.length > 5 * 1024 * 1024) {
      // ~5MB base64 limit
      errors.push({ field: 'screenshot', message: 'Screenshot must be less than 5MB' });
    }
  }

  // Validate email (optional, basic format check)
  if (report.email !== undefined && typeof report.email === 'string' && report.email.length > 0) {
    if (!report.email.includes('@') || !report.email.includes('.')) {
      errors.push({ field: 'email', message: 'Email must be a valid email address' });
    }
  }

  // Validate deviceInfo (optional, object) — accept both camelCase and snake_case keys
  const rawDeviceInfo = report.deviceInfo ?? report.device_info;
  if (rawDeviceInfo !== undefined && typeof rawDeviceInfo !== 'object') {
    errors.push({ field: 'deviceInfo', message: 'Device info must be an object' });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    report: {
      description: sanitizeText(report.description as string),
      category: report.category as string | undefined,
      screenshot: report.screenshot as string | undefined,
      email: report.email as string | undefined,
      deviceInfo: normalizeDeviceInfo(rawDeviceInfo as Record<string, unknown> | undefined),
    },
  };
}

// Format the GitHub issue body
function formatIssueBody(report: BugReport, confirmationId: string, screenshotUrl?: string): string {
  const deviceInfo = report.deviceInfo;

  let body = `## Bug Report\n\n`;
  body += `**Confirmation ID:** \`${confirmationId}\`\n\n`;

  // Structured fields for pipeline parsing
  body += `**Expected behavior:**\nNot specified\n\n`;
  body += `**Actual behavior:**\n${report.description}\n\n`;
  body += `**Steps to reproduce:**\nSee bug report details below\n\n`;
  body += `**Current Screen:**\n${deviceInfo?.currentScreen || 'Not specified'}\n\n`;

  if (report.category) {
    body += `**Category:** ${report.category}\n\n`;
  }

  if (report.email) {
    body += `**Contact Email:** ${report.email}\n\n`;
  }

  body += `---\n\n`;
  body += `## Device Info\n\n`;

  if (deviceInfo) {
    body += `| Field | Value |\n`;
    body += `|-------|-------|\n`;
    if (deviceInfo.model) body += `| Device | ${deviceInfo.model} |\n`;
    if (deviceInfo.osVersion) body += `| iOS | ${deviceInfo.osVersion} |\n`;
    if (deviceInfo.appVersion) body += `| App Version | ${deviceInfo.appVersion} |\n`;
    if (deviceInfo.buildNumber) body += `| Build | ${deviceInfo.buildNumber} |\n`;
    if (deviceInfo.currentScreen) body += `| Screen | ${deviceInfo.currentScreen} |\n`;
    if (deviceInfo.gameLanguage) body += `| Game Language | ${deviceInfo.gameLanguage} |\n`;
    if (deviceInfo.locale) body += `| Locale | ${deviceInfo.locale} |\n`;
    if (deviceInfo.networkStatus) body += `| Network | ${deviceInfo.networkStatus} |\n`;
    if (deviceInfo.availableMemoryMB) body += `| Memory | ${deviceInfo.availableMemoryMB} MB |\n`;
  } else {
    body += `_No device info provided_\n`;
  }

  body += `\n---\n\n`;

  if (screenshotUrl) {
    body += `## Screenshot\n\n`;
    body += `![Screenshot](${screenshotUrl})\n\n`;
    body += `---\n\n`;
  } else if (report.screenshot) {
    // Fallback: embed base64 if R2 upload failed (will be truncated by GitHub for large images)
    body += `## Screenshot\n\n`;
    body += `![Screenshot](data:image/png;base64,${report.screenshot})\n\n`;
    body += `---\n\n`;
  }

  body += `_Submitted via Sorting History app_`;

  return body;
}

// truncateDescription imported from ./utils (Story 3.14)

// Create GitHub issue with retry logic
async function createGitHubIssue(
  env: Env,
  report: BugReport,
  confirmationId: string,
  screenshotUrl?: string
): Promise<{ success: true; issueNumber: number; issueUrl: string } | { success: false; error: string }> {
  const title = `[Bug] ${truncateDescription(report.description)}`;
  const body = formatIssueBody(report, confirmationId, screenshotUrl);
  const labels = ['from-app', 'needs-triage'];

  if (report.category) {
    labels.push(`category/${report.category.toLowerCase().replace(/\s+/g, '-')}`);
  }

  const maxRetries = 3;
  const delays = [1000, 2000, 4000]; // Exponential backoff

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ title, body, labels }),
      });

      if (response.ok) {
        const data = await response.json() as GitHubIssueResponse;
        return {
          success: true,
          issueNumber: data.number,
          issueUrl: data.html_url,
        };
      }

      // Handle specific error cases
      if (response.status === 401) {
        return { success: false, error: 'GitHub authentication failed' };
      }
      if (response.status === 403) {
        return { success: false, error: 'GitHub rate limit or permissions error' };
      }
      if (response.status === 404) {
        return { success: false, error: 'GitHub repository not found' };
      }
      if (response.status === 422) {
        const errorData = await response.json() as { message?: string };
        return { success: false, error: `GitHub validation error: ${errorData.message || 'Unknown'}` };
      }

      // For other errors, retry
      console.error(`GitHub API attempt ${attempt + 1} failed: ${response.status}`);

    } catch (error) {
      console.error(`GitHub API attempt ${attempt + 1} error:`, error);
    }

    // Wait before retrying (except on last attempt)
    if (attempt < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }

  return { success: false, error: 'Failed to create GitHub issue after 3 attempts' };
}

// Dispatch analysis to public bug automation repo
// This bypasses private repo Actions entirely (minutes exhausted)
// C3 fix: retry dispatch + label fallback on failure
// PIPE-SDK-4: Also dispatches agent-triage when USE_AGENT_PIPELINE is enabled
async function dispatchAnalysis(env: Env, issueNumber: number): Promise<void> {
  if (!env.BUGS_REPO_PAT || !env.BUGS_REPO) {
    console.error('BUGS_REPO_PAT or BUGS_REPO not configured - skipping dispatch');
    return;
  }

  // PIPE-SDK-4: Dispatch agent-triage (new pipeline) in parallel with old analyze
  // USE_AGENT_PIPELINE defaults to "true" when not set
  const useAgentPipeline = (env.USE_AGENT_PIPELINE ?? 'true') !== 'false';
  if (useAgentPipeline) {
    try {
      const agentResp = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'agent-triage',
          client_payload: {
            issue_number: issueNumber,
          },
        }),
      });
      if (agentResp.ok || agentResp.status === 204) {
        console.log(`PIPE-SDK-4: Dispatched agent-triage for issue #${issueNumber}`);
      } else {
        console.error(`PIPE-SDK-4: agent-triage dispatch failed: ${agentResp.status}`);
      }
    } catch (agentErr) {
      console.error('PIPE-SDK-4: agent-triage dispatch error:', agentErr);
    }
  }

  // OLD: dispatched 'analyze' — will be removed in Phase 5 cutover
  const maxRetries = 3;
  const delays = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'analyze',
          client_payload: {
            issue_number: issueNumber,
            action: 'opened',
          },
        }),
      });

      if (response.ok || response.status === 204) {
        console.log(`Dispatched analysis for issue #${issueNumber} to ${env.BUGS_REPO}`);
        return; // Success — done
      }

      // Auth/permissions errors won't improve with retries
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        console.error(`Dispatch failed permanently: ${response.status} ${await response.text()}`);
        break;
      }

      console.error(`Dispatch attempt ${attempt + 1} failed: ${response.status}`);
    } catch (error) {
      console.error(`Dispatch attempt ${attempt + 1} error:`, error);
    }

    if (attempt < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }

  // All retries failed — add dispatch-pending label so daily digest catches it
  console.error(`All dispatch retries failed for issue #${issueNumber}. Adding dispatch-pending label.`);
  try {
    await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ labels: ['dispatch-pending'] }),
    });
  } catch (labelError) {
    console.error('Failed to add dispatch-pending label:', labelError);
  }
}

// --- Pipeline email action handlers ---

function escapeHtmlSafe(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pipelinePageHtml(title: string, message: string, isError: boolean = false, nextSteps?: string): string {
  const color = isError ? '#c0392b' : '#8B6914';
  const safeTitle = escapeHtmlSafe(title);
  const nextStepsHtml = nextSteps
    ? `<div class="next-steps"><strong>Next steps:</strong> ${nextSteps}</div>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:${color};margin:0 0 16px;font-size:24px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px}
  .next-steps{background:#1a1a2e;border-radius:8px;padding:14px 18px;margin-top:16px;font-size:14px;color:#999;line-height:1.5;text-align:left}
  .next-steps strong{color:#b0b0b0}
  .badge{display:inline-block;background:${color};color:#fff;padding:6px 16px;border-radius:20px;font-weight:600;margin-top:12px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>${safeTitle}</h1>
  <p>${message}</p>
  ${nextStepsHtml}
  <div class="badge">Sorting History Pipeline</div>
</div>
</body></html>`;
}

function pipelineConfirmHtml(action: string, issueNumber: string, token: string, actionUrl: string): string {
  const isApprove = action === 'approve';
  const color = isApprove ? '#27ae60' : '#c0392b';
  const verb = isApprove ? 'Approve & Fix' : 'Reject & Close';
  const desc = isApprove
    ? `This will trigger the automated fix pipeline for issue #${issueNumber}.`
    : `This will close issue #${issueNumber} as not planned.`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${verb} Issue #${issueNumber} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#8B6914;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:20px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px;margin-bottom:24px}
  button{background:${color};color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>${verb}</h1>
  <div class="issue">Issue #${issueNumber}</div>
  <p>${desc}</p>
  <form method="POST" action="${actionUrl}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNumber}">
    <button type="submit">${verb}</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
</div>
</body></html>`;
}

function commentFormHtml(issueNumber: string, token: string, actionUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comment on Issue #${issueNumber} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:520px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#8B6914;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:20px}
  textarea{width:100%;min-height:120px;background:#0f3460;border:1px solid #8B6914;border-radius:8px;color:#e0e0e0;padding:12px;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box;margin-bottom:16px}
  textarea:focus{outline:none;border-color:#d4a937}
  button{background:#8B6914;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Add Comment</h1>
  <div class="issue">Issue #${issueNumber}</div>
  <form method="POST" action="${actionUrl}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNumber}">
    <textarea name="comment" placeholder="Enter your feedback..." required></textarea>
    <button type="submit">Post Comment</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
</div>
</body></html>`;
}

async function handlePipelineAction(request: Request, env: Env, action: string): Promise<Response> {
  const url = new URL(request.url);

  // GET = show confirmation page
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(pipelinePageHtml('Invalid Link', 'Invalid issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const actionUrl = `${url.origin}/api/pipeline/${action}`;
    return new Response(pipelineConfirmHtml(action, String(issueNum), token, actionUrl), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = execute the action
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = formData.get('token') as string || '';
    const issueNumber = formData.get('issue') as string || '';

    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true), {
        status: 403, headers: { 'Content-Type': 'text/html' },
      });
    }

    if (!issueNumber) {
      return new Response(pipelinePageHtml('Error', 'Missing issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Error', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Require PIPELINE_KV — hard error if not bound
    if (!env.PIPELINE_KV) {
      return new Response(
        pipelinePageHtml(
          'Configuration Error',
          'PIPELINE_KV namespace is not bound. Contact the system owner.',
          true,
        ),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Idempotency check via KV — but allow retry if pipeline already failed
    const kvKey = `${action}:${issueNum}`;
    const existing = await env.PIPELINE_KV.get(kvKey);
    if (existing && action === 'approve') {
      // Check if pipeline failed — if so, clear KV and allow retry
      let hasFailed = false;
      try {
        const { labels } = await fetchIssueLabels(env, issueNumber);
        const failedLabels = ['needs-dev-handoff', 'fix-failed', 'content-fix-failed', 'translation-fix-failed'];
        hasFailed = labels.some((l) => failedLabels.includes(l.name));
      } catch (err) {
        // Non-fatal: if label lookup fails, treat as not-failed and fall through to "already processed"
        console.error(`Idempotency label check failed for #${issueNumber}:`, err);
      }
      if (hasFailed) {
        // Pipeline already failed — don't re-dispatch, show Download or Cancel
        const fixLocallyUrl = `${url.origin}/api/pipeline/fix-locally?issue=${issueNum}&token=${token}`;
        const rejectUrl = `${url.origin}/api/pipeline/reject?issue=${issueNum}&token=${token}`;
        return new Response(
          pipelinePageHtml(
            'Pipeline Could Not Auto-Fix This Issue',
            `<p>The automated pipeline already attempted to fix issue #${issueNumber} but <strong>failed</strong>. Re-running it will produce the same result.</p>
            <p>Choose one:</p>
            <div style="margin:20px 0;">
              <a href="${fixLocallyUrl}" style="display:inline-block;padding:12px 24px;background:#0366d6;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:12px;">Download &amp; Fix Locally</a>
              <a href="${rejectUrl}" style="display:inline-block;padding:12px 24px;background:#cb2431;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Cancel &amp; Close Issue</a>
            </div>
            <p style="color:#666;font-size:14px;">Download gives you the full issue context to fix in Claude Code. Cancel closes the issue permanently.</p>`,
          ),
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      } else {
        return new Response(
          pipelinePageHtml(
            'Already Processed',
            `Approve for issue #${issueNumber} has already been triggered. Check your email for the result.`,
          ),
          { status: 409, headers: { 'Content-Type': 'text/html' } },
        );
      }
    } else if (existing) {
      return new Response(
        pipelinePageHtml(
          'Already Processed',
          `Reject for issue #${issueNumber} has already been triggered. Check your email for the result.`,
        ),
        { status: 409, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // PIPE-SDK-4: Simplified two-gate approve/reject model
    // Gate 1: No PR exists → approve dispatches agent-fix, reject closes issue
    // Gate 2: PR exists (sdk-fix-N) → approve merges PR, reject closes PR + issue
    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'SortingHistory-BugWebhook/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      if (action === 'approve') {
        // Check if a PR exists to distinguish Gate 1 vs Gate 2
        const pr = await getPRForIssue(env, issueNum);

        if (!pr) {
          // ── Gate 1: No PR → dispatch agent-fix ──
          console.log(`PIPE-SDK-4: Gate 1 approve for issue #${issueNumber} - dispatching agent-fix`);

          const dispatchResp = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'SortingHistory-BugWebhook/1.0',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({
              event_type: 'agent-fix',
              client_payload: {
                issue_number: issueNum,
                action: 'approve',
              },
            }),
          });

          if (!dispatchResp.ok && dispatchResp.status !== 204) {
            const errText = await dispatchResp.text();
            console.error(`PIPE-SDK-4: agent-fix dispatch failed: ${dispatchResp.status} ${errText}`);
            return new Response(pipelinePageHtml('Dispatch Failed', `Could not trigger agent-fix pipeline: ${dispatchResp.status}`, true), {
              status: 502, headers: { 'Content-Type': 'text/html' },
            });
          }

          // Record in KV for idempotency (24h TTL)
          await env.PIPELINE_KV.put(kvKey, JSON.stringify({
            action: 'approve',
            gate: 1,
            workflow: 'agent-fix',
            dispatched_at: new Date().toISOString(),
          }), { expirationTtl: 86400 });

          // Add 'approved' label and remove 'needs-triage'
          try {
            await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, {
              method: 'POST',
              headers: ghHeaders,
              body: JSON.stringify({ labels: ['approved-for-fix'] }),
            });
          } catch (labelError) {
            console.error(`Failed to add 'approved' label to issue #${issueNumber}:`, labelError);
          }
          try {
            await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels/needs-triage`, {
              method: 'DELETE',
              headers: ghHeaders,
            });
          } catch (labelError) {
            console.error(`Failed to remove 'needs-triage' label from issue #${issueNumber}:`, labelError);
          }

          // Story 1.6: Record training verdict (fire-and-forget)
          dispatchTrainingVerdict(env, issueNumber, 'approved').catch(() => {});

          return new Response(pipelinePageHtml('Fix Pipeline Triggered', `Issue #${issueNumber} has been approved. The agent-fix pipeline is now running.`, false, 'You will receive an email when the fix is ready for review.'), {
            status: 200, headers: { 'Content-Type': 'text/html' },
          });

        } else {
          // ── Gate 2: PR exists → merge it ──
          console.log(`PIPE-SDK-4: Gate 2 approve for issue #${issueNumber} - merging PR #${pr.number}`);

          // Merge the PR via GitHub API
          const mergeResp = await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/pulls/${pr.number}/merge`,
            {
              method: 'PUT',
              headers: ghHeaders,
              body: JSON.stringify({
                merge_method: 'squash',
                commit_title: `fix: #${issueNum} — ${pr.title}`,
              }),
            },
          );

          if (!mergeResp.ok) {
            const errText = await mergeResp.text();
            console.error(`PIPE-SDK-4: PR merge failed: ${mergeResp.status} ${errText}`);
            return new Response(pipelinePageHtml('Merge Failed', `Could not merge PR #${pr.number}: ${mergeResp.status}. The PR may have merge conflicts or failing checks.`, true), {
              status: 502, headers: { 'Content-Type': 'text/html' },
            });
          }

          // Close the issue
          await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
            method: 'PATCH',
            headers: ghHeaders,
            body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
          }).catch(err => console.error(`Failed to close issue #${issueNumber}:`, err));

          // Delete the fix branch (best-effort)
          await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/refs/heads/${pr.head.ref}`, {
            method: 'DELETE',
            headers: ghHeaders,
          }).catch(err => console.error(`Failed to delete branch ${pr.head.ref}:`, err));

          // Record in KV
          await env.PIPELINE_KV.put(kvKey, JSON.stringify({
            action: 'approve',
            gate: 2,
            pr_number: pr.number,
            merged_at: new Date().toISOString(),
          }), { expirationTtl: 86400 * 7 });

          return new Response(pipelinePageHtml('Fix Merged', `PR #${pr.number} has been merged. Issue #${issueNumber} closed.`, false, 'The fix is now on main.'), {
            status: 200, headers: { 'Content-Type': 'text/html' },
          });
        }

      } else if (action === 'reject') {
        // PIPE-SDK-4: Reject at either gate - close PR (if any), delete branch, close issue
        const pr = await getPRForIssue(env, issueNum);

        if (pr) {
          // Close the PR with a comment
          await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${pr.number}/comments`,
            {
              method: 'POST',
              headers: ghHeaders,
              body: JSON.stringify({ body: 'Owner rejected the fix.' }),
            },
          ).catch(() => {});

          await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/pulls/${pr.number}`,
            {
              method: 'PATCH',
              headers: ghHeaders,
              body: JSON.stringify({ state: 'closed' }),
            },
          ).catch(err => console.error(`Failed to close PR #${pr.number}:`, err));

          // Delete the fix branch (best-effort)
          await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/refs/heads/${pr.head.ref}`, {
            method: 'DELETE',
            headers: ghHeaders,
          }).catch(err => console.error(`Failed to delete branch ${pr.head.ref}:`, err));

          console.log(`PIPE-SDK-4: Closed PR #${pr.number} and deleted branch ${pr.head.ref} for rejected issue #${issueNumber}`);
        }

        // Close the issue as not_planned
        const closeResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
          method: 'PATCH',
          headers: ghHeaders,
          body: JSON.stringify({
            state: 'closed',
            state_reason: 'not_planned',
          }),
        });

        if (!closeResp.ok) {
          const errText = await closeResp.text();
          console.error(`Pipeline reject close failed: ${closeResp.status} ${errText}`);
          return new Response(pipelinePageHtml('Close Failed', `Could not close issue #${issueNumber}: ${closeResp.status}`, true), {
            status: 502, headers: { 'Content-Type': 'text/html' },
          });
        }

        // Record in KV for idempotency (24h TTL)
        await env.PIPELINE_KV.put(kvKey, JSON.stringify({
          action: 'reject',
          closed_at: new Date().toISOString(),
          pr_closed: pr ? pr.number : null,
        }), { expirationTtl: 86400 });

        // Story 1.6: Record training verdict (fire-and-forget)
        dispatchTrainingVerdict(env, issueNumber, 'rejected').catch(() => {});

        const prNote = pr ? ` PR #${pr.number} closed and branch deleted.` : '';
        return new Response(pipelinePageHtml('Issue Rejected', `Issue #${issueNumber} has been rejected and closed.${prNote}`, false, 'This issue has been closed and will not appear in future digests.'), {
          status: 200, headers: { 'Content-Type': 'text/html' },
        });
      }
    } catch (error) {
      console.error(`Pipeline ${action} error:`, error);
      return new Response(pipelinePageHtml('Error', `An unexpected error occurred: ${error}`, true), {
        status: 500, headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  return new Response(pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true), {
    status: 405, headers: { 'Content-Type': 'text/html' },
  });
}

async function handlePipelineRedo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET = show confirmation page
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(pipelinePageHtml('Invalid Link', 'Invalid issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const actionUrl = `${url.origin}/api/pipeline/redo`;
    const color = '#22863a';
    return new Response(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Retry Triage - Issue #${issueNum} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#8B6914;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:20px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px;margin-bottom:24px}
  button{background:${color};color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Retry Triage</h1>
  <div class="issue">Issue #${issueNum}</div>
  <p>This will re-run the AI triage pipeline for issue #${issueNum}.</p>
  <form method="POST" action="${actionUrl}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNum}">
    <button type="submit">Retry Triage</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
</div>
</body></html>`, {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = dispatch triage retry
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = formData.get('token') as string || '';
    const issueNumber = formData.get('issue') as string || '';

    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true), {
        status: 403, headers: { 'Content-Type': 'text/html' },
      });
    }

    if (!issueNumber) {
      return new Response(pipelinePageHtml('Error', 'Missing issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(pipelinePageHtml('Error', 'Invalid issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    // Remove triage-failed label before retrying
    try {
      await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels/triage-failed`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (labelErr) {
      console.error(`Failed to remove triage-failed label from issue #${issueNumber}:`, labelErr);
    }

    // PIPE-SDK-4: Dispatch agent-triage (new pipeline) for redo
    // Also dispatch old 'analyze' for parallel testing — will be removed in Phase 5
    const useAgentPipeline = (env.USE_AGENT_PIPELINE ?? 'true') !== 'false';
    if (useAgentPipeline) {
      try {
        await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'SortingHistory-BugWebhook/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            event_type: 'agent-triage',
            client_payload: { issue_number: issueNum },
          }),
        });
        console.log(`PIPE-SDK-4: Dispatched agent-triage redo for issue #${issueNum}`);
      } catch (agentErr) {
        console.error('PIPE-SDK-4: agent-triage redo dispatch error:', agentErr);
      }
    }

    // OLD: dispatched 'analyze' — will be removed in Phase 5 cutover
    const dispatchResp = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: 'analyze',
        client_payload: { issue_number: issueNum },
      }),
    });

    if (!dispatchResp.ok && dispatchResp.status !== 204) {
      const errText = await dispatchResp.text();
      console.error(`Redo triage dispatch failed: ${dispatchResp.status} ${errText}`);
      return new Response(pipelinePageHtml('Dispatch Failed', `Could not trigger triage retry: ${dispatchResp.status}`, true), {
        status: 502, headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response(pipelinePageHtml('Triage Retry Triggered', `Issue #${issueNumber} has been resubmitted for AI triage. You will receive an email when analysis is complete.`, false, 'Triage has been re-triggered. Check your next digest for the new classification.'), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  return new Response(pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true), {
    status: 405, headers: { 'Content-Type': 'text/html' },
  });
}

async function handlePipelineComment(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET = show comment form
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(pipelinePageHtml('Invalid Link', 'Invalid issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    // Story 3.9: Guard — if reporter has no contact email, don't show comment form
    if (env.AUTH_TOKEN && token === env.AUTH_TOKEN && env.GITHUB_TOKEN) {
      try {
        const issueResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNum}`, {
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'SortingHistory-BugWebhook/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (issueResp.ok) {
          const issueData = await issueResp.json() as Record<string, unknown>;
          const issueBody = (issueData?.body as string) || '';
          const hasEmail = /\*\*Contact Email:\*\*\s*\S+@\S+/.test(issueBody);
          if (!hasEmail) {
            const fixLocallyUrl = `${url.origin}/api/pipeline/fix-locally?issue=${issueNum}&token=${token}`;
            return new Response(pipelinePageHtml(
              'Reporter Unreachable',
              `This issue has no contact email — the reporter cannot be reached. Use Fix Locally to resolve this issue in Claude Code.<br><br><a href="${fixLocallyUrl}" style="display:inline-block;padding:14px 24px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Fix Locally</a>`
            ), {
              status: 200, headers: { 'Content-Type': 'text/html' },
            });
          }
        }
      } catch {
        // If GitHub API fails, fall through to show the comment form anyway
      }
    }

    const actionUrl = `${url.origin}/api/pipeline/comment`;
    return new Response(commentFormHtml(String(issueNum), token, actionUrl), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = post comment to GitHub
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = formData.get('token') as string || '';
    const issueNumber = formData.get('issue') as string || '';
    const comment = formData.get('comment') as string || '';

    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true), {
        status: 403, headers: { 'Content-Type': 'text/html' },
      });
    }

    if (!issueNumber || !comment.trim()) {
      return new Response(pipelinePageHtml('Error', 'Missing issue number or comment text.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    try {
      // Fetch issue body to find reporter email
      const issueResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      const issueData = issueResp.ok ? await issueResp.json() as Record<string, unknown> : null;
      const issueBody = (issueData?.body as string) || '';
      const emailMatch = issueBody.match(/\*\*Contact Email:\*\*\s*(\S+@\S+)/);
      const reporterEmail = emailMatch ? emailMatch[1] : null;

      // Email the reporter if they provided an email, BEFORE posting the GitHub comment
      // so the comment can be annotated with the email delivery result
      let emailSent = false;
      let emailFailed = false;
      let emailStatus = '';
      if (reporterEmail && env.RESEND_API_KEY) {
        const emailResult = await sendOwnerEmail(env, {
          from: 'Sorting History <hello@sortinghistory.com>',
          to: reporterEmail,
          subject: `Re: Your bug report #${issueNumber} \u2014 Sorting History`,
          html: `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #1a3a4a;">
    <h1 style="color: #1a3a4a; margin: 0; font-size: 24px;">Sorting History</h1>
  </div>
  <div style="padding: 30px 0;">
    <h2 style="color: #1a3a4a;">We need a bit more info</h2>
    <p style="line-height: 1.6;">Thank you for reporting bug #${issueNumber}. We\u2019re looking into it but need a little more detail to understand the issue.</p>
    <div style="background: #f0f7fa; border-left: 4px solid #1a3a4a; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
      <p style="margin: 0; line-height: 1.6;">${comment.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>
    </div>
    <p style="line-height: 1.6;">You can reply to this email with more details, or submit a new bug report from the app with a screenshot if possible.</p>
  </div>
  <div style="border-top: 1px solid #e0e0e0; padding-top: 16px; text-align: center; color: #999; font-size: 13px;">
    <p>\u2014 The Sorting History Team</p>
  </div>
</body></html>`,
        });
        if (emailResult.ok) {
          emailSent = true;
          emailStatus = ' Email sent to reporter.';
          console.log(`Pipeline comment: follow-up email sent to ${reporterEmail.substring(0, 3)}***`);
        } else {
          emailFailed = true;
          emailStatus = ` Email to reporter failed (${emailResult.error || 'unknown'}).`;
          console.error(`Pipeline comment: email send failed: ${emailResult.error}`);
        }
      } else if (!reporterEmail) {
        emailStatus = ' No contact email on this issue \u2014 reporter cannot be reached.';
      }

      // Post comment on GitHub, annotated with email delivery status
      const emailAnnotation = emailSent
        ? `\n\n> \u2709\uFE0F Email sent to reporter.`
        : reporterEmail && emailFailed
          ? `\n\n> \u26A0\uFE0F Email to reporter failed \u2014 follow up manually.`
          : !reporterEmail
            ? `\n\n> \u26A0\uFE0F No contact email on this issue \u2014 reporter cannot be reached via email.`
            : '';
      const commentBody = `## Owner Feedback\n\n${comment.trim()}${emailAnnotation}\n\n---\n*Posted via pipeline email action.*`;

      const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body: commentBody }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`Pipeline comment failed: ${resp.status} ${errText}`);
        // If email was already sent successfully, tell the owner
        const emailNote = emailSent ? ' (Note: the email to the reporter WAS sent before this failure.)' : '';
        return new Response(pipelinePageHtml('Comment Failed', `Could not post comment on issue #${issueNumber}: ${resp.status}.${emailNote}`, true), {
          status: 502, headers: { 'Content-Type': 'text/html' },
        });
      }

      const commentNextSteps = emailSent
        ? 'Email sent to reporter. Check your next digest for any response.'
        : !reporterEmail
          ? `No contact email on this issue — reporter cannot be reached. <a href="/api/pipeline/reject?issue=${encodeURIComponent(issueNumber)}&token=${encodeURIComponent(token)}" style="display:inline-block;margin-top:12px;padding:10px 20px;background:#cb2431;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Close as Insufficient Info</a>`
          : 'Check your next digest for any updates.';
      return new Response(pipelinePageHtml('Comment Posted', `Your feedback has been posted on issue #${issueNumber}.${emailStatus}`, false, commentNextSteps), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    } catch (error) {
      console.error('Pipeline comment error:', error);
      return new Response(pipelinePageHtml('Error', `An unexpected error occurred: ${error}`, true), {
        status: 500, headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  return new Response(pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true), {
    status: 405, headers: { 'Content-Type': 'text/html' },
  });
}

// ============================================================================
// Pipeline Rework Endpoint
// ============================================================================

function reworkFormHtml(issueNumber: string, token: string, actionUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rework Issue #${issueNumber} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:520px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#d97706;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:8px}
  .hint{color:#888;font-size:13px;margin-bottom:20px;line-height:1.5}
  .field-label{display:block;text-align:left;color:#b0b0b0;font-size:13px;margin-bottom:6px;margin-top:16px}
  select{width:100%;background:#0f3460;border:1px solid #d97706;border-radius:8px;color:#e0e0e0;padding:12px;font-size:14px;font-family:inherit;box-sizing:border-box;appearance:none;cursor:pointer}
  select:focus{outline:none;border-color:#f59e0b}
  textarea{width:100%;min-height:120px;background:#0f3460;border:1px solid #555;border-radius:8px;color:#e0e0e0;padding:12px;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box;margin-top:0}
  textarea:focus{outline:none;border-color:#f59e0b}
  textarea.required-highlight{border-color:#ef4444}
  button{background:#d97706;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s;margin-top:16px;width:100%}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px;width:auto}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Rework Analysis</h1>
  <div class="issue">Issue #${issueNumber}</div>
  <div class="hint">Select the correct classification to route directly to the right pipeline, or choose "(none)" to re-triage with your notes.</div>
  <form method="POST" action="${actionUrl}" id="reworkForm">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNumber}">
    <label class="field-label" for="classification">Correct Classification</label>
    <select name="classification" id="classification">
      <option value="">(none — re-triage with notes)</option>
      <option value="code-bug">code-bug — gameplay or code defect</option>
      <option value="ux-bug">ux-bug — UI layout or interaction issue</option>
      <option value="content-error">content-error — wrong fact, date, or data in content JSON</option>
      <option value="translation-error">translation-error — bad translation of existing content</option>
      <option value="crash-bug">crash-bug — app terminates or force-quit required</option>
      <option value="purchase-error">purchase-error — subscription or payment issue</option>
      <option value="data-corruption">data-corruption — lost, reset, or corrupted game data</option>
      <option value="multiplayer-error">multiplayer-error — network play or Pass &amp; Play issue</option>
      <option value="performance-issue">performance-issue — slow, laggy, or unresponsive</option>
      <option value="feature-request">feature-request — enhancement or new capability</option>
    </select>
    <label class="field-label" for="guidance">Correction Notes <span id="optionalLabel" style="color:#666">(optional)</span></label>
    <textarea name="guidance" id="guidance" placeholder="e.g. This is a gameplay bug — epic mode doesn't filter events to the selected category..."></textarea>
    <button type="submit">Reclassify &amp; Dispatch</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
</div>
<script>
  // Make guidance required only when no classification is selected (re-triage path)
  const sel = document.getElementById('classification');
  const ta = document.getElementById('guidance');
  const opt = document.getElementById('optionalLabel');
  function updateRequired() {
    const isRetriage = sel.value === '';
    ta.required = isRetriage;
    opt.textContent = isRetriage ? '(required for re-triage)' : '(optional)';
    opt.style.color = isRetriage ? '#f59e0b' : '#666';
  }
  sel.addEventListener('change', updateRequired);
  updateRequired();
</script>
</body></html>`;
}

async function handlePipelineRework(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET = show rework form
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(pipelinePageHtml('Invalid Link', 'Invalid issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }
    const actionUrl = `${url.origin}/api/pipeline/rework`;
    return new Response(reworkFormHtml(String(issueNum), token, actionUrl), {
      status: 200, headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = reclassify directly OR re-triage with correction notes
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = formData.get('token') as string || '';
    const issueNumber = formData.get('issue') as string || '';
    const newClassification = (formData.get('classification') as string || '').trim();
    const guidance = (formData.get('guidance') as string || '').trim();

    // Auth check
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true), {
        status: 403, headers: { 'Content-Type': 'text/html' },
      });
    }

    if (!issueNumber) {
      return new Response(pipelinePageHtml('Error', 'Missing issue number.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    // Validate classification if provided (defends against form manipulation)
    if (newClassification && !PRIMARY_CLASSIFICATION_LABELS.has(newClassification)) {
      return new Response(pipelinePageHtml('Invalid Classification', 'Invalid classification. Choose from the dropdown.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    // Re-triage path requires guidance text
    if (!newClassification && !guidance) {
      return new Response(pipelinePageHtml('Error', 'Missing guidance text. Provide correction notes when requesting re-triage.', true), {
        status: 400, headers: { 'Content-Type': 'text/html' },
      });
    }

    const githubHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'SortingHistory-BugWebhook/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    try {
      // ---------------------------------------------------------------
      // PATH A: Direct reclassification
      // ---------------------------------------------------------------
      if (newClassification) {
        // 1. Post reclassification comment
        const notesSection = guidance ? `\n\n${guidance}` : '';
        const commentBody = `## Owner Reclassification\n\nReclassified as: \`${newClassification}\`.${notesSection}\n\n---\n*Direct reclassification via pipeline email. Triage bypassed.*`;

        const commentResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`, {
          method: 'POST',
          headers: githubHeaders,
          body: JSON.stringify({ body: commentBody }),
        });

        if (!commentResp.ok) {
          const errText = await commentResp.text();
          console.error(`Rework comment failed: ${commentResp.status} ${errText}`);
          return new Response(pipelinePageHtml('Comment Failed', `Could not post comment on issue #${issueNumber}: ${commentResp.status}`, true), {
            status: 502, headers: { 'Content-Type': 'text/html' },
          });
        }

        // 2. Remove all old classification labels and routing/state labels
        const ALL_CLASSIFICATION_LABELS = [
          // Primary classification labels
          'content-error', 'code-bug', 'translation-error', 'feature-request', 'ux-bug',
          'crash-bug', 'purchase-error', 'data-corruption', 'multiplayer-error', 'performance-issue',
          // Legacy classification labels
          'ui-bug', 'gameplay-bug', 'content-duplication',
          // Routing/state labels that must be cleared on reclassification
          'sdk-routed', 'needs-human-review', 'needs-handoff-review',
          'needs-dev-handoff', 'category-mismatch', 'fix-failed', 'approved', 'pr-created',
          'needs-agent-fix', 'low-confidence',
        ];
        for (const label of ALL_CLASSIFICATION_LABELS) {
          await fetch(
            `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
            { method: 'DELETE', headers: githubHeaders }
          ).catch(() => {}); // Ignore 404s — label may not be present
        }

        // 3. Add new classification label
        await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, {
          method: 'POST',
          headers: githubHeaders,
          body: JSON.stringify({ labels: [newClassification] }),
        });

        // 4. PIPE-SDK-4: Route to agent-fix (simplified - agent handles classification internally)
        // Feature requests and handoff-only classifications still get special handling
        const HANDOFF_ONLY_LABELS = new Set([
          'crash-bug', 'purchase-error', 'data-corruption',
          'multiplayer-error', 'performance-issue', 'needs-human-review',
        ]);

        if (newClassification === 'feature-request') {
          await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({ labels: ['backlog'] }),
          }).catch(() => {});
          return new Response(pipelinePageHtml('Feature Request Logged', `Issue #${issueNumber} reclassified as feature-request and added to the backlog. No fix pipeline was triggered.`, false, 'This issue will not appear in future digests.'), {
            status: 200, headers: { 'Content-Type': 'text/html' },
          });
        }

        if (HANDOFF_ONLY_LABELS.has(newClassification)) {
          await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({ labels: ['needs-dev-handoff'] }),
          }).catch(() => {});
          return new Response(pipelinePageHtml('Handoff Only — No Automated Fix', `Issue #${issueNumber} reclassified as "${newClassification}" which is a handoff-only classification. No automated fix pipeline was dispatched.`, false, 'Download the Fix Locally handoff from the issue page and resolve manually.'), {
            status: 200, headers: { 'Content-Type': 'text/html' },
          });
        }

        // Dispatch agent-fix for all other classifications
        if (env.BUGS_REPO_PAT && env.BUGS_REPO) {
          const dispatchResp = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'SortingHistory-BugWebhook/1.0',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({
              event_type: 'agent-fix',
              client_payload: {
                issue_number: parseInt(issueNumber, 10),
                action: 'approve',
              },
            }),
          });

          if (!dispatchResp.ok && dispatchResp.status !== 204) {
            const dispatchBody = await dispatchResp.text();
            console.error(`Rework dispatch FAILED: issue #${issueNumber}, agent-fix, status ${dispatchResp.status}`);
            return new Response(pipelinePageHtml('Dispatch Failed', `Issue #${issueNumber} was reclassified as \`${newClassification}\`, but the dispatch to agent-fix failed (HTTP ${dispatchResp.status}): ${dispatchBody.slice(0, 200)}`, true), {
              status: 502, headers: { 'Content-Type': 'text/html' },
            });
          }
        }

        console.log(`Rework: issue #${issueNumber} reclassified as ${newClassification}, dispatched agent-fix`);

        // Story 1.6: Record training verdict (fire-and-forget)
        dispatchTrainingVerdict(env, issueNumber, 'reworked').catch(() => {});

        return new Response(pipelinePageHtml('Reclassified & Dispatched', `Issue #${issueNumber} reclassified as \`${newClassification}\` and dispatched to the agent-fix pipeline.`, false, 'The issue has been re-submitted. Check your next digest for the new result.'), {
          status: 200, headers: { 'Content-Type': 'text/html' },
        });
      }

      // ---------------------------------------------------------------
      // PATH B: Re-triage with correction notes (no classification selected)
      // ---------------------------------------------------------------

      // 1. Post correction comment
      const commentBody = `## Owner Correction\n\n${guidance}\n\n---\n*Re-triage requested via pipeline email. Triage agent will receive these notes.*`;

      const commentResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({ body: commentBody }),
      });

      if (!commentResp.ok) {
        const errText = await commentResp.text();
        console.error(`Rework comment failed: ${commentResp.status} ${errText}`);
        return new Response(pipelinePageHtml('Comment Failed', `Could not post guidance on issue #${issueNumber}: ${commentResp.status}`, true), {
          status: 502, headers: { 'Content-Type': 'text/html' },
        });
      }

      // 2. Strip old labels, add needs-triage
      const labelsToRemove = [
        'sdk-routed', 'needs-human-review', 'needs-handoff-review',
        'content-error', 'category-mismatch', 'translation-error',
        'fix-failed', 'approved', 'pr-created',
      ];
      for (const label of labelsToRemove) {
        await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
          { method: 'DELETE', headers: githubHeaders }
        ).catch(() => {});
      }

      await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`, {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({ labels: ['needs-triage'] }),
      });

      // 3. PIPE-SDK-4: Dispatch agent-triage (new) + old analyze (parallel testing)
      if (env.BUGS_REPO_PAT && env.BUGS_REPO) {
        const useAgentPipeline = (env.USE_AGENT_PIPELINE ?? 'true') !== 'false';
        if (useAgentPipeline) {
          await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'SortingHistory-BugWebhook/1.0',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({
              event_type: 'agent-triage',
              client_payload: { issue_number: parseInt(issueNumber, 10) },
            }),
          }).catch(err => console.error('PIPE-SDK-4: agent-triage rework dispatch error:', err));
        }

        // OLD: dispatched 'analyze' — will be removed in Phase 5 cutover
        await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'SortingHistory-BugWebhook/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            event_type: 'analyze',
            client_payload: {
              issue_number: parseInt(issueNumber, 10),
              action: 'labeled',
              correction_notes: guidance,
            },
          }),
        });
      }

      // Story 1.6: Record training verdict (fire-and-forget)
      dispatchTrainingVerdict(env, issueNumber, 'reworked').catch(() => {});

      return new Response(pipelinePageHtml('Re-triage Triggered', `Your correction has been posted on issue #${issueNumber} and the pipeline will re-analyze it with your guidance.`, false, 'The issue has been re-submitted. Check your next digest for the new result.'), {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });

    } catch (error) {
      console.error('Pipeline rework error:', error);
      return new Response(pipelinePageHtml('Error', `An unexpected error occurred: ${error}`, true), {
        status: 500, headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  return new Response(pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true), {
    status: 405, headers: { 'Content-Type': 'text/html' },
  });
}

// ============================================================================
// Pipeline Merge Endpoint (PIPE-v2-1.2)
// ============================================================================

interface GitHubPR {
  number: number;
  title: string;
  html_url: string;
  head: {
    ref: string;
  };
  state: string;
}

// Branch naming patterns used by SDK fix pipelines
const MERGE_BRANCH_PATTERNS = ['sdk-fix-', 'content-fix-', 'translation-fix-', 'sdk/translation-fix-', 'sdk/content-fix-', 'sdk/sdk-fix-'];

// Find an open PR in the private repo for a given issue number by branch pattern
async function getPRForIssue(env: Env, issueNumber: number): Promise<GitHubPR | null> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=open&per_page=100`,
    {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Failed to list PRs: ${response.status} ${errText}`);
    throw new Error(`GitHub API error listing PRs: HTTP ${response.status}`);
  }

  const prs = (await response.json()) as GitHubPR[];
  console.log(`getPRForIssue: found ${prs.length} open PRs, searching for issue ${issueNumber}`);

  for (const pr of prs) {
    const branch = pr.head.ref;
    console.log(`getPRForIssue: checking PR #${pr.number} branch="${branch}"`);
    for (const pattern of MERGE_BRANCH_PATTERNS) {
      // Use startsWith to handle date-suffixed branches (e.g., sdk/translation-fix-145-20260304)
      if (branch.startsWith(`${pattern}${issueNumber}`)) {
        return pr;
      }
    }
  }

  return null;
}

// Dispatch a repository_dispatch event to the bugs repo.
// rebase-and-merge.yml listens on repository_dispatch type 'merge-fix' (NOT workflow_dispatch).
async function dispatchRepositoryEvent(
  env: Env,
  eventType: string,
  clientPayload: Record<string, string>,
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${env.BUGS_REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-BugWebhook/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        event_type: eventType,
        client_payload: clientPayload,
      }),
    },
  );

  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Failed to dispatch ${eventType}: ${response.status} ${await response.text()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// PIPE-011 AC-8/AC-9: Review Build - build + upload to TestFlight (Empty Cup)
// ---------------------------------------------------------------------------

function reviewBuildConfirmHtml(issueNumber: string, token: string, actionUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review Build - Issue #${issueNumber} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#22863a;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:20px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px;margin-bottom:24px}
  button{background:#22863a;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px}
  .note{font-size:13px;color:#888;margin-top:16px;padding:12px;background:#1a1a2e;border-radius:8px;}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Build &amp; Send to TestFlight</h1>
  <div class="issue">Issue #${issueNumber}</div>
  <p>This will build the app from the fix branch and upload it to TestFlight for the <strong style="color:#e0e0e0;">Empty Cup</strong> internal testing group only. The PR will NOT be merged.</p>
  <form method="POST" action="${actionUrl}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNumber}">
    <button type="submit">Confirm: Build &amp; Send to TestFlight</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
  <div class="note">Build takes ~15-20 minutes. You will receive an email when the TestFlight build is ready.</div>
</div>
</body></html>`;
}

async function handleReviewBuild(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET = show confirmation page
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(
        pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Invalid Link', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const actionUrl = `${url.origin}/api/pipeline/review-build`;
    return new Response(reviewBuildConfirmHtml(String(issueNum), token, actionUrl), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = dispatch review-build event
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = (formData.get('token') as string) || '';
    const issueNumber = (formData.get('issue') as string) || '';

    // Verify auth token
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(
        pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true),
        { status: 403, headers: { 'Content-Type': 'text/html' } },
      );
    }

    if (!issueNumber) {
      return new Response(
        pipelinePageHtml('Error', 'Missing issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Require PIPELINE_KV
    if (!env.PIPELINE_KV) {
      return new Response(
        pipelinePageHtml(
          'Configuration Error',
          'PIPELINE_KV namespace is not bound. Contact the system owner.',
          true,
        ),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Error', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Idempotency check via KV
    const kvKey = `review-build:${issueNum}`;
    const existing = await env.PIPELINE_KV.get(kvKey);
    if (existing) {
      return new Response(
        pipelinePageHtml(
          'Already Processed',
          `A review build for issue #${issueNum} has already been triggered. Check your email for the TestFlight build notification.`,
        ),
        { status: 409, headers: { 'Content-Type': 'text/html' } },
      );
    }

    try {
      // Find the associated PR by branch naming pattern
      const pr = await getPRForIssue(env, issueNum);

      if (!pr) {
        console.error(`No open PR found for issue #${issueNum}`);
        return new Response(
          pipelinePageHtml(
            'No PR Found',
            `No open pull request was found for issue #${issueNum}. The fix PR may have already been merged, or the fix pipeline may not have completed yet.`,
            true,
          ),
          { status: 404, headers: { 'Content-Type': 'text/html' } },
        );
      }

      // Dispatch review-build event to bugs repo
      await dispatchRepositoryEvent(env, 'review-build', {
        pr_number: String(pr.number),
        issue_number: String(issueNum),
        head_branch: pr.head.ref,
      });

      // Record in KV for idempotency
      await env.PIPELINE_KV.put(kvKey, JSON.stringify({
        pr_number: pr.number,
        dispatched_at: new Date().toISOString(),
      }), {
        expirationTtl: 86400 * 7, // 7 days
      });

      console.log(
        `Dispatched review-build for PR #${pr.number} (issue #${issueNum}, branch ${pr.head.ref})`,
      );

      return new Response(
        pipelinePageHtml(
          'Review Build Triggered',
          `Building PR #${pr.number} for TestFlight (Empty Cup only). The build takes ~15-20 minutes. You will receive an email when the TestFlight build is ready. Come back to the original PR email to Approve, Rework, or Reject after testing.`,
          false,
          'Build is being created. You\'ll receive an email when the TestFlight build is ready.',
        ),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    } catch (error) {
      console.error(`Review build error for issue #${issueNum}:`, error);
      return new Response(
        pipelinePageHtml('Build Request Failed', `An error occurred: ${error}`, true),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }
  }

  return new Response(
    pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true),
    { status: 405, headers: { 'Content-Type': 'text/html' } },
  );
}

// ---------------------------------------------------------------------------
// PIPE-011 AC-15: Approve Merge - merge PR to main after device testing
// ---------------------------------------------------------------------------

function approveMergeConfirmHtml(issueNumber: string, token: string, actionUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve &amp; Merge - Issue #${issueNumber} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#2563eb;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:20px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px;margin-bottom:24px}
  button{background:#2563eb;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Merge Fix to Main</h1>
  <div class="issue">Issue #${issueNumber}</div>
  <p>This will rebase the fix branch against main, squash-merge the PR, bump the version permanently, and close the issue. This action is permanent.</p>
  <form method="POST" action="${actionUrl}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNumber}">
    <button type="submit">Confirm: Merge to Main</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
</div>
</body></html>`;
}

async function handleApproveMerge(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET = show confirmation page
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(
        pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Invalid Link', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const actionUrl = `${url.origin}/api/pipeline/approve-merge`;
    return new Response(approveMergeConfirmHtml(String(issueNum), token, actionUrl), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = dispatch approve-merge event
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = (formData.get('token') as string) || '';
    const issueNumber = (formData.get('issue') as string) || '';

    // Verify auth token
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(
        pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true),
        { status: 403, headers: { 'Content-Type': 'text/html' } },
      );
    }

    if (!issueNumber) {
      return new Response(
        pipelinePageHtml('Error', 'Missing issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Require PIPELINE_KV
    if (!env.PIPELINE_KV) {
      return new Response(
        pipelinePageHtml(
          'Configuration Error',
          'PIPELINE_KV namespace is not bound. Contact the system owner.',
          true,
        ),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Error', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Idempotency check via KV
    const kvKey = `approve-merge:${issueNum}`;
    const existing = await env.PIPELINE_KV.get(kvKey);
    if (existing) {
      return new Response(
        pipelinePageHtml(
          'Already Processed',
          `Approve-merge for issue #${issueNum} has already been triggered. Check your email for the result.`,
        ),
        { status: 409, headers: { 'Content-Type': 'text/html' } },
      );
    }

    try {
      // Find the associated PR by branch naming pattern
      const pr = await getPRForIssue(env, issueNum);

      if (!pr) {
        console.error(`No open PR found for issue #${issueNum}`);
        return new Response(
          pipelinePageHtml(
            'No PR Found',
            `No open pull request was found for issue #${issueNum}. The fix PR may have already been merged, or the fix pipeline may not have completed yet.`,
            true,
          ),
          { status: 404, headers: { 'Content-Type': 'text/html' } },
        );
      }

      // Dispatch approve-merge event to bugs repo
      await dispatchRepositoryEvent(env, 'approve-merge', {
        pr_number: String(pr.number),
        issue_number: String(issueNum),
        head_branch: pr.head.ref,
      });

      // Record in KV for idempotency
      await env.PIPELINE_KV.put(kvKey, JSON.stringify({
        pr_number: pr.number,
        dispatched_at: new Date().toISOString(),
      }), {
        expirationTtl: 86400 * 7, // 7 days
      });

      console.log(
        `Dispatched approve-merge for PR #${pr.number} (issue #${issueNum}, branch ${pr.head.ref})`,
      );

      return new Response(
        pipelinePageHtml(
          'Merge Triggered',
          `PR #${pr.number} is being rebased and merged into main. The version will be bumped and the issue closed. You will receive a confirmation email.`,
          false,
          'The PR is being merged to main. You\'ll receive a confirmation email.',
        ),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    } catch (error) {
      console.error(`Approve-merge error for issue #${issueNum}:`, error);
      return new Response(
        pipelinePageHtml('Merge Failed', `An error occurred: ${error}`, true),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }
  }

  return new Response(
    pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true),
    { status: 405, headers: { 'Content-Type': 'text/html' } },
  );
}

function mergeConfirmHtml(issueNumber: string, token: string, actionUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Merge Fix for Issue #${issueNumber} - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:#166534;margin:0 0 8px;font-size:24px}
  .issue{color:#b0b0b0;font-size:14px;margin-bottom:20px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px;margin-bottom:24px}
  button{background:#166534;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.85}
  .cancel{background:transparent;color:#888;font-size:14px;margin-top:12px;padding:8px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Merge Fix</h1>
  <div class="issue">Issue #${issueNumber}</div>
  <p>This will find the fix PR, rebase it against main, and squash-merge it. The source issue will be closed automatically.</p>
  <form method="POST" action="${actionUrl}">
    <input type="hidden" name="token" value="${token}">
    <input type="hidden" name="issue" value="${issueNumber}">
    <button type="submit">Merge Fix</button>
  </form>
  <button class="cancel" onclick="window.close()">Cancel</button>
</div>
</body></html>`;
}

async function handleMerge(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // GET = show confirmation page
  if (request.method === 'GET') {
    const token = url.searchParams.get('token') || '';
    const issueNumber = url.searchParams.get('issue') || '';
    if (!token || !issueNumber) {
      return new Response(
        pipelinePageHtml('Invalid Link', 'Missing token or issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Invalid Link', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }
    const actionUrl = `${url.origin}/api/pipeline/merge`;
    return new Response(mergeConfirmHtml(String(issueNum), token, actionUrl), {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // POST = execute the merge
  if (request.method === 'POST') {
    const formData = await request.formData();
    const token = (formData.get('token') as string) || '';
    const issueNumber = (formData.get('issue') as string) || '';

    // Verify auth token
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return new Response(
        pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true),
        { status: 403, headers: { 'Content-Type': 'text/html' } },
      );
    }

    if (!issueNumber) {
      return new Response(
        pipelinePageHtml('Error', 'Missing issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Require PIPELINE_KV — hard error if not bound
    if (!env.PIPELINE_KV) {
      return new Response(
        pipelinePageHtml(
          'Configuration Error',
          'PIPELINE_KV namespace is not bound. Contact the system owner.',
          true,
        ),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }

    const issueNum = parseInt(issueNumber, 10);
    if (isNaN(issueNum)) {
      return new Response(
        pipelinePageHtml('Error', 'Invalid issue number.', true),
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      );
    }

    // Idempotency check via KV
    const kvKey = `merge:${issueNum}`;
    const existing = await env.PIPELINE_KV.get(kvKey);
    if (existing) {
      return new Response(
        pipelinePageHtml(
          'Already Processed',
          `Merge for issue #${issueNum} has already been triggered. Check your email for the result.`,
        ),
        { status: 409, headers: { 'Content-Type': 'text/html' } },
      );
    }

    try {
      // Find the associated PR by branch naming pattern
      const pr = await getPRForIssue(env, issueNum);

      if (!pr) {
        console.error(`No open PR found for issue #${issueNum}`);
        return new Response(
          pipelinePageHtml(
            'No PR Found',
            `No open pull request was found for issue #${issueNum}. The fix PR may have already been merged, or the fix pipeline may not have completed yet.`,
            true,
          ),
          { status: 404, headers: { 'Content-Type': 'text/html' } },
        );
      }

      // Dispatch merge-fix event to rebase-and-merge.yml
      // The workflow reads: client_payload.pr_number, .issue_number, .head_branch
      await dispatchRepositoryEvent(env, 'merge-fix', {
        pr_number: String(pr.number),
        issue_number: String(issueNum),
        head_branch: pr.head.ref,
      });

      // Record in KV for idempotency
      await env.PIPELINE_KV.put(kvKey, JSON.stringify({
        pr_number: pr.number,
        dispatched_at: new Date().toISOString(),
      }), {
        expirationTtl: 86400 * 7, // 7 days
      });

      console.log(
        `Dispatched merge-fix for PR #${pr.number} (issue #${issueNum}, branch ${pr.head.ref})`,
      );

      return new Response(
        pipelinePageHtml(
          'Merge Triggered',
          `PR #${pr.number} is being rebased and merged into main. You will receive an email when the merge completes.`,
          false,
          'The PR is being merged. You\'ll receive a confirmation email when complete.',
        ),
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    } catch (error) {
      console.error(`Pipeline merge error for issue #${issueNum}:`, error);
      return new Response(
        pipelinePageHtml('Merge Failed', `An error occurred: ${error}`, true),
        { status: 500, headers: { 'Content-Type': 'text/html' } },
      );
    }
  }

  return new Response(
    pipelinePageHtml('Method Not Allowed', 'Use GET or POST.', true),
    { status: 405, headers: { 'Content-Type': 'text/html' } },
  );
}

// CORS headers for preflight requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// Helper to create a JSON response with CORS headers
function jsonResponse(body: Record<string, unknown>, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// GitHub Webhook Signature Verification (HMAC-SHA256)
// Uses Web Crypto API (Cloudflare Workers compatible)
// ============================================================================

async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const digest =
    'sha256=' +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  // Constant-time comparison to prevent timing attacks
  if (digest.length !== signature.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < digest.length; i++) {
    mismatch |= digest.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// ============================================================================
// BBE-002: /api/bbe/* admin endpoints + /api/reward-code/status public read
// ============================================================================

async function handleBBEAdmin(request: Request, env: Env, path: string): Promise<Response> {
  // Bearer token auth (BBE_ADMIN_TOKEN). All BBE admin endpoints require it.
  const auth = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(auth.trim());
  if (!env.BBE_ADMIN_TOKEN || !match || match[1] !== env.BBE_ADMIN_TOKEN) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  const env2 = bbeEnv(env);
  if (!env2) {
    return jsonResponse({ error: 'BBE_DB not bound on worker' }, 500);
  }
  // Ensure schema is present. Cheap when already initialized.
  await bbeInitSchemaAndImport(env2);

  if (path === '/api/bbe/status' && request.method === 'GET') {
    const inv = await bbeGetInventoryStatus(env2);
    return jsonResponse({ ok: true, inventory: inv });
  }
  if (path === '/api/bbe/manual-send' && request.method === 'POST') {
    let body: { recipient_email?: string; reason?: string; locale?: string };
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const email = (body.recipient_email || '').trim();
    if (!email.includes('@')) return jsonResponse({ error: 'recipient_email required' }, 400);
    const res = await bbeHandleManualSend(env2, {
      recipient_email: email,
      reason: body.reason,
      locale: body.locale,
    });
    return jsonResponse(res, res.ok ? 200 : 409);
  }
  if (path === '/api/bbe/invalidate-batch' && request.method === 'POST') {
    let body: { reason?: string };
    try { body = await request.json(); } catch { body = {}; }
    const n = await bbeInvalidateAvailableCodes(env2, body.reason || 'manual-invalidate');
    return jsonResponse({ ok: true, invalidated: n });
  }
  if (path === '/api/bbe/import-csv' && request.method === 'POST') {
    const n = await bbeInitSchemaAndImport(env2);
    return jsonResponse({ ok: true, imported: n });
  }
  if (path === '/api/bbe/run-alerts' && request.method === 'POST') {
    await bbeRunInventoryAlertCheck(env2);
    return jsonResponse({ ok: true });
  }
  if (path === '/api/bbe/run-digest' && request.method === 'POST') {
    const res = await bbeRunWeeklyDigest(env2);
    return jsonResponse({ ok: true, ...res });
  }
  return jsonResponse({ error: `Unknown BBE route: ${path}` }, 404);
}

// BBE-002: Public read-only inventory status. Consumed by
// .github/workflows/daily-analysis-digest.yml so the digest banner can
// report accurate pool size instead of falling back to "EMPTY". No auth:
// the response contains only aggregate counts, no codes, no PII.
async function handleRewardCodeStatus(env: Env): Promise<Response> {
  const env2 = bbeEnv(env);
  if (!env2) {
    return jsonResponse({ remaining: 0, total: 0, low: false, empty: true, configured: false });
  }
  try {
    await bbeInitSchemaAndImport(env2);
    const inv = await bbeGetInventoryStatus(env2);
    const lowThreshold = parseInt(env.BBE_LOW_INVENTORY_THRESHOLD || '100', 10);
    return jsonResponse({
      remaining: inv.available,
      total: inv.total,
      reserved: inv.reserved,
      used: inv.used,
      invalidated: inv.invalidated,
      days_to_expiration: inv.daysToExpiration,
      low: inv.available < lowThreshold,
      empty: inv.available === 0,
      configured: true,
    });
  } catch (err) {
    console.error('BBE: reward-code/status failed', err);
    return jsonResponse({ remaining: 0, total: 0, low: false, empty: true, configured: false, error: 'lookup-failed' });
  }
}

// ============================================================================
// /api/commands - GitHub Webhook Handler for /approve and /reject
// ============================================================================

async function handleCommandsWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Verify the webhook secret is configured
  if (!env.WEBHOOK_SECRET) {
    console.error('WEBHOOK_SECRET not configured - rejecting webhook');
    return jsonResponse({ error: 'Webhook not configured' }, 500);
  }

  // Read the raw body for signature verification
  const rawBody = await request.text();

  // Verify GitHub webhook signature
  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature) {
    return jsonResponse({ error: 'Missing signature header' }, 401);
  }

  const isValid = await verifyWebhookSignature(rawBody, signature, env.WEBHOOK_SECRET);
  if (!isValid) {
    return jsonResponse({ error: 'Invalid signature' }, 401);
  }

  // Parse the webhook payload
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload' }, 400);
  }

  const eventType = request.headers.get('X-GitHub-Event');

  // BBE-002 / BUG-REWARD-EMAIL-OVERHAUL-001 (Option C):
  // Reward-code dispatch on `issues.labeled` events. Fires ONLY when the
  // `reward-approved` label is added (manual PM action). The previous
  // `approved-for-fix` / `approved` triggers were retired so reward
  // dispatch no longer fires automatically when triage approves a fix.
  // Runs in background so GitHub does not retry on Resend latency.
  if (eventType === 'issues' && payload.action === 'labeled') {
    const labelName = ((payload as { label?: { name?: string } }).label?.name || '').toLowerCase();
    if (labelName === 'reward-approved') {
      const env2 = bbeEnv(env);
      const issueNumber = (payload as { issue?: { number?: number } }).issue?.number;
      if (!env2 || !issueNumber) {
        return jsonResponse({ ignored: true, reason: 'BBE not configured or no issue number' });
      }
      ctx.waitUntil((async () => {
        try {
          await bbeInitSchemaAndImport(env2);
          const { email, gameLanguage, locale } = await bbeFetchReporterEmail(env2, issueNumber);
          const issueLabels = ((payload as { issue?: { labels?: { name?: string }[] } }).issue?.labels || [])
            .map((l) => l?.name || '');
          const result = await bbeDispatchReward(env2, {
            issueNumber,
            labels: issueLabels,
            recipientEmail: email,
            gameLanguage,
            locale,
          });
          console.log(`BBE dispatchReward for #${issueNumber}: ${result.status}${result.code ? ` (${result.code})` : ''}`);
        } catch (err) {
          console.error('BBE dispatchReward error:', err);
        }
      })());
      return jsonResponse({ accepted: true, issue_number: issueNumber, bbe: 'queued' });
    }
    return jsonResponse({ ignored: true, reason: `Label '${labelName}' is not a BBE trigger` });
  }

  // Only handle issue_comment events with action "created"
  if (eventType !== 'issue_comment') {
    return jsonResponse({ ignored: true, reason: `Event type '${eventType}' not handled` });
  }

  if (payload.action !== 'created') {
    return jsonResponse({ ignored: true, reason: `Action '${payload.action}' not handled` });
  }

  // Check sender authorization against configured list
  const sender = payload.sender?.login;
  const authorizedUsers = (env.AUTHORIZED_USERS || '').split(',').map(u => u.trim().toLowerCase());
  if (!sender || !authorizedUsers.includes(sender.toLowerCase())) {
    return jsonResponse({ ignored: true, reason: 'Unauthorized sender' });
  }

  // Parse the comment for /approve, /reject, or /legacy commands
  const commentBody = payload.comment?.body?.trim() || '';
  const isApprove = commentBody.toLowerCase().startsWith('/approve');
  const isReject = commentBody.toLowerCase().startsWith('/reject');
  const isLegacy = commentBody.toLowerCase().startsWith('/legacy');

  if (!isApprove && !isReject && !isLegacy) {
    return jsonResponse({ ignored: true, reason: 'No command found in comment' });
  }

  // Get issue number
  const issueNumber = payload.issue?.number;
  if (!issueNumber) {
    return jsonResponse({ error: 'No issue number in payload' }, 400);
  }

  // GitHub API headers for private repo operations
  const githubHeaders = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'SortingHistory-BugWebhook/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // PR comments: skip from-app label check (PRs don't carry issue labels)
  // Only handle /reject on pipeline PRs (title matches "fix: #XX -" pattern)
  if (isReject && payload.issue?.pull_request) {
    const prTitle = payload.issue?.title || '';
    // Match both old format "fix: #XX -" and new format "fix(issue XX):"
    if (!/^fix[:(]/.test(prTitle)) {
      return jsonResponse({
        ignored: true,
        reason: 'PR is not a pipeline-generated fix (title does not match pipeline format)',
      });
    }
    return await handleFixRejection(env, issueNumber, commentBody, githubHeaders, ctx);
  }

  // Issue commands: require from-app label
  const labels = payload.issue?.labels || [];
  const hasFromAppLabel = labels.some((label) => label.name === 'from-app');
  if (!hasFromAppLabel) {
    return jsonResponse({
      ignored: true,
      reason: 'Issue does not have from-app label',
    });
  }

  // SDK-BF.3 AC4: /legacy command — always dispatch to legacy auto-fix.yml pipeline
  if (isLegacy) {
    return await dispatchAutoFix(env, issueNumber, githubHeaders, ctx);
  }

  if (isApprove) {
    return await handleApprove(env, issueNumber, githubHeaders, ctx, labels);
  } else {
    // /reject on an issue → routes to SDK pipeline or legacy reject based on labels
    return await handleReject(env, issueNumber, githubHeaders, labels, commentBody, ctx);
  }
}

// Extract rejection reason from a /reject comment
// Supports: /reject reason: X, /reject X, /reject (plain)
function extractRejectionReason(commentBody: string): string {
  const reasonMatch = commentBody.match(/\/reject\s+reason:\s*(.+)/i);
  if (reasonMatch) {
    return reasonMatch[1].trim();
  }
  const plainMatch = commentBody.match(/\/reject\s+(.+)/i);
  if (plainMatch) {
    return plainMatch[1].trim();
  }
  return 'No reason provided';
}

// Extract game content category from issue labels
// Labels follow format: category/us-history → "US History"
// Returns "unknown" if no category label found
function extractCategoryFromLabels(labels: GitHubLabel[]): string {
  const categoryLabel = labels.find(l => l.name.startsWith('category/'));
  if (!categoryLabel) {
    return 'unknown';
  }
  // Convert "category/us-history" → "US History"
  // Known acronyms must stay uppercase (US, TV, UK, etc.)
  const ACRONYMS = new Set(['us', 'tv', 'uk', 'eu', 'ww', 'hp']);
  const slug = categoryLabel.name.replace('category/', '');
  return slug
    .split('-')
    .map(word => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Check if an issue has been through the content verify step
// Evidence: labels 'awaiting-approval' or 'content-verified' indicate a prior verify run
function hasBeenThroughVerify(labels: GitHubLabel[]): boolean {
  return labels.some(l => l.name === 'awaiting-approval' || l.name === 'content-verified');
}

// Dispatch sdk-resume event to public bugs repo (shared by approve and reject on SDK issues)
async function dispatchSDKResume(
  env: Env,
  issueNumber: number,
  action: 'approve' | 'reject',
  labels: GitHubLabel[],
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext,
  rejectionReason?: string
): Promise<Response> {
  if (!env.BUGS_REPO_PAT || !env.BUGS_REPO) {
    console.error('BUGS_REPO_PAT or BUGS_REPO not configured - cannot dispatch sdk dispatch');
    return jsonResponse({ error: 'Public repo dispatch not configured' }, 500);
  }

  const labelNames = labels.map(l => l.name);

  try {
    const isTranslation = labels.some(l => l.name === 'translation-error');
    const priorVerifyExists = hasBeenThroughVerify(labels);

    // Determine the correct dispatch event:
    // - Translation issues always use sdk-translation-resume
    // - Content issues WITH a prior verify run → sdk-content-resume (existing path)
    // - Content issues WITHOUT a prior verify run (manual relabel) → sdk-content-verify (fresh start)
    let eventType: string;
    if (isTranslation) {
      eventType = 'sdk-translation-resume';
    } else if (action === 'approve' && !priorVerifyExists) {
      // Manual relabel path: issue was labeled content-error by human but never
      // went through the verify step. Dispatch a fresh verify, not a resume.
      eventType = 'sdk-content-verify';
    } else {
      eventType = 'sdk-content-resume';
    }

    // For fresh verify dispatches, extract the category from labels so the
    // pipeline knows which content file to check
    const category = extractCategoryFromLabels(labels);

    const clientPayload: Record<string, unknown> = {
      issue_number: issueNumber,
      action: action,
      labels: labelNames,
    };

    // Include category for fresh verify dispatches (pipeline needs it)
    if (eventType === 'sdk-content-verify') {
      clientPayload.category = category;
    }

    // Include rejection reason when rejecting
    if (rejectionReason) {
      clientPayload.rejection_reason = rejectionReason;
    }

    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${env.BUGS_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: eventType,
          client_payload: clientPayload,
        }),
      }
    );

    if (dispatchResponse.ok || dispatchResponse.status === 204) {
      console.log(
        `Dispatched ${eventType} (${action}) for issue #${issueNumber} to ${env.BUGS_REPO}`
      );

      // Post action-specific confirmation comment on the issue
      let comment: string;
      if (action === 'approve' && eventType === 'sdk-content-verify') {
        comment = `SDK content verification started (fresh) for issue #${issueNumber}. Category: ${category}. The pipeline will verify and fix the content.`;
      } else if (action === 'approve') {
        comment = `SDK content verification resume triggered for issue #${issueNumber}. The pipeline will process your approval.`;
      } else {
        comment = `SDK pipeline rejection recorded for issue #${issueNumber}. Reason: ${rejectionReason || 'No reason provided'}. The pipeline will process your feedback.`;
      }

      ctx.waitUntil(
        fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({ body: comment }),
          }
        ).catch((err) => console.error(`Error posting sdk-resume ${action} comment:`, err))
      );

      return jsonResponse({
        success: true,
        action: `sdk-${action}`,
        issue_number: issueNumber,
        message: `SDK ${action} dispatched to public repo`,
      });
    } else {
      const errorText = await dispatchResponse.text();
      console.error(`SDK ${eventType} dispatch failed: ${dispatchResponse.status} ${errorText}`);
      return jsonResponse(
        { error: `Failed to dispatch ${eventType} event`, status: dispatchResponse.status },
        502
      );
    }
  } catch (error) {
    console.error('Error dispatching sdk dispatch:', error);
    return jsonResponse({ error: 'Internal error dispatching sdk dispatch' }, 500);
  }
}

// Handle /approve command
async function handleApprove(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext,
  labels: GitHubLabel[]
): Promise<Response> {
  // 1. Add 'approved' label to the issue
  try {
    const labelResponse = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({ labels: ['approved'] }),
      }
    );
    if (!labelResponse.ok) {
      console.error(
        `Failed to add approved label: ${labelResponse.status} ${await labelResponse.text()}`
      );
    }
  } catch (error) {
    console.error('Error adding approved label:', error);
  }

  // Story 1.6: Record training verdict (fire-and-forget via waitUntil)
  ctx.waitUntil(dispatchTrainingVerdict(env, issueNumber, 'approved'));

  // 2. Route based on issue labels: SDK content/translation pipeline
  if (isSDKContentPipelineIssue(labels)) {
    return await dispatchSDKResume(env, issueNumber, 'approve', labels, githubHeaders, ctx);
  }

  // 3. SDK-BF.3 AC3: Code/UX bugs → dispatch sdk-bug-fix (new SDK pipeline)
  if (isSDKBugFixIssue(labels)) {
    return await dispatchSDKBugFix(env, issueNumber, githubHeaders, ctx, labels);
  }

  // 4. Fallback: Dispatch sdk-bug-fix for any remaining from-app issues
  // This covers bugs that went through triage but may not have ui-bug/gameplay-bug labels yet
  return await dispatchSDKBugFix(env, issueNumber, githubHeaders, ctx, labels);
}

// Dispatch approve event to the auto-fix pipeline (legacy code path for non-SDK issues)
async function dispatchAutoFix(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  if (!env.BUGS_REPO_PAT || !env.BUGS_REPO) {
    console.error('BUGS_REPO_PAT or BUGS_REPO not configured - cannot dispatch approve');
    return jsonResponse({ error: 'Public repo dispatch not configured' }, 500);
  }

  try {
    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${env.BUGS_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'approve',
          client_payload: {
            issue_number: issueNumber,
            action: 'approve',
          },
        }),
      }
    );

    if (dispatchResponse.ok || dispatchResponse.status === 204) {
      console.log(
        `Dispatched approve for issue #${issueNumber} to ${env.BUGS_REPO}`
      );

      // Post confirmation comment on the issue
      const approveComment = [
        `Fix generation started for issue #${issueNumber}.`,
        '',
        '**What happens next:**',
        '1. The pipeline will analyze the bug and generate a code fix (~5-10 minutes)',
        '2. A pull request will be created on the Sorting-History repo',
        '3. A comment with the PR link will appear on this issue',
        '',
        "You'll be notified here when the PR is ready for review.",
      ].join('\n');

      ctx.waitUntil(
        fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({
              body: approveComment,
            }),
          }
        ).catch((err) => console.error('Error posting approve comment:', err))
      );

      return jsonResponse({
        success: true,
        action: 'approve',
        issue_number: issueNumber,
        message: 'Approve dispatched to public repo',
      });
    } else {
      const errorText = await dispatchResponse.text();
      console.error(`Approve dispatch failed: ${dispatchResponse.status} ${errorText}`);
      return jsonResponse(
        { error: 'Failed to dispatch approve event', status: dispatchResponse.status },
        502
      );
    }
  } catch (error) {
    console.error('Error dispatching approve:', error);
    return jsonResponse({ error: 'Internal error dispatching approve' }, 500);
  }
}

// SDK-BF.3 AC3: Dispatch sdk-bug-fix event to public bugs repo for code/UX bug fixes
async function dispatchSDKBugFix(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext,
  labels: GitHubLabel[]
): Promise<Response> {
  if (!env.BUGS_REPO_PAT || !env.BUGS_REPO) {
    console.error('BUGS_REPO_PAT or BUGS_REPO not configured - cannot dispatch sdk-bug-fix');
    return jsonResponse({ error: 'Public repo dispatch not configured' }, 500);
  }

  const labelNames = labels.map(l => l.name);

  try {
    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${env.BUGS_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'sdk-bug-fix',
          client_payload: {
            issue_number: issueNumber,
            action: 'approve',
            labels: labelNames,
          },
        }),
      }
    );

    if (dispatchResponse.ok || dispatchResponse.status === 204) {
      console.log(
        `Dispatched sdk-bug-fix for issue #${issueNumber} to ${env.BUGS_REPO}`
      );

      // Post confirmation comment on the issue
      const approveComment = [
        `SDK bug fix pipeline started for issue #${issueNumber}.`,
        '',
        '**What happens next:**',
        '1. The SDK pipeline will analyze the bug and generate a code fix (~5-10 minutes)',
        '2. A pull request will be created on the Sorting-History repo',
        '3. A comment with the PR link will appear on this issue',
        '',
        "You'll be notified here when the PR is ready for review.",
      ].join('\n');

      ctx.waitUntil(
        fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({
              body: approveComment,
            }),
          }
        ).catch((err) => console.error('Error posting sdk-bug-fix comment:', err))
      );

      return jsonResponse({
        success: true,
        action: 'sdk-bug-fix',
        issue_number: issueNumber,
        message: 'SDK bug fix dispatched to public repo',
      });
    } else {
      const errorText = await dispatchResponse.text();
      console.error(`SDK bug fix dispatch failed: ${dispatchResponse.status} ${errorText}`);
      return jsonResponse(
        { error: 'Failed to dispatch sdk-bug-fix event', status: dispatchResponse.status },
        502
      );
    }
  } catch (error) {
    console.error('Error dispatching sdk-bug-fix:', error);
    return jsonResponse({ error: 'Internal error dispatching sdk-bug-fix' }, 500);
  }
}

// Handle /reject on a PR → dispatch fix-rejection to public repo
async function handleFixRejection(
  env: Env,
  prNumber: number,
  commentBody: string,
  githubHeaders: Record<string, string>,
  ctx: ExecutionContext
): Promise<Response> {
  // Extract rejection reason from comment
  // Supports: /reject reason: X, /reject X, /reject
  let rejectionReason = 'No reason provided';
  const reasonMatch = commentBody.match(/\/reject\s+reason:\s*(.+)/i);
  if (reasonMatch) {
    rejectionReason = reasonMatch[1].trim();
  } else {
    const plainMatch = commentBody.match(/\/reject\s+(.+)/i);
    if (plainMatch) {
      rejectionReason = plainMatch[1].trim();
    }
  }

  // Dispatch reject-fix event to public repo
  if (!env.BUGS_REPO_PAT || !env.BUGS_REPO) {
    console.error('BUGS_REPO_PAT or BUGS_REPO not configured - cannot dispatch reject-fix');
    return jsonResponse({ error: 'Public repo dispatch not configured' }, 500);
  }

  try {
    const dispatchResponse = await fetch(
      `https://api.github.com/repos/${env.BUGS_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          event_type: 'reject-fix',
          client_payload: {
            pr_number: prNumber,
            rejection_reason: rejectionReason,
          },
        }),
      }
    );

    if (dispatchResponse.ok || dispatchResponse.status === 204) {
      console.log(
        `Dispatched reject-fix for PR #${prNumber} to ${env.BUGS_REPO}`
      );

      // Post acknowledgment comment on the PR
      const rejectComment = [
        `Rejection recorded for PR #${prNumber}.`,
        '',
        `**Reason:** ${rejectionReason}`,
        '',
        '**What happens next:**',
        '- If this was attempt 1-2: A retry with a different approach will start automatically. New PR in ~10 minutes.',
        '- If this was the final attempt: The issue will be labeled `needs-manual-fix` for manual investigation.',
      ].join('\n');

      ctx.waitUntil(
        fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${prNumber}/comments`,
          {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({
              body: rejectComment,
            }),
          }
        ).catch((err) => console.error('Error posting reject-fix comment:', err))
      );

      return jsonResponse({
        success: true,
        action: 'reject-fix',
        pr_number: prNumber,
        rejection_reason: rejectionReason,
        message: 'Fix rejection dispatched to public repo',
      });
    } else {
      const errorText = await dispatchResponse.text();
      console.error(`Reject-fix dispatch failed: ${dispatchResponse.status} ${errorText}`);
      return jsonResponse(
        { error: 'Failed to dispatch reject-fix event', status: dispatchResponse.status },
        502
      );
    }
  } catch (error) {
    console.error('Error dispatching reject-fix:', error);
    return jsonResponse({ error: 'Internal error dispatching reject-fix' }, 500);
  }
}

// Handle /reject command on an issue
async function handleReject(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>,
  labels: GitHubLabel[],
  commentBody: string,
  ctx: ExecutionContext
): Promise<Response> {
  // Story 1.6: Record training verdict (fire-and-forget via waitUntil)
  ctx.waitUntil(dispatchTrainingVerdict(env, issueNumber, 'rejected'));

  // Route based on issue labels: SDK content/translation pipeline
  if (isSDKContentPipelineIssue(labels)) {
    // SDK content issues: dispatch to sdk-resume with action=reject
    // Do NOT close issue, do NOT add 'rejected' label — the SDK pipeline decides
    const rejectionReason = extractRejectionReason(commentBody);
    return await dispatchSDKResume(env, issueNumber, 'reject', labels, githubHeaders, ctx, rejectionReason);
  }

  // SDK-BF.3: Code/UX bug issues — reject handled by legacy close for now
  // (SDK bug fix pipeline doesn't have a reject-resume path yet)

  // Legacy path: add rejected label, comment, close issue
  return await handleRejectLegacy(env, issueNumber, githubHeaders);
}

// Legacy /reject behavior for non-SDK issues: label + comment + close
async function handleRejectLegacy(
  env: Env,
  issueNumber: number,
  githubHeaders: Record<string, string>
): Promise<Response> {
  // 1. Add 'rejected' label to the issue
  try {
    await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({ labels: ['rejected'] }),
      }
    );
  } catch (error) {
    console.error('Error adding rejected label:', error);
  }

  // 2. Post a comment explaining the rejection
  try {
    await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: githubHeaders,
        body: JSON.stringify({ body: 'Issue rejected. Closing.' }),
      }
    );
  } catch (error) {
    console.error('Error posting reject comment:', error);
  }

  // 3. Close the issue
  try {
    const closeResponse = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`,
      {
        method: 'PATCH',
        headers: githubHeaders,
        body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
      }
    );

    if (!closeResponse.ok) {
      console.error(
        `Failed to close issue: ${closeResponse.status} ${await closeResponse.text()}`
      );
      return jsonResponse(
        { error: 'Failed to close issue', status: closeResponse.status },
        502
      );
    }
  } catch (error) {
    console.error('Error closing issue:', error);
    return jsonResponse({ error: 'Internal error closing issue' }, 500);
  }

  console.log(`Rejected and closed issue #${issueNumber}`);
  return jsonResponse({
    success: true,
    action: 'reject',
    issue_number: issueNumber,
    message: 'Issue rejected and closed',
  });
}

// ============================================================================
// ============================================================================
// Handoff Download — serves Pipeline Handoff comment as downloadable .md
// ============================================================================

async function handleHandoffDownload(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const issueNumber = url.searchParams.get('issue');
  const token = url.searchParams.get('token');

  if (!token || token !== env.AUTH_TOKEN) {
    return new Response(pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true), {
      status: 401, headers: { 'Content-Type': 'text/html' },
    });
  }

  // Validate issue number to prevent XSS
  const issueNum = parseInt(issueNumber || '', 10);
  if (!issueNumber || isNaN(issueNum)) {
    return new Response(pipelinePageHtml('Invalid Request', 'Missing or invalid issue number.', true), {
      status: 400, headers: { 'Content-Type': 'text/html' },
    });
  }
  if (!issueNumber) {
    return new Response(pipelinePageHtml('Error', 'Missing issue parameter.', true), {
      status: 400, headers: { 'Content-Type': 'text/html' },
    });
  }

  const githubHeaders = {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'SortingHistory-Pipeline',
  };

  // Fetch issue details to check state for auto-close
  const issueResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
    headers: githubHeaders,
  });
  if (!issueResp.ok) {
    return new Response(pipelinePageHtml('Error', `Issue #${issueNumber} not found.`, true), {
      status: 404, headers: { 'Content-Type': 'text/html' },
    });
  }
  const issue = await issueResp.json() as { title: string; body: string; state: string };

  // Auto-close the issue (fire-and-forget via waitUntil)
  // The confirmation page = acknowledgment. Issue leaves the digest and stops emailing.
  if (issue.state === 'open') {
    ctx.waitUntil((async () => {
      try {
        // ROBUST-B AC3: Add needs-dev-handoff label for tracking
        await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`,
          {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({ labels: ['needs-dev-handoff'] }),
          }
        ).catch((labelErr) => console.error(`Failed to add needs-dev-handoff label: ${labelErr}`));

        // Post a comment explaining the auto-close
        await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: githubHeaders,
            body: JSON.stringify({
              body: '**Handoff downloaded.** Issue auto-closed — fix ownership transferred to Claude Code CLI.\n\nReopen this issue if the fix is not completed.',
            }),
          }
        );

        // Close the issue
        const closeResp = await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`,
          {
            method: 'PATCH',
            headers: githubHeaders,
            body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
          }
        );

        if (!closeResp.ok) {
          console.error(`Failed to auto-close issue #${issueNumber}: ${closeResp.status}`);
        } else {
          console.log(`Auto-closed issue #${issueNumber} after handoff download`);
        }
      } catch (error) {
        console.error(`Error auto-closing issue #${issueNumber}:`, error);
      }
    })());
  }

  // Build the download link for the actual file
  const downloadUrl = `${url.origin}/api/pipeline/handoff-file?issue=${encodeURIComponent(issueNumber)}&token=${encodeURIComponent(token)}`;

  // Return an HTML confirmation page with a download button
  const color = '#8B6914';
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Handoff Ready - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{width:80px;height:80px;border-radius:18px;margin:0 auto 20px}
  h1{color:${color};margin:0 0 16px;font-size:24px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px}
  .download-btn{display:inline-block;background:#27ae60;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;margin-top:20px;transition:opacity .2s}
  .download-btn:hover{opacity:.85}
  .next-steps{background:#1a1a2e;border-radius:8px;padding:14px 18px;margin-top:16px;font-size:14px;color:#999;line-height:1.5;text-align:left}
  .next-steps strong{color:#b0b0b0}
  .badge{display:inline-block;background:${color};color:#fff;padding:6px 16px;border-radius:20px;font-weight:600;margin-top:12px}
</style></head><body>
<div class="card">
  <img class="icon" src="https://sortinghistory.com/images/app-icon.png" alt="Sorting History">
  <h1>Handoff Ready</h1>
  <p>Issue #${issueNumber} has been closed. The handoff file is ready for download.</p>
  <a class="download-btn" href="${downloadUrl}" download="bug-${issueNumber}-handoff.md">Download Handoff</a>
  <div class="copy-section" style="margin-top:16px;">
    <button onclick="copyUrl()" style="background:#2563eb;color:#fff;border:none;padding:10px 20px;border-radius:8px;font-size:14px;cursor:pointer;">Copy Download Link</button>
    <span id="copy-status" style="display:none;color:#27ae60;margin-left:8px;font-size:14px;">Copied!</span>
  </div>
  <div class="next-steps"><strong>Next steps:</strong> Open the downloaded file in Claude Code to start fixing this issue. If the download button doesn't work on mobile, use "Copy Download Link" and paste it in a desktop browser.</div>
  <div class="badge">Sorting History Pipeline</div>
</div>
<script>
function copyUrl() {
  const url = "${downloadUrl}";
  navigator.clipboard.writeText(url).then(() => {
    document.getElementById('copy-status').style.display = 'inline';
    setTimeout(() => document.getElementById('copy-status').style.display = 'none', 2000);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    document.getElementById('copy-status').style.display = 'inline';
  });
}
</script>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

// Serves the actual handoff markdown file as a download (Content-Disposition: attachment)
async function handleHandoffFileDownload(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const issueNumber = url.searchParams.get('issue');
  const token = url.searchParams.get('token');

  if (!token || token !== env.AUTH_TOKEN) {
    return new Response(pipelinePageHtml('Unauthorized', 'Invalid or expired token.', true), {
      status: 401, headers: { 'Content-Type': 'text/html' },
    });
  }
  // Validate issue number to prevent XSS
  const issueNum = parseInt(issueNumber || '', 10);
  if (!issueNumber || isNaN(issueNum)) {
    return new Response(pipelinePageHtml('Error', 'Missing or invalid issue number.', true), {
      status: 400, headers: { 'Content-Type': 'text/html' },
    });
  }

  const githubHeaders = {
    'Authorization': `token ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'SortingHistory-Pipeline',
  };

  // Fetch issue details
  const issueResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}`, {
    headers: githubHeaders,
  });
  if (!issueResp.ok) {
    return new Response(pipelinePageHtml('Error', `Issue #${issueNumber} not found.`, true), {
      status: 404, headers: { 'Content-Type': 'text/html' },
    });
  }
  const issue = await issueResp.json() as { title: string; body: string; state: string };

  // Fetch all comments
  const commentsResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments?per_page=100`, {
    headers: githubHeaders,
  });
  const comments = await commentsResp.json() as { body: string }[];

  // Find Pipeline Handoff comment
  const handoffComment = comments.find((c: { body: string }) => c.body.includes('# Pipeline Handoff:'));
  // Find owner reclassification
  const reclassComment = comments.find((c: { body: string }) => c.body.includes('## Owner Reclassification'));
  // Find AI analysis
  const analysisComment = comments.find((c: { body: string }) =>
    c.body.includes('## AI Bug Analysis') || c.body.includes('## Triage Classification')
  );

  // PIPE-010: Fetch closed PRs for this issue to include previous fix attempt context
  const prsResp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/pulls?state=closed&per_page=50`,
    { headers: githubHeaders }
  );
  const allPRs = prsResp.ok ? await prsResp.json() as Array<{
    number: number; title: string; state: string; body: string;
    html_url: string; head: { ref: string }; merged_at: string | null;
    created_at: string; closed_at: string;
  }> : [];

  // Filter to PRs for this issue (branch ends with bug-{N})
  const issuePRs = allPRs
    .filter(pr => new RegExp(`bug-${issueNum}$`).test(pr.head.ref))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // For each closed (not merged) PR, fetch rejection comments
  const prRejections: Map<number, string> = new Map();
  for (const pr of issuePRs) {
    if (!pr.merged_at) {
      try {
        const prCommentsResp = await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${pr.number}/comments?per_page=50`,
          { headers: githubHeaders }
        );
        if (prCommentsResp.ok) {
          const prComments = await prCommentsResp.json() as Array<{ body: string }>;
          const rejectionComment = prComments.find(c => c.body.includes('## Fix Rejected'));
          if (rejectionComment) {
            prRejections.set(pr.number, rejectionComment.body);
          }
        }
      } catch { /* non-fatal — PR still shows, just without rejection details */ }
    }
  }

  // Build the handoff markdown
  let md = `# Bug #${issueNumber} — Handoff for Claude Code\n\n`;
  md += `## Original Bug Report\n\n${issue.body}\n\n`;

  if (reclassComment) {
    md += `---\n\n${reclassComment.body}\n\n`;
  }
  if (analysisComment) {
    md += `---\n\n${analysisComment.body}\n\n`;
  }
  if (handoffComment) {
    md += `---\n\n${handoffComment.body}\n\n`;
  }

  // PIPE-010: Include previous fix attempts from closed PRs
  if (issuePRs.length > 0) {
    md += `---\n\n## Previous Fix Attempts\n\n`;
    for (let i = 0; i < issuePRs.length; i++) {
      const pr = issuePRs[i];
      const status = pr.merged_at ? 'Merged' : 'Closed (rejected/failed)';
      md += `### Attempt ${i + 1}: PR #${pr.number} — ${status}\n\n`;
      md += `**Branch:** \`${pr.head.ref}\`\n`;
      md += `**Link:** ${pr.html_url}\n\n`;
      if (pr.body) {
        md += `${pr.body}\n\n`;
      }
      const rejection = prRejections.get(pr.number);
      if (rejection) {
        md += `**Rejection Details:**\n\n${rejection}\n\n`;
      }
    }
  }

  if (!handoffComment && !analysisComment && issuePRs.length === 0) {
    md += `---\n\nNo pipeline analysis or handoff found for this issue.\n`;
  }

  const filename = `bug-${issueNumber}-handoff.md`;

  // Encode the markdown as a data URI for auto-download
  const base64Md = btoa(unescape(encodeURIComponent(md)));
  const dataUri = `data:text/markdown;charset=utf-8;base64,${base64Md}`;

  // Build summary for confirmation page
  const prSummary = issuePRs.length > 0
    ? issuePRs.map((pr, i) => `<li>Attempt ${i + 1}: <a href="${pr.html_url}" style="color:#8B6914">PR #${pr.number}</a> — ${pr.merged_at ? 'Merged' : 'Closed'}</li>`).join('')
    : '';

  const color = '#8B6914';
  const confirmHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Issue #${issueNumber} Closed - Sorting History</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
  .card{background:#16213e;border-radius:16px;padding:40px;max-width:520px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.3)}
  .icon{font-size:48px;margin-bottom:16px}
  h1{color:#27ae60;margin:0 0 16px;font-size:24px}
  h2{color:${color};margin:20px 0 12px;font-size:18px}
  p{line-height:1.6;color:#b0b0b0;font-size:16px}
  .status-item{background:#1a1a2e;border-radius:8px;padding:12px 16px;margin:8px 0;text-align:left;font-size:14px;color:#b0b0b0}
  .status-item .label{color:#999;display:inline-block;width:100px}
  .status-item .value{color:#e0e0e0}
  .check{color:#27ae60;margin-right:6px}
  ul{text-align:left;margin:8px 0;padding-left:20px;color:#b0b0b0;font-size:14px}
  li{margin:4px 0}
  a{color:${color}}
  .badge{display:inline-block;background:${color};color:#fff;padding:6px 16px;border-radius:20px;font-weight:600;margin-top:16px}
</style></head><body>
<div class="card">
  <div class="icon">&#9989;</div>
  <h1>Handoff Complete</h1>
  <p>Issue #${issueNumber} has been closed and the handoff file has been downloaded.</p>

  <div class="status-item"><span class="check">&#10003;</span> Issue #${issueNumber} closed on GitHub</div>
  <div class="status-item"><span class="check">&#10003;</span> Handoff file downloaded: <strong>${filename}</strong></div>
  ${prSummary ? `<h2>Previous Fix Attempts</h2><ul>${prSummary}</ul>` : ''}

  <p style="font-size:14px;color:#999;margin-top:16px;">Open the downloaded file in Claude Code to start fixing this issue.</p>
  <div class="badge">Sorting History Pipeline</div>
</div>
<script>
// Auto-download the handoff file
const a = document.createElement('a');
a.href = "${dataUri}";
a.download = "${filename}";
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
</script>
</body></html>`;

  return new Response(confirmHtml, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// PIPE-008: Duplicate Detection Helpers
// ============================================================================

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeBugFingerprint(report: BugReport): Promise<string> {
  const screen = (report.deviceInfo?.currentScreen || 'unknown').toLowerCase().trim();
  const desc = report.description
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // strip punctuation
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim()
    .substring(0, 100);
  const raw = `${screen}|${desc}`;
  return sha256Hex(raw);
}

async function checkForDuplicate(
  env: Env,
  report: BugReport
): Promise<DedupResult> {
  try {
    const fingerprint = await computeBugFingerprint(report);
    const kvKey = `dedup:${fingerprint}`;
    const existing = await env.PIPELINE_KV.get(kvKey, 'json') as DedupEntry | null;

    if (existing) {
      // Increment report count and refresh TTL
      const updatedEntry: DedupEntry = {
        ...existing,
        reportCount: existing.reportCount + 1,
      };
      await env.PIPELINE_KV.put(kvKey, JSON.stringify(updatedEntry), {
        expirationTtl: DEDUP_WINDOW_SECONDS,
      });

      console.log(
        `[DEDUP] Duplicate detected — fingerprint=${fingerprint} original_issue=${existing.issueNumber} report_count=${updatedEntry.reportCount}`
      );

      return {
        isDuplicate: true,
        originalIssueNumber: existing.issueNumber,
        originalIssueUrl: existing.issueUrl,
        reportCount: updatedEntry.reportCount,
      };
    }

    // No match — caller will store the entry after creating the issue
    return { isDuplicate: false };
  } catch (err) {
    // Failsafe: if KV fails, proceed as non-duplicate
    console.error('[DEDUP] KV lookup failed, proceeding as new report:', err);
    return { isDuplicate: false };
  }
}

async function storeDedupEntry(
  env: Env,
  report: BugReport,
  issueNumber: number,
  issueUrl: string
): Promise<void> {
  try {
    const fingerprint = await computeBugFingerprint(report);
    const kvKey = `dedup:${fingerprint}`;
    const entry: DedupEntry = {
      issueNumber,
      issueUrl,
      createdAt: new Date().toISOString(),
      reportCount: 1,
      fingerprint,
    };
    await env.PIPELINE_KV.put(kvKey, JSON.stringify(entry), {
      expirationTtl: DEDUP_WINDOW_SECONDS,
    });
    console.log(`[DEDUP] Stored fingerprint=${fingerprint} for issue #${issueNumber}`);
  } catch (err) {
    console.error('[DEDUP] Failed to store dedup entry:', err);
  }
}

async function commentOnOriginalIssue(
  env: Env,
  issueNumber: number,
  reportCount: number,
  confirmationId: string,
  email?: string
): Promise<boolean> {
  const reporter = email ? `${email.substring(0, 3)}***@${email.split('@')[1] || '...'}` : 'anonymous';
  const body = `**Duplicate report received** (total: ${reportCount} reporters)\n\nReporter: ${reporter}\nConfirmation ID: \`${confirmationId}\``;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body }),
      }
    );
    if (resp.status === 404 || resp.status === 410) {
      console.warn(`[DEDUP] Original issue #${issueNumber} not found (${resp.status}), will fall back to new issue`);
      return false;
    }
    return resp.ok;
  } catch (err) {
    console.error(`[DEDUP] Failed to comment on issue #${issueNumber}:`, err);
    return false;
  }
}

async function upsertDuplicateTracker(
  env: Env,
  issueNumber: number,
  reportCount: number
): Promise<void> {
  const marker = `<!-- report_count:${reportCount} -->`;
  const trackerBody = `**Duplicate Tracker** ${marker}\n\nThis issue has been reported by ${reportCount} users.`;

  try {
    // List comments to find existing tracker
    const listResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments?per_page=100`,
      {
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!listResp.ok) {
      console.error(`[DEDUP] Failed to list comments for issue #${issueNumber}: ${listResp.status}`);
      return;
    }

    const comments = await listResp.json() as Array<{ id: number; body?: string }>;
    const trackerComment = comments.find(c => c.body?.includes('<!-- report_count:'));

    if (trackerComment) {
      // PATCH existing tracker comment
      await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/issues/comments/${trackerComment.id}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'SortingHistory-BugWebhook/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ body: trackerBody }),
        }
      );
    } else {
      // POST new tracker comment
      await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'SortingHistory-BugWebhook/1.0',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ body: trackerBody }),
        }
      );
    }
  } catch (err) {
    console.error(`[DEDUP] Failed to upsert duplicate tracker for issue #${issueNumber}:`, err);
  }
}

async function addDuplicateLabel(
  env: Env,
  issueNumber: number
): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'SortingHistory-BugWebhook/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ labels: ['duplicate-report'] }),
      }
    );
  } catch (err) {
    console.error(`[DEDUP] Failed to add duplicate-report label to issue #${issueNumber}:`, err);
  }
}

async function clearDedupEntry(
  env: Env,
  report: BugReport
): Promise<void> {
  try {
    const fingerprint = await computeBugFingerprint(report);
    await env.PIPELINE_KV.delete(`dedup:${fingerprint}`);
  } catch {
    // Best-effort cleanup
  }
}

// Story 5.2: Health check endpoint handler
// ============================================================================

interface DigestHealthData {
  last_success?: string;
  last_failure?: string;
  status: 'ok' | 'error' | 'unknown';
  error_message?: string;
}

async function handleHealthCheck(env: Env): Promise<Response> {
  const now = new Date();
  let digestHealth: DigestHealthData = { status: 'unknown' };
  let stale = true;

  try {
    const raw = await env.PIPELINE_KV.get('health:digest');
    if (raw) {
      digestHealth = JSON.parse(raw) as DigestHealthData;
    }
  } catch {
    // KV read failed — report as unknown
  }

  // Determine staleness: stale if last_success is >24h ago or missing
  if (digestHealth.last_success) {
    const lastSuccess = new Date(digestHealth.last_success);
    const hoursSince = (now.getTime() - lastSuccess.getTime()) / (1000 * 60 * 60);
    stale = hoursSince > 24;
  }

  const body = {
    digest: {
      last_success: digestHealth.last_success || null,
      last_failure: digestHealth.last_failure || null,
      status: digestHealth.status,
      stale,
    },
    worker_version: '5.2',
    timestamp: now.toISOString(),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Story 5.2: Alert email on digest dispatch failure
async function sendDigestFailureAlert(env: Env, errorMsg: string, triggeredAt: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.OWNER_EMAIL) {
    console.error('Cannot send digest failure alert: RESEND_API_KEY or OWNER_EMAIL not configured');
    return;
  }

  const result = await sendOwnerEmail(env, {
    from: 'Sorting History Pipeline <hello@sortinghistory.com>',
    to: env.OWNER_EMAIL,
    subject: 'ALERT: Digest dispatch failed',
    html: `
          <h2 style="color:#cb2431;">Digest Dispatch Failed</h2>
          <p><strong>Time:</strong> ${triggeredAt}</p>
          <p><strong>Error:</strong></p>
          <pre style="background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto;">${errorMsg}</pre>
          <p style="margin-top:16px;">Check the <a href="https://sortinghistory.com/api/pipeline/health">health endpoint</a> for current status.</p>
          <hr style="margin-top:24px;border:none;border-top:1px solid #e1e4e8;">
          <p style="color:#6a737d;font-size:12px;">Sorting History Pipeline Monitor</p>
        `,
  });

  if (result.ok) {
    console.log('Digest failure alert email sent');
  } else {
    console.error(`Digest failure alert email failed: ${result.error}`);
  }
}

// Main Router
// ============================================================================

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // BBE-002: route the weekly-digest cron (0 9 * * 1) to the BBE digest
    // runner instead of the pipeline digest dispatch. Other crons fall
    // through to the pipeline digest dispatch below.
    const cronExpr = (event as { cron?: string }).cron || '';
    if (cronExpr === '0 9 * * 1') {
      const env2 = bbeEnv(env);
      if (env2) {
        try {
          await bbeInitSchemaAndImport(env2);
          await bbeRunWeeklyDigest(env2);
          console.log('BBE weekly digest dispatched');
        } catch (err) {
          console.error('BBE weekly digest failed:', err);
        }
      } else {
        console.log('BBE weekly digest skipped: BBE_DB not bound');
      }
      return;
    }

    // BBE-002: piggy-back BBE inventory + expiration alert on the morning
    // pipeline-digest cron. Best-effort; never blocks the main dispatch.
    if (cronExpr === '0 10 * * *') {
      const env2 = bbeEnv(env);
      if (env2) {
        ctx.waitUntil((async () => {
          try {
            await bbeInitSchemaAndImport(env2);
            await bbeRunInventoryAlertCheck(env2);
          } catch (err) {
            console.error('BBE inventory alert check failed:', err);
          }
        })());
      }
    }

    // Dispatch the Pipeline Digest via repository_dispatch (not workflow_dispatch)
    // BUGS_REPO_PAT has contents:write which covers repository_dispatch
    // but NOT actions:write which workflow_dispatch requires
    const triggeredAt = new Date(event.scheduledTime).toISOString();

    try {
      const response = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${env.BUGS_REPO_PAT}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'SortingHistory-Pipeline-Cron',
        },
        body: JSON.stringify({
          event_type: 'digest-cron',
          client_payload: { triggered_at: triggeredAt },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        const errorMsg = `Digest dispatch HTTP ${response.status}: ${body}`;
        console.error(`Failed to dispatch digest: ${errorMsg}`);

        // Write failure to KV
        const existing = await env.PIPELINE_KV.get('health:digest');
        const prev: DigestHealthData = existing ? JSON.parse(existing) : { status: 'unknown' };
        await env.PIPELINE_KV.put('health:digest', JSON.stringify({
          ...prev,
          last_failure: triggeredAt,
          status: 'error',
          error_message: errorMsg,
        } satisfies DigestHealthData));

        // Send alert email via Resend
        await sendDigestFailureAlert(env, errorMsg, triggeredAt);
      } else {
        console.log(`Digest dispatched at ${triggeredAt}`);

        // Write success to KV
        await env.PIPELINE_KV.put('health:digest', JSON.stringify({
          last_success: triggeredAt,
          status: 'ok',
        } satisfies DigestHealthData));
      }
    } catch (err) {
      const errorMsg = `Digest dispatch exception: ${err instanceof Error ? err.message : String(err)}`;
      console.error(errorMsg);

      // Write failure to KV (best-effort)
      try {
        const existing = await env.PIPELINE_KV.get('health:digest');
        const prev: DigestHealthData = existing ? JSON.parse(existing) : { status: 'unknown' };
        await env.PIPELINE_KV.put('health:digest', JSON.stringify({
          ...prev,
          last_failure: new Date().toISOString(),
          status: 'error',
          error_message: errorMsg,
        } satisfies DigestHealthData));
      } catch {
        // KV write failed — nothing we can do
      }

      // Send alert email (best-effort)
      try {
        await sendDigestFailureAlert(env, errorMsg, triggeredAt);
      } catch {
        console.error('Failed to send digest failure alert email');
      }
    }
  },

  // FR-160: Send thank-you email to bug reporters via Resend
  async sendThankYouEmail(env: Env, email: string, gameLanguage: string | undefined, locale: string | undefined, issueNumber: number, confirmationId?: string): Promise<void> {
    if (!env.RESEND_API_KEY || !email) return;

    // Prefer in-game language over device locale for email language
    const lang = (gameLanguage || locale || 'en').toLowerCase();
    const isDE = lang.startsWith('de');
    const isPT = lang.startsWith('pt');
    const isNL = lang.startsWith('nl');
    const isES = lang.startsWith('es');

    const subject = isDE ? 'Danke f\u00FCr den Bugreport \u2014 wir sind dran'
      : isPT ? 'Obrigado pelo bug report \u2014 estamos nisso'
      : isNL ? 'Dank voor je melding \u2014 we pakken het op'
      : isES ? 'Gracias por el reporte \u2014 lo revisamos'
      : 'Thanks for the bug report \u2014 we\u2019re on it';

    const heading = isDE ? 'Hallo,'
      : isPT ? 'Ol\u00E1,'
      : isNL ? 'Hoi,'
      : isES ? 'Hola,'
      : 'Hi,';

    // BUG-REWARD-DISABLE-AUTO-ISSUANCE-001: structured copy with locked
    // "What happens next" bullets. No inline redeem links, no offer code in
    // this email -- that path is gated behind the manual `reward-approved`
    // label (see BBE-002 in this file). The reward sentence below is a
    // PROMISE of a possible future reward, not an offer code.
    const leadIn = isDE ? 'Danke, dass du dir die Zeit genommen hast, einen Fehler in Sorting History zu melden. Berichte von echten Spielern sind der schnellste Weg, das Spiel zu verbessern, und wir sch\u00E4tzen das wirklich.'
      : isPT ? 'Obrigado por dedicares o teu tempo a reportar um bug no Sorting History. Os relat\u00F3rios de jogadores reais s\u00E3o a forma mais r\u00E1pida de melhorarmos o jogo, e agradecemos genuinamente.'
      : isNL ? 'Bedankt dat je de tijd hebt genomen om een bug in Sorting History te melden. Rapporten van echte spelers zijn de snelste manier waarop we het spel verbeteren, en we waarderen het oprecht.'
      : isES ? 'Gracias por tomarte el tiempo de reportar un error en Sorting History. Los reportes de jugadores reales son la forma m\u00E1s r\u00E1pida en que mejoramos el juego, y de verdad lo apreciamos.'
      : 'Thanks for taking the time to report a bug in Sorting History. Reports from real players are the fastest way we improve the game, and we genuinely appreciate it.';

    const whatNextLabel = isDE ? 'Was als N\u00E4chstes passiert:'
      : isPT ? 'O que acontece a seguir:'
      : isNL ? 'Wat er nu gebeurt:'
      : isES ? 'Qu\u00E9 sucede a continuaci\u00F3n:'
      : 'What happens next:';

    const bulletWeek = isDE ? 'Fehler beheben wir meist innerhalb einer Woche.'
      : isPT ? 'Normalmente conseguimos corrigir bugs numa semana.'
      : isNL ? 'Bugfixes regelen we meestal binnen een week.'
      : isES ? 'Normalmente podemos resolver errores en una semana.'
      : 'We can usually address bug fixes within a week.';

    const bulletReward = isDE ? 'Wenn dein Bericht zu einem Fix oder einer Verbesserung f\u00FChrt, schicken wir dir einen einmaligen Code f\u00FCr 2 Monate Historiker Monatlich gratis als Dankesch\u00F6n, zusammen mit der Best\u00E4tigung, dass der Fix ausgeliefert ist.'
      : isPT ? 'Se o teu relat\u00F3rio levar a um fix ou melhoria, enviamos-te um c\u00F3digo \u00FAnico para 2 meses gr\u00E1tis de Historiador Mensal como agradecimento, junto com a confirma\u00E7\u00E3o de que o fix foi lan\u00E7ado.'
      : isNL ? 'Als je rapport leidt tot een fix of verbetering, sturen we je als bedankje een eenmalige code voor 2 maanden gratis Historicus Maandelijks, plus bevestiging dat de fix is uitgebracht.'
      : isES ? 'Si tu reporte lleva a un fix o mejora, te enviaremos un c\u00F3digo \u00FAnico para 2 meses gratis de Historiador Mensual como agradecimiento, junto con la confirmaci\u00F3n de que el fix se public\u00F3.'
      : 'If your report leads to a fix or improvement, we\u2019ll send you a one-time code for 2 free months of Historian Monthly as a thank-you, along with confirmation that the fix has shipped.';

    const bulletOnlyHear = isDE ? 'Du h\u00F6rst nur dann wieder von uns zu diesem Bericht, wenn er best\u00E4tigt ist, wenn wir mehr Infos brauchen, oder wenn der Fix ausgeliefert wird.'
      : isPT ? 'S\u00F3 voltar\u00E1s a ouvir de n\u00F3s sobre este relat\u00F3rio se for confirmado, se precisarmos de mais informa\u00E7\u00F5es, ou quando o fix for lan\u00E7ado.'
      : isNL ? 'Je hoort alleen weer van ons over dit rapport als het bevestigd is, als we meer info nodig hebben, of wanneer de fix wordt uitgebracht.'
      : isES ? 'Solo volver\u00E1s a saber de nosotros sobre este reporte si se confirma, si necesitamos m\u00E1s informaci\u00F3n, o cuando el fix se publique.'
      : 'You\u2019ll only hear from us again about this report if it\u2019s confirmed, if we need more info, or when the fix ships.';

    const refId = confirmationId ?? `BUG-${issueNumber}`;
    const refLine = isDE ? `Deine Berichts-ID ist ${refId} \u2014 zur Referenz aufbewahren.`
      : isPT ? `O teu ID de relat\u00F3rio \u00E9 ${refId} \u2014 guarda-o para refer\u00EAncia.`
      : isNL ? `Je rapport-ID is ${refId} \u2014 bewaar het ter referentie.`
      : isES ? `Tu ID de reporte es ${refId} \u2014 gu\u00E1rdalo como referencia.`
      : `Your report ID is ${refId} \u2014 keep it for reference.`;

    const thanksAgain = isDE ? 'Nochmals danke,'
      : isPT ? 'Mais uma vez, obrigado,'
      : isNL ? 'Nogmaals bedankt,'
      : isES ? 'Gracias de nuevo,'
      : 'Thanks again,';

    const closing = isDE ? 'Das Sorting History Team'
      : isPT ? 'A equipa do Sorting History'
      : isNL ? 'Het Sorting History team'
      : isES ? 'El equipo de Sorting History'
      : 'The Sorting History team';

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="text-align: center; padding: 20px 0; border-bottom: 2px solid #1a3a4a;">
    <h1 style="color: #1a3a4a; margin: 0; font-size: 24px;">Sorting History</h1>
  </div>
  <div style="padding: 30px 0;">
    <h2 style="color: #1a3a4a;">${heading}</h2>
    <p style="line-height: 1.6;">${leadIn}</p>
    <p style="line-height: 1.6; margin-top: 20px;"><strong>${whatNextLabel}</strong></p>
    <ul style="line-height: 1.6; padding-left: 20px;">
      <li style="margin-bottom: 8px;">${bulletWeek}</li>
      <li style="margin-bottom: 8px;">${bulletReward}</li>
      <li style="margin-bottom: 8px;">${bulletOnlyHear}</li>
    </ul>
    <p style="line-height: 1.6; margin-top: 20px;">${refLine}</p>
    <p style="line-height: 1.6; margin-top: 20px;">${thanksAgain}<br>${closing}</p>
  </div>
</body></html>`;

    const text = `${heading}\n\n${leadIn}\n\n${whatNextLabel}\n\n- ${bulletWeek}\n- ${bulletReward}\n- ${bulletOnlyHear}\n\n${refLine}\n\n${thanksAgain}\n${closing}\n`;

    // AC6: Check for duplicate — skip if email-sent label already on issue
    try {
      const labelsRes = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`,
        { headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'User-Agent': 'SortingHistory-Bug-Webhook' } }
      );
      if (labelsRes.ok) {
        const labels = await labelsRes.json() as Array<{ name: string }>;
        if (labels.some(l => l.name === 'email-sent')) {
          console.log(`FR-160: Skipping duplicate email for issue #${issueNumber}`);
          return;
        }
      }
    } catch { /* proceed if label check fails */ }

    try {
      const result = await sendOwnerEmail(env, {
        from: 'Sorting History <hello@sortinghistory.com>',
        to: email,
        subject,
        html,
        text,
      });

      if (!result.ok) {
        console.error(`FR-160: Email send failed: ${result.error}`);
        // AC5: Comment on GitHub issue about email failure
        await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
          {
            method: 'POST',
            headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'SortingHistory-Bug-Webhook' },
            body: JSON.stringify({ body: `⚠️ Email delivery failed for ${email.substring(0, 3)}***@${email.split('@')[1] || '...'} (${result.error || 'unknown'})` }),
          }
        ).catch(() => {});
      } else {
        console.log(`FR-160: Thank-you email sent to ${email.substring(0, 3)}***`);
        // AC6: Add email-sent label to prevent duplicates on retry
        await fetch(
          `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/labels`,
          {
            method: 'POST',
            headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'SortingHistory-Bug-Webhook' },
            body: JSON.stringify({ labels: ['email-sent'] }),
          }
        ).catch(() => {});
      }
    } catch (err) {
      console.error('FR-160: Email send error:', err);
      // AC5: Comment on GitHub issue about email error
      await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${issueNumber}/comments`,
        {
          method: 'POST',
          headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'SortingHistory-Bug-Webhook' },
          body: JSON.stringify({ body: `⚠️ Email delivery error for ${email.substring(0, 3)}***@${email.split('@')[1] || '...'}: ${err}` }),
        }
      ).catch(() => {});
    }
  },

  // PIPE-NOTIFY: Send per-bug owner notification email via Resend.
  // Fires immediately after a GitHub issue is created, BEFORE any LLM
  // (triage / fix) workflow runs. Independent of Claude SDK lifecycle.
  // No retry, no throw: GitHub issue is the durable record; failures log only.
  async sendOwnerNotifyEmail(
    env: Env,
    report: BugReport,
    issueNumber: number,
    screenshotUrl: string | undefined
  ): Promise<void> {
    if (!env.RESEND_API_KEY) {
      console.error(`BUG_${issueNumber}_NOTIFY_FAILED: RESEND_API_KEY not configured`);
      return;
    }
    if (!env.OWNER_EMAIL) {
      console.error(`BUG_${issueNumber}_NOTIFY_FAILED: OWNER_EMAIL not configured`);
      return;
    }

    // AC3: ASCII-only subject, title truncated to 80 chars.
    const rawTitle = (report.description || '').replace(/[\r\n]+/g, ' ').trim();
    const asciiTitle = rawTitle.replace(/[^\x20-\x7E]/g, '?');
    const truncatedTitle = asciiTitle.length > 80
      ? asciiTitle.substring(0, 77) + '...'
      : asciiTitle;
    const subject = `[Sorting History bug #${issueNumber}] ${truncatedTitle || '(no title)'}`;

    // AC4: Body fields.
    const di = report.deviceInfo;
    const device = di?.model || 'unknown';
    const ios = di?.osVersion || 'unknown';
    const appVersion = di?.appVersion || 'unknown';
    const buildNumber = di?.buildNumber || 'unknown';
    const issueUrl = `https://github.com/RaufGlasgow/Sorting-History/issues/${issueNumber}`;

    // Reporter Actual behavior, truncated to 500 chars.
    const fullBehavior = report.description || '';
    const behavior = fullBehavior.length > 500
      ? fullBehavior.substring(0, 500) + '...'
      : fullBehavior;

    // Minimal HTML escape for body fields rendered as text.
    const esc = (s: string): string => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const screenshotBlock = screenshotUrl
      ? `<p><strong>Screenshot:</strong> <a href="${esc(screenshotUrl)}">${esc(screenshotUrl)}</a></p>`
      : '';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #222; line-height: 1.5;">
  <h2 style="margin: 0 0 12px 0;">New bug reported: #${issueNumber}</h2>
  <p style="margin: 0 0 16px 0;"><a href="${issueUrl}">${issueUrl}</a></p>
  <table style="border-collapse: collapse; margin-bottom: 16px;">
    <tr><td style="padding: 4px 12px 4px 0;"><strong>Device</strong></td><td style="padding: 4px 0;">${esc(device)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0;"><strong>iOS</strong></td><td style="padding: 4px 0;">${esc(ios)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0;"><strong>App version</strong></td><td style="padding: 4px 0;">${esc(appVersion)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0;"><strong>Build</strong></td><td style="padding: 4px 0;">${esc(buildNumber)}</td></tr>
  </table>
  <p style="margin: 0 0 6px 0;"><strong>Actual behavior:</strong></p>
  <pre style="white-space: pre-wrap; background: #f5f5f5; padding: 12px; border-radius: 4px; margin: 0 0 16px 0; font-family: inherit;">${esc(behavior)}</pre>
  ${screenshotBlock}
  <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0 16px 0;">
  <p style="color: #666; font-size: 13px; margin: 0;">Approve/Reject buttons return when PIPE-FIX ships. During interim: read the issue, dispatch dev sub-agent, or fix locally.</p>
</body></html>`;

    const result = await sendOwnerEmail(env, {
      from: 'Sorting History <hello@sortinghistory.com>',
      to: env.OWNER_EMAIL,
      subject,
      html,
    });

    if (!result.ok) {
      console.error(`BUG_${issueNumber}_NOTIFY_FAILED: ${result.error}`);
      return;
    }
    console.log(`PIPE-NOTIFY: owner notify email sent for #${issueNumber}`);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Serve screenshots from R2
    if (request.method === 'GET' && url.pathname.startsWith('/screenshots/')) {
      const key = url.pathname.replace('/screenshots/', '');
      if (!key) {
        return new Response('Not Found', { status: 404 });
      }
      return handleScreenshotGet(env, key);
    }

    // Story 5.2: Health endpoint — always returns 200, reports digest health from KV
    if (request.method === 'GET' && url.pathname === '/api/pipeline/health') {
      return handleHealthCheck(env);
    }

    // Handoff endpoints — confirmation page + file download
    if (url.pathname === '/api/pipeline/handoff' || url.pathname === '/api/pipeline/fix-locally') return handleHandoffDownload(request, env, ctx);
    if (url.pathname === '/api/pipeline/handoff-file') return handleHandoffFileDownload(request, env, ctx);

    // PIPE-013: Handle HEAD for all pipeline endpoints (mobile email client prefetch)
    if (request.method === 'HEAD' && url.pathname.startsWith('/api/pipeline/')) {
      return new Response(null, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    // Pipeline action endpoints (GET + POST, must be before POST-only guard)
    if (url.pathname === '/api/pipeline/redo' || url.pathname === '/api/pipeline/retry-triage') return handlePipelineRedo(request, env);
    if (url.pathname === '/api/pipeline/approve') return handlePipelineAction(request, env, 'approve');
    if (url.pathname === '/api/pipeline/reject') return handlePipelineAction(request, env, 'reject');
    if (url.pathname === '/api/pipeline/comment') return handlePipelineComment(request, env);
    if (url.pathname === '/api/pipeline/rework') return handlePipelineRework(request, env);
    if (url.pathname === '/api/pipeline/merge') return handleMerge(request, env);
    if (url.pathname === '/api/pipeline/review-build') return handleReviewBuild(request, env);
    if (url.pathname === '/api/pipeline/approve-merge') return handleApproveMerge(request, env);

    // BBE-002: reward-code automation routes.
    if (request.method === 'GET' && url.pathname === '/api/reward-code/status') {
      return handleRewardCodeStatus(env);
    }
    if (url.pathname.startsWith('/api/bbe/')) {
      return handleBBEAdmin(request, env, url.pathname);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Only accept POST requests for remaining routes
    if (request.method !== 'POST') {
      console.error(`405: method=${request.method} path=${url.pathname} ua=${request.headers.get('user-agent') || 'none'}`);
      return new Response(
        JSON.stringify({ error: 'Method not allowed. Use POST.' }),
        {
          status: 405,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const path = url.pathname;

    // Route: POST /api/commands - GitHub webhook for /approve and /reject
    if (path === '/api/commands') {
      return handleCommandsWebhook(request, env, ctx);
    }

    // Default: bug report handler (inline, uses main's C2/C3/C4 improvements)
    // Parse request body
    let data: unknown;
    try {
      data = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // Validate the bug report
    const validation = validateBugReport(data);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({ error: 'Validation failed', details: validation.errors }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const report = validation.report;
    const confirmationId = generateConfirmationId();

    // Check if GitHub token is configured
    if (!env.GITHUB_TOKEN) {
      // C2 fix: Return failure so the app retries later when config is fixed
      console.error('GITHUB_TOKEN not configured - bug report not sent to GitHub');
      return new Response(
        JSON.stringify({
          success: false,
          confirmation_id: confirmationId,
          message: 'Bug report could not be submitted. Please try again later.',
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    // PIPE-008: Check for duplicate bug report before creating a new issue
    const dedup = await checkForDuplicate(env, report);

    if (dedup.isDuplicate && dedup.originalIssueNumber && dedup.originalIssueUrl) {
      // Verify the original issue still exists by attempting to comment on it
      const commentOk = await commentOnOriginalIssue(
        env, dedup.originalIssueNumber, dedup.reportCount!, confirmationId, report.email
      );

      if (commentOk) {
        // Original issue exists — handle as duplicate
        // Fire-and-forget: upsert tracker comment, add label
        ctx.waitUntil(upsertDuplicateTracker(env, dedup.originalIssueNumber, dedup.reportCount!));
        ctx.waitUntil(addDuplicateLabel(env, dedup.originalIssueNumber));

        // AC-7: Send thank-you email even for duplicate reporters
        // PIPE-011: Skip if reporter is the pipeline owner
        if (report.email) {
          const isOwner = env.OWNER_EMAIL && report.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
          if (isOwner) {
            console.log(`FR-160: Skipping thank-you for owner-submitted duplicate report #${dedup.originalIssueNumber}`);
          } else {
            ctx.waitUntil(this.sendThankYouEmail(env, report.email, report.deviceInfo?.gameLanguage, report.deviceInfo?.locale, dedup.originalIssueNumber, confirmationId));
          }
        }

        // AC-14: Do NOT dispatch triage for duplicates
        return new Response(
          JSON.stringify({
            success: true,
            confirmation_id: confirmationId,
            issue_number: dedup.originalIssueNumber,
            issue_url: dedup.originalIssueUrl,
            message: 'Bug report linked to existing issue',
            duplicate: true,
          }),
          {
            status: 201,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      } else {
        // AC-8 Failsafe: original issue is gone (404/410), clear stale KV entry
        // and fall through to create a new issue
        console.warn(`[DEDUP] Failsafe: original issue #${dedup.originalIssueNumber} unreachable, creating new issue`);
        ctx.waitUntil(clearDedupEntry(env, report));
      }
    }

    // Upload screenshot to R2 if present
    let screenshotUrl: string | undefined;
    if (report.screenshot) {
      const workerOrigin = new URL(request.url).origin;
      const uploaded = await uploadScreenshot(env, report.screenshot, confirmationId, workerOrigin);
      if (uploaded) {
        screenshotUrl = uploaded;
      }
      // If upload fails, falls through — formatIssueBody will use base64 fallback
    }

    // Create GitHub issue
    const result = await createGitHubIssue(env, report, confirmationId, screenshotUrl);

    if (result.success) {
      // PIPE-008: Store dedup entry for this new issue
      ctx.waitUntil(storeDedupEntry(env, report, result.issueNumber, result.issueUrl));

      // PIPE-NOTIFY: per-bug owner email fires BEFORE any LLM-bound dispatch.
      // No Anthropic / Claude SDK in this path. Single Resend send + log on
      // failure. AC6: fires regardless of triage status. AC7: failures do not
      // block the rest of the webhook flow; GitHub issue is the durable record.
      ctx.waitUntil(this.sendOwnerNotifyEmail(env, report, result.issueNumber, screenshotUrl));

      // Dispatch analysis to public repo in background (don't block user response)
      ctx.waitUntil(dispatchAnalysis(env, result.issueNumber));

      // FR-160 / BUG-REWARD-DISABLE-AUTO-ISSUANCE-001:
      // Send acknowledgment (thank-you) email in background. This email is
      // INTENTIONALLY a thank-you only: it does NOT carry a redeem code or
      // inline reward link. Apple silently no-ops FREE_TRIAL+REPLACE_INTRO_OFFERS
      // for any reporter in an active intro trial, so auto-issuance on
      // submission was retired (PR #53 + BUG-REWARD-DISABLE-AUTO-ISSUANCE-001).
      // Actual reward dispatch is gated behind the manual `reward-approved`
      // label (see BBE-002 issues.labeled handler above) -- do NOT add
      // auto-dispatch here without first reading BUG-REWARD-DISABLE-AUTO-ISSUANCE-001.
      // PIPE-011: Skip if reporter is the pipeline owner
      if (report.email) {
        const isOwner = env.OWNER_EMAIL && report.email.toLowerCase() === env.OWNER_EMAIL.toLowerCase();
        if (isOwner) {
          console.log(`FR-160: Skipping thank-you for owner-submitted report #${result.issueNumber}`);
        } else {
          ctx.waitUntil(this.sendThankYouEmail(env, report.email, report.deviceInfo?.gameLanguage, report.deviceInfo?.locale, result.issueNumber, confirmationId));
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          confirmation_id: confirmationId,
          issue_number: result.issueNumber,
          issue_url: result.issueUrl,
          message: 'Bug report submitted successfully',
        }),
        {
          status: 201,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } else {
      // C2 fix: Return success: false so the app's retry queue re-sends the report
      console.error('GitHub issue creation failed:', result.error);
      return new Response(
        JSON.stringify({
          success: false,
          confirmation_id: confirmationId,
          message: 'Bug report could not be submitted. Please try again.',
        }),
        {
          status: 503,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
