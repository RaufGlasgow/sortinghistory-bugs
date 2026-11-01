// PIPE-BUG-ALERTS-DEAD-SINCE-AUGUST-001: Pipeline Digest watchdog.
//
// The digest runs on a GitHub Actions schedule in a public repo. GitHub
// disables such schedules after 60 days with no repository activity, which
// silenced the digest from 2026-08-08 with no alert to anyone. Cloudflare
// crons are not subject to that rule, so the Worker checks the digest once a
// day and reports what it finds.
//
// Behavior contract:
//   - Reads the workflow state and its latest successful / failed run from the
//     GitHub REST API (read-only).
//   - ok === true only when the workflow is `active` AND its latest successful
//     run is no older than DIGEST_MAX_AGE_HOURS.
//   - Any GitHub API error (including 401 from an expired GITHUB_TOKEN) is a
//     problem, never a pass.
//   - Never throws; network errors become problems.

export const DIGEST_WORKFLOW_FILE = 'daily-analysis-digest.yml';

// The watchdog cron runs at 13:00 UTC. The digest's first run of the day is
// 10:00 UTC and GitHub has started it up to ~80 minutes late, so 9 hours means
// "today's morning digest has not succeeded".
export const DIGEST_MAX_AGE_HOURS = 9;

export interface DigestWatchdogEnv {
  GITHUB_TOKEN?: string;
  BUGS_REPO: string;
}

export interface DigestWatchdogResult {
  ok: boolean;
  state?: string;
  lastSuccess?: string;
  lastFailure?: string;
  problems: string[];
}

interface WorkflowRunsResponse {
  workflow_runs?: Array<{ created_at?: string; html_url?: string }>;
}

async function githubGet<T>(env: DigestWatchdogEnv, path: string): Promise<{ data?: T; error?: string }> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'SortingHistory-Digest-Watchdog',
  };
  if (env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${env.GITHUB_TOKEN}`;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${env.BUGS_REPO}${path}`, { headers });
    if (!response.ok) {
      return { error: `GitHub API ${response.status} on ${path}` };
    }
    return { data: (await response.json()) as T };
  } catch (err) {
    return { error: `GitHub API exception on ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function checkDigestHealth(env: DigestWatchdogEnv, now: Date = new Date()): Promise<DigestWatchdogResult> {
  const problems: string[] = [];
  const base = `/actions/workflows/${DIGEST_WORKFLOW_FILE}`;

  const workflow = await githubGet<{ state?: string }>(env, base);
  const state = workflow.data?.state;
  if (workflow.error) {
    problems.push(workflow.error);
  } else if (state !== 'active') {
    problems.push(`Pipeline Digest workflow state is '${state ?? 'unknown'}', not 'active'. Scheduled runs are not happening.`);
  }

  const success = await githubGet<WorkflowRunsResponse>(env, `${base}/runs?status=success&per_page=1`);
  const lastSuccess = success.data?.workflow_runs?.[0]?.created_at;
  if (success.error) {
    problems.push(success.error);
  } else if (!lastSuccess) {
    problems.push('Pipeline Digest has no successful run on record.');
  } else {
    const hours = (now.getTime() - new Date(lastSuccess).getTime()) / (1000 * 60 * 60);
    if (hours > DIGEST_MAX_AGE_HOURS) {
      problems.push(`Last successful Pipeline Digest run was ${lastSuccess} (${Math.floor(hours)}h ago; limit ${DIGEST_MAX_AGE_HOURS}h).`);
    }
  }

  // Informational only: the latest failure, so the alert and health row can show it.
  const failure = await githubGet<WorkflowRunsResponse>(env, `${base}/runs?status=failure&per_page=1`);
  const lastFailure = failure.data?.workflow_runs?.[0]?.created_at;

  return { ok: problems.length === 0, state, lastSuccess, lastFailure, problems };
}
