import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dispatchAnalysis } from '../../index';

// PIPE-DISPATCH-PENDING-FALSE-STUCK-WHILE-FROZEN-001
describe('dispatchAnalysis while triage is frozen', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const baseEnv = {
    BUGS_REPO_PAT: 'expired',
    BUGS_REPO: 'owner/bugs',
    GITHUB_REPO: 'owner/private',
    GITHUB_TOKEN: 'ghp_test',
  };

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes no GitHub call and adds no label when TRIAGE_DISPATCH is off', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchAnalysis({ ...baseEnv, TRIAGE_DISPATCH: 'off' } as any, 727);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still dispatches and falls back to dispatch-pending when TRIAGE_DISPATCH is not off', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await dispatchAnalysis({ ...baseEnv, USE_AGENT_PIPELINE: 'false' } as any, 727);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe('https://api.github.com/repos/owner/bugs/dispatches');
    const labelCall = fetchMock.mock.calls.find((c) => (c[0] as string).endsWith('/issues/727/labels'));
    expect(labelCall).toBeDefined();
    expect(JSON.parse((labelCall![1] as RequestInit).body as string)).toEqual({ labels: ['dispatch-pending'] });
  });
});
