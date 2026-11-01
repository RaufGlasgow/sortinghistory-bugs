import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkDigestHealth, DIGEST_MAX_AGE_HOURS } from '../digest-watchdog';

const ENV = { GITHUB_TOKEN: 'ghp_test', BUGS_REPO: 'owner/bugs' };
const NOW = new Date('2026-11-01T13:00:00Z');

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Routes the three GitHub calls the watchdog makes.
function routeGitHub(opts: {
  state?: Response;
  success?: Response;
  failure?: Response;
}) {
  return vi.fn(async (url: string) => {
    if (url.includes('status=success')) return opts.success ?? json({ workflow_runs: [] });
    if (url.includes('status=failure')) return opts.failure ?? json({ workflow_runs: [] });
    return opts.state ?? json({ state: 'active' });
  });
}

describe('checkDigestHealth', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function install(mock: ReturnType<typeof vi.fn>) {
    fetchMock = mock;
    (globalThis as unknown as { fetch: unknown }).fetch = mock;
  }

  it('is ok when the workflow is active and succeeded recently', async () => {
    install(routeGitHub({ success: json({ workflow_runs: [{ created_at: hoursAgo(3) }] }) }));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.state).toBe('active');
    expect(result.lastSuccess).toBe(hoursAgo(3));
  });

  it('flags disabled_inactivity even when the last success looks fresh', async () => {
    install(routeGitHub({
      state: json({ state: 'disabled_inactivity' }),
      success: json({ workflow_runs: [{ created_at: hoursAgo(1) }] }),
    }));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('disabled_inactivity');
  });

  it('flags a stale last success beyond the limit', async () => {
    install(routeGitHub({ success: json({ workflow_runs: [{ created_at: hoursAgo(DIGEST_MAX_AGE_HOURS + 1) }] }) }));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('Last successful Pipeline Digest run');
  });

  it('flags no successful run on record', async () => {
    install(routeGitHub({}));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('Pipeline Digest has no successful run on record.');
  });

  it('treats a GitHub 401 as a problem, never a pass', async () => {
    install(vi.fn(async () => json({ message: 'Bad credentials' }, 401)));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('GitHub API 401'))).toBe(true);
  });

  it('does not throw on network errors', async () => {
    install(vi.fn(async () => { throw new Error('network down'); }));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('network down'))).toBe(true);
  });

  it('reports the latest failure without failing on it alone', async () => {
    install(routeGitHub({
      success: json({ workflow_runs: [{ created_at: hoursAgo(2) }] }),
      failure: json({ workflow_runs: [{ created_at: hoursAgo(6) }] }),
    }));
    const result = await checkDigestHealth(ENV, NOW);
    expect(result.ok).toBe(true);
    expect(result.lastFailure).toBe(hoursAgo(6));
  });

  it('calls the bugs repo digest workflow with auth and a User-Agent', async () => {
    install(routeGitHub({ success: json({ workflow_runs: [{ created_at: hoursAgo(1) }] }) }));
    await checkDigestHealth(ENV, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/bugs/actions/workflows/daily-analysis-digest.yml');
    expect(init.headers['Authorization']).toBe('token ghp_test');
    expect(init.headers['User-Agent']).toBe('SortingHistory-Digest-Watchdog');
  });
});
