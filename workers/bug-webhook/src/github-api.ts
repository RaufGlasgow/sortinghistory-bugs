/**
 * BUG-PIPE-007: GitHub API helpers for label mutation routes.
 *
 * addLabel   — POST /repos/.../issues/{N}/labels
 * closeIssue — PATCH /repos/.../issues/{N}  (state=closed)
 *
 * These helpers throw on non-2xx so callers can wrap in try/catch and return 502.
 * The PAT (env.GITHUB_TOKEN) must NEVER appear in thrown error messages.
 */

export interface GithubApiEnv {
  GITHUB_TOKEN: string;
  GITHUB_REPO?: string;
}

const GH_API = 'https://api.github.com';
const USER_AGENT = 'bug-webhook';
const ACCEPT = 'application/vnd.github+json';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Sanitize a GitHub API error response into a safe message — no token, no PAT.
 * Returns a plain string suitable for inclusion in an HTML response body.
 */
export function sanitizeGhError(status: number, body: string): string {
  // Strip anything that looks like a token
  const redacted = body
    .replace(/ghp_[A-Za-z0-9]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/token\s+[A-Za-z0-9_]+/gi, 'token [REDACTED]')
    .substring(0, 200);

  if (status === 404) return 'Issue not found (404).';
  if (status === 403) return 'GitHub API access denied (403).';
  if (status === 410) return 'Issue no longer exists (410).';
  if (status === 422) return `GitHub validation error (422): ${redacted}`;
  if (status >= 500) return `GitHub API server error (${status}).`;
  return `GitHub API error (${status}): ${redacted}`;
}

/**
 * Add a label to a GitHub issue.
 *
 * @throws Error with sanitized message on non-2xx response or network failure.
 */
export async function addLabel(env: GithubApiEnv, issueNum: number, label: string): Promise<void> {
  const repo = env.GITHUB_REPO ?? 'RaufGlasgow/Sorting-History';
  const url = `${GH_API}/repos/${repo}/issues/${issueNum}/labels`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...ghHeaders(env.GITHUB_TOKEN),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ labels: [label] }),
    });
  } catch (err) {
    // Network-level failure — do not expose token
    throw new Error(`Network error contacting GitHub: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(sanitizeGhError(res.status, body));
  }
  // 200 OK: label added (or was already present — idempotent)
}

/**
 * Close a GitHub issue.
 *
 * @throws Error with sanitized message on non-2xx response or network failure.
 */
export async function closeIssue(
  env: GithubApiEnv,
  issueNum: number,
  reason: 'completed' | 'not_planned',
): Promise<void> {
  const repo = env.GITHUB_REPO ?? 'RaufGlasgow/Sorting-History';
  const url = `${GH_API}/repos/${repo}/issues/${issueNum}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: {
        ...ghHeaders(env.GITHUB_TOKEN),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: 'closed', state_reason: reason }),
    });
  } catch (err) {
    throw new Error(`Network error contacting GitHub: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(sanitizeGhError(res.status, body));
  }
}
