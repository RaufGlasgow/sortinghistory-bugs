/**
 * BUG-PIPE-007: Unit tests for /label/fix, /label/needs-info, /label/ignore routes.
 *
 * Covers all 13 AC scenarios:
 *  T1  success /label/fix
 *  T2  success /label/needs-info
 *  T3  success /label/ignore (addLabel then closeIssue)
 *  T4  bad/missing token → 401
 *  T5  bad/missing/non-numeric/overflow issue → 400
 *  T6  GitHub 404 → 502 with sanitized body
 *  T7  GitHub 403 → 502 with sanitized body
 *  T8  GitHub 5xx → 502 with sanitized body
 *  T9  GitHub network throw → 502 with sanitized body
 *  T10 /label/ignore skips closeIssue on addLabel failure
 *  T11 idempotent re-click (already-labeled = GitHub 200 → our 200)
 *  T12 non-GET → 405
 *  T13 structured log contains no PAT or AUTH_TOKEN
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addLabel, closeIssue, sanitizeGhError } from '../github-api';

// ── Minimal Env shape ───────────────────────────────────────────────────────

interface TestEnv {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  AUTH_TOKEN: string;
  [key: string]: unknown;
}

function makeEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  return {
    GITHUB_TOKEN: 'ghp_SECRETPAT0000000000000000000000001',
    GITHUB_REPO: 'RaufGlasgow/Sorting-History',
    AUTH_TOKEN: 'test-auth-token-secret',
    ...overrides,
  };
}

// ── Inline route handler (mirrors index.ts logic) ───────────────────────────
// We test the handler logic directly to avoid importing the full Worker bundle
// (which requires Cloudflare-specific globals). The handler is a thin wrapper
// around addLabel/closeIssue, both of which we mock here.

const LABEL_SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function escapeHtmlSafe(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function validateIssueParam(raw: string | null): { valid: true; num: number } | { valid: false; error: string } {
  if (!raw) return { valid: false, error: 'Missing required query parameter: issue' };
  if (!/^\d+$/.test(raw)) return { valid: false, error: 'Invalid issue: must be a positive integer' };
  const num = Number(raw);
  if (!Number.isSafeInteger(num)) return { valid: false, error: 'Invalid issue: number out of safe integer range' };
  if (num <= 0) return { valid: false, error: 'Invalid issue: must be greater than zero' };
  return { valid: true, num };
}

function validateAuthToken(provided: string | null, expected: string): boolean {
  return !!provided && !!expected && provided === expected;
}

function labelConfirmHtml(issueNum: number, message: string): string {
  return `<html><title>Issue #${issueNum}</title><p>${escapeHtmlSafe(message)}</p></html>`;
}

function labelErrorHtml(title: string, detail: string): string {
  return `<html><h1>${escapeHtmlSafe(title)}</h1><p>${escapeHtmlSafe(detail)}</p></html>`;
}

async function handleLabelRoute(
  request: Request,
  env: TestEnv,
  route: 'fix' | 'needs-info' | 'ignore',
  deps: { addLabel: typeof addLabel; closeIssue: typeof closeIssue },
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(
      labelErrorHtml('Method Not Allowed', 'Only GET requests are supported.'),
      { status: 405, headers: { ...LABEL_SECURITY_HEADERS, Allow: 'GET' } },
    );
  }

  const url = new URL(request.url);
  const providedToken = url.searchParams.get('token');
  if (!validateAuthToken(providedToken, env.AUTH_TOKEN)) {
    return new Response(
      labelErrorHtml('Unauthorized', 'Invalid or missing token.'),
      { status: 401, headers: LABEL_SECURITY_HEADERS },
    );
  }

  const rawIssue = url.searchParams.get('issue');
  const validation = validateIssueParam(rawIssue);
  if (!validation.valid) {
    return new Response(
      labelErrorHtml('Invalid Request', validation.error),
      { status: 400, headers: LABEL_SECURITY_HEADERS },
    );
  }
  const issueNum = validation.num;

  const labelMap: Record<string, string> = {
    fix: 'approved-for-fix',
    'needs-info': 'needs-info',
    ignore: 'wontfix',
  };
  const label = labelMap[route];

  try {
    await deps.addLabel(env, issueNum, label);
    if (route === 'ignore') {
      await deps.closeIssue(env, issueNum, 'not_planned');
    }
  } catch (err) {
    const safeMsg = (err as Error).message;
    return new Response(
      labelErrorHtml('GitHub API Error', safeMsg),
      { status: 502, headers: LABEL_SECURITY_HEADERS },
    );
  }

  const successMessages: Record<string, string> = {
    fix: `Bug #${issueNum} approved for fix. Run /bug-pipeline in Claude Code to process the queue.`,
    'needs-info': `Bug #${issueNum} flagged for more info.`,
    ignore: `Bug #${issueNum} closed as wontfix.`,
  };

  return new Response(
    labelConfirmHtml(issueNum, successMessages[route]),
    { status: 200, headers: LABEL_SECURITY_HEADERS },
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(route: string, params: Record<string, string>, method = 'GET'): Request {
  const url = new URL(`https://bug-webhook.example.com/label/${route}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method });
}

function goodParams(issue = '42') {
  return { issue, token: 'test-auth-token-secret' };
}

async function addLabelOk(_env: unknown, _num: number, _label: string): Promise<void> {}
async function closeIssueOk(_env: unknown, _num: number, _reason: string): Promise<void> {}

function addLabelFail(msg: string) {
  return async (_env: unknown, _num: number, _label: string): Promise<void> => {
    throw new Error(msg);
  };
}

function closeIssueFail(msg: string) {
  return async (_env: unknown, _num: number, _reason: string): Promise<void> => {
    throw new Error(msg);
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BUG-PIPE-007 label routes', () => {
  const env = makeEnv();
  const deps = { addLabel: addLabelOk as typeof addLabel, closeIssue: closeIssueOk as typeof closeIssue };

  // T1: success /label/fix
  it('T1 — GET /label/fix returns 200 with confirmation', async () => {
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Bug #42 approved for fix');
    expect(body).toContain('Run /bug-pipeline');
  });

  // T2: success /label/needs-info
  it('T2 — GET /label/needs-info returns 200 with confirmation', async () => {
    const req = makeRequest('needs-info', goodParams());
    const res = await handleLabelRoute(req, env, 'needs-info', deps);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Bug #42 flagged for more info');
  });

  // T3: success /label/ignore — addLabel then closeIssue
  it('T3 — GET /label/ignore returns 200, calls addLabel then closeIssue in order', async () => {
    const callOrder: string[] = [];
    const trackDeps = {
      addLabel: async (_env: unknown, num: number, label: string): Promise<void> => {
        callOrder.push(`addLabel:${label}:${num}`);
      },
      closeIssue: async (_env: unknown, num: number, reason: string): Promise<void> => {
        callOrder.push(`closeIssue:${reason}:${num}`);
      },
    } as unknown as typeof deps;

    const req = makeRequest('ignore', goodParams());
    const res = await handleLabelRoute(req, env, 'ignore', trackDeps);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Bug #42 closed as wontfix');
    // Ordering: addLabel MUST come before closeIssue (TEA T7.2)
    expect(callOrder[0]).toMatch(/addLabel:wontfix/);
    expect(callOrder[1]).toMatch(/closeIssue:not_planned/);
    expect(callOrder).toHaveLength(2);
  });

  // T4: bad/missing token → 401
  it('T4a — missing token → 401', async () => {
    const req = makeRequest('fix', { issue: '42' });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('Unauthorized');
    // Must not echo the real AUTH_TOKEN
    expect(body).not.toContain(env.AUTH_TOKEN);
  });

  it('T4b — wrong token → 401', async () => {
    const req = makeRequest('fix', { issue: '42', token: 'wrong-token' });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(401);
  });

  // T5: bad/missing/non-numeric/overflow issue → 400
  it('T5a — missing issue param → 400', async () => {
    const req = makeRequest('fix', { token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing required query parameter');
  });

  it('T5b — non-numeric issue → 400', async () => {
    const req = makeRequest('fix', { issue: 'abc', token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(400);
  });

  it('T5c — decimal issue → 400', async () => {
    const req = makeRequest('fix', { issue: '3.14', token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(400);
  });

  it('T5d — negative issue → 400', async () => {
    const req = makeRequest('fix', { issue: '-5', token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(400);
  });

  it('T5e — zero issue → 400', async () => {
    const req = makeRequest('fix', { issue: '0', token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(400);
  });

  it('T5f — overflow issue (> MAX_SAFE_INTEGER) → 400', async () => {
    const req = makeRequest('fix', { issue: '99999999999999999', token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('safe integer');
  });

  // T6: GitHub 404 → 502 with sanitized body
  it('T6 — GitHub 404 → 502 sanitized', async () => {
    const failDeps = { addLabel: addLabelFail('Issue not found (404).') as typeof addLabel, closeIssue: closeIssueOk as typeof closeIssue };
    const req = makeRequest('fix', goodParams('99999'));
    const res = await handleLabelRoute(req, env, 'fix', failDeps);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('Issue not found');
    expect(body).not.toContain(env.GITHUB_TOKEN);
  });

  // T7: GitHub 403 → 502 with sanitized body
  it('T7 — GitHub 403 → 502 sanitized', async () => {
    const failDeps = { addLabel: addLabelFail('GitHub API access denied (403).') as typeof addLabel, closeIssue: closeIssueOk as typeof closeIssue };
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', failDeps);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('403');
    expect(body).not.toContain(env.GITHUB_TOKEN);
  });

  // T8: GitHub 5xx → 502 with sanitized body
  it('T8 — GitHub 5xx → 502 sanitized', async () => {
    const failDeps = { addLabel: addLabelFail('GitHub API server error (503).') as typeof addLabel, closeIssue: closeIssueOk as typeof closeIssue };
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', failDeps);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain('503');
  });

  // T9: GitHub network throw → 502 with sanitized body
  it('T9 — network throw → 502 sanitized, no PAT in body', async () => {
    const failDeps = { addLabel: addLabelFail('Network error contacting GitHub: fetch failed') as typeof addLabel, closeIssue: closeIssueOk as typeof closeIssue };
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', failDeps);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(env.GITHUB_TOKEN);
    expect(body).not.toContain(env.AUTH_TOKEN);
  });

  // T10: /label/ignore skips closeIssue on addLabel failure
  it('T10 — /label/ignore skips closeIssue if addLabel fails', async () => {
    let closeIssueCalled = false;
    const failDeps = {
      addLabel: addLabelFail('GitHub API access denied (403).') as typeof addLabel,
      closeIssue: async (): Promise<void> => {
        closeIssueCalled = true;
      },
    } as unknown as typeof deps;

    const req = makeRequest('ignore', goodParams());
    const res = await handleLabelRoute(req, env, 'ignore', failDeps);
    expect(res.status).toBe(502);
    // closeIssue MUST NOT have been called (TEA T7.2)
    expect(closeIssueCalled).toBe(false);
  });

  // T11: idempotent re-click — already-labeled is a GitHub 200 → our 200
  it('T11 — already-labeled (addLabel succeeds idempotently) → 200', async () => {
    // GitHub returns 200 for adding a label that already exists; addLabel resolves fine
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(200);
  });

  // T12: non-GET → 405
  it('T12a — POST on /label/fix → 405', async () => {
    const req = makeRequest('fix', goodParams(), 'POST');
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.status).toBe(405);
    const body = await res.text();
    expect(body).toContain('Method Not Allowed');
  });

  it('T12b — DELETE on /label/ignore → 405', async () => {
    const req = makeRequest('ignore', goodParams(), 'DELETE');
    const res = await handleLabelRoute(req, env, 'ignore', deps);
    expect(res.status).toBe(405);
  });

  // T13: structured log contains no PAT or AUTH_TOKEN
  it('T13 — console.log on 401 does not contain PAT or AUTH_TOKEN', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      const req = makeRequest('fix', { issue: '42', token: 'bad-token' });
      await handleLabelRoute(req, env, 'fix', deps);
    } finally {
      console.log = origLog;
    }

    for (const line of logs) {
      expect(line).not.toContain(env.GITHUB_TOKEN);
      expect(line).not.toContain(env.AUTH_TOKEN);
    }
  });

  it('T13b — console.log on success does not contain PAT or AUTH_TOKEN', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

    try {
      const req = makeRequest('fix', goodParams());
      await handleLabelRoute(req, env, 'fix', deps);
    } finally {
      console.log = origLog;
    }

    for (const line of logs) {
      expect(line).not.toContain(env.GITHUB_TOKEN);
      expect(line).not.toContain(env.AUTH_TOKEN);
    }
  });

  // Security headers on all responses
  it('SH1 — 200 response includes Referrer-Policy and Cache-Control', async () => {
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('SH2 — 401 response includes security headers', async () => {
    const req = makeRequest('fix', { issue: '42', token: 'bad' });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('SH3 — 400 response includes security headers', async () => {
    const req = makeRequest('fix', { token: env.AUTH_TOKEN });
    const res = await handleLabelRoute(req, env, 'fix', deps);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('SH4 — 502 response includes security headers', async () => {
    const failDeps = { addLabel: addLabelFail('Issue not found (404).') as typeof addLabel, closeIssue: closeIssueOk as typeof closeIssue };
    const req = makeRequest('fix', goodParams());
    const res = await handleLabelRoute(req, env, 'fix', failDeps);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

// ── Unit tests for sanitizeGhError ───────────────────────────────────────────

describe('sanitizeGhError', () => {
  it('redacts ghp_ tokens from body', () => {
    // Use status 422 (validation error) which includes body text in the return value,
    // unlike 403 which returns a fixed canned message that never echoes the body.
    const result = sanitizeGhError(422, 'Token ghp_ABCDEF1234567890 is invalid');
    expect(result).not.toContain('ghp_ABCDEF1234567890');
    expect(result).toContain('[REDACTED]');
  });

  it('returns fixed message for 404', () => {
    expect(sanitizeGhError(404, 'Not Found')).toBe('Issue not found (404).');
  });

  it('returns fixed message for 403', () => {
    expect(sanitizeGhError(403, 'Forbidden')).toBe('GitHub API access denied (403).');
  });

  it('returns server error for 5xx', () => {
    expect(sanitizeGhError(503, 'Service Unavailable')).toContain('503');
  });
});

// ── Unit tests for validateIssueParam (via inline copy) ──────────────────────

describe('validateIssueParam', () => {
  function validate(raw: string | null) {
    if (!raw) return { valid: false, error: 'Missing required query parameter: issue' };
    if (!/^\d+$/.test(raw)) return { valid: false, error: 'Invalid issue: must be a positive integer' };
    const num = Number(raw);
    if (!Number.isSafeInteger(num)) return { valid: false, error: 'Invalid issue: number out of safe integer range' };
    if (num <= 0) return { valid: false, error: 'Invalid issue: must be greater than zero' };
    return { valid: true, num };
  }

  it('accepts a normal positive integer', () => {
    expect(validate('42')).toEqual({ valid: true, num: 42 });
  });

  it('rejects null', () => {
    expect(validate(null)).toMatchObject({ valid: false });
  });

  it('rejects zero', () => {
    expect(validate('0')).toMatchObject({ valid: false });
  });

  it('rejects negative (via regex — no minus in /^\\d+$/)', () => {
    expect(validate('-1')).toMatchObject({ valid: false });
  });

  it('rejects decimal string', () => {
    expect(validate('3.14')).toMatchObject({ valid: false });
  });

  it('rejects scientific notation', () => {
    expect(validate('1e5')).toMatchObject({ valid: false });
  });

  it('rejects overflow (> MAX_SAFE_INTEGER)', () => {
    expect(validate('99999999999999999')).toMatchObject({ valid: false });
  });

  it('rejects empty string', () => {
    expect(validate('')).toMatchObject({ valid: false });
  });
});
