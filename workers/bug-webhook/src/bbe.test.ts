import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimCode,
  dispatchReward,
  fetchReporterEmailFromIssue,
  renderRewardEmail,
  type BBEEnv,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Result,
} from './bbe';

class ClaimRaceDb implements D1DatabaseLike {
  rows = [
    { code: 'CODEA', status: 'available', bug_report_id: null as string | null },
    { code: 'CODEB', status: 'available', bug_report_id: null as string | null },
  ];

  constructor(private readonly createDuplicateDuringUpdate: boolean) {}

  prepare(query: string): D1PreparedStatementLike {
    return new ClaimRaceStatement(this, query);
  }
}

class ClaimRaceStatement implements D1PreparedStatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly db: ClaimRaceDb,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes('WHERE bug_report_id = ?')) {
      const bugReportId = String(this.values[0]);
      const row = this.db.rows.find((r) =>
        r.bug_report_id === bugReportId && ['reserved', 'used'].includes(r.status)
      );
      return (row ? { code: row.code } : null) as T | null;
    }

    if (this.query.includes("WHERE status = 'available'")) {
      const row = this.db.rows.find((r) => r.status === 'available');
      return (row ? { code: row.code } : null) as T | null;
    }

    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return { results: [] };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes('UPDATE bug_bounty_codes') && this.query.includes("status = 'reserved'")) {
      const bugReportId = String(this.values[2]);
      const code = String(this.values[3]);

      if (this.db.rows.some((r) => r.bug_report_id === bugReportId && ['reserved', 'used'].includes(r.status))) {
        return { meta: { changes: 0 } };
      }

      if (this.db['createDuplicateDuringUpdate']) {
        this.db.rows[1].status = 'reserved';
        this.db.rows[1].bug_report_id = bugReportId;
        return { meta: { changes: 0 } };
      }

      const row = this.db.rows.find((r) => r.code === code && r.status === 'available');
      if (!row) return { meta: { changes: 0 } };
      row.status = 'reserved';
      row.bug_report_id = bugReportId;
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 1 } };
  }
}

function envWithDb(db: D1DatabaseLike): BBEEnv {
  return {
    BBE_DB: db,
    RESEND_API_KEY: 'fake',
  };
}

describe('claimCode', () => {
  it('reserves a code when no duplicate race exists', async () => {
    const db = new ClaimRaceDb(false);

    const code = await claimCode(envWithDb(db), '123', 'reporter@example.com');

    expect(code).toBe('CODEA');
    expect(db.rows.filter((r) => r.bug_report_id === '123')).toHaveLength(1);
  });

  it('does not reserve a second code when the same bug is claimed concurrently', async () => {
    const db = new ClaimRaceDb(true);

    const code = await claimCode(envWithDb(db), '123', 'reporter@example.com');

    expect(code).toBeNull();
    expect(db.rows.filter((r) => r.bug_report_id === '123')).toEqual([
      { code: 'CODEB', status: 'reserved', bug_report_id: '123' },
    ]);
    expect(db.rows.find((r) => r.code === 'CODEA')?.status).toBe('available');
  });
});

describe('fetchReporterEmailFromIssue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts locale from the device-info table emitted by formatIssueBody', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        body: [
          '**Contact Email:** reporter@example.com',
          '',
          '## Device Info',
          '',
          '| Field | Value |',
          '|-------|-------|',
          '| Locale | de_DE |',
        ].join('\n'),
      }),
    })));

    const result = await fetchReporterEmailFromIssue({
      BBE_DB: new ClaimRaceDb(false),
      RESEND_API_KEY: 'fake',
      GITHUB_TOKEN: 'token',
      GITHUB_REPO: 'Owner/Repo',
    }, 42);

    expect(result).toEqual({
      email: 'reporter@example.com',
      gameLanguage: null,
      locale: 'de_DE',
    });
  });

  it('still supports legacy bold Game Language and Locale fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        body: [
          '**Contact Email:** reporter@example.com',
          '**Game Language:** pt',
          '**Locale:** pt_PT',
        ].join('\n'),
      }),
    })));

    const result = await fetchReporterEmailFromIssue({
      BBE_DB: new ClaimRaceDb(false),
      RESEND_API_KEY: 'fake',
      GITHUB_TOKEN: 'token',
      GITHUB_REPO: 'Owner/Repo',
    }, 42);

    expect(result).toEqual({
      email: 'reporter@example.com',
      gameLanguage: 'pt',
      locale: 'pt_PT',
    });
  });
});

// ---------------------------------------------------------------------------
// BUG-REWARD-EMAIL-OVERHAUL-001 (Option C)
// ---------------------------------------------------------------------------

describe('renderRewardEmail (Option C single template)', () => {
  it('contains the redeem button, warning paragraph, and confirmation ID', () => {
    const out = renderRewardEmail({
      code: 'TESTCODE1234',
      redeemUrl: 'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=TESTCODE1234',
      issueNumber: 999,
      expirationISO: '2026-10-24',
      locale: 'en',
      confirmationId: 'BUG-2026-05-09-ABC123',
    });

    // Subject is the locked English subject
    expect(out.subject).toBe('Your fix shipped — and a thank-you from Sorting History');

    // Redeem button (anchor) renders the offer-codes URL
    expect(out.html).toContain('href="https://apps.apple.com/redeem?ctx=offercodes&amp;id=6760428599&amp;code=TESTCODE1234"');
    expect(out.html).toContain('Redeem code');

    // Warning paragraph is present + the bold "Important" line
    expect(out.html).toContain('Important');
    expect(out.html).toContain('Apple');
    expect(out.html).toContain('silently ignore');
    expect(out.html).toContain('AFTER your current trial ends');

    // Confirmation ID surfaces in the body (not the legacy "Bug #" reference)
    expect(out.html).toContain('BUG-2026-05-09-ABC123');
    expect(out.html).not.toContain('Bug #999');

    // Plain-text version mirrors the structure
    expect(out.text).toContain('Important');
    expect(out.text).toContain('TESTCODE1234');
    expect(out.text).toContain('BUG-2026-05-09-ABC123');
  });

  it('falls back to "Bug #<n>" when no confirmationId is provided', () => {
    const out = renderRewardEmail({
      code: 'CODE',
      redeemUrl: 'https://apps.apple.com/redeem?ctx=offercodes&code=CODE',
      issueNumber: 42,
      expirationISO: '2026-10-24',
      locale: 'en',
    });
    expect(out.html).toContain('Bug #42');
    expect(out.text).toContain('Bug #42');
  });

  it('does NOT contain any legacy TestFlight-vs-App-Store install copy', () => {
    const out = renderRewardEmail({
      code: 'CODE',
      redeemUrl: 'https://apps.apple.com/redeem?ctx=offercodes&code=CODE',
      issueNumber: 1,
      expirationISO: '2026-10-24',
      locale: 'en',
    });
    expect(out.html).not.toMatch(/TestFlight/i);
    expect(out.html).not.toMatch(/Before redeeming this code/i);
    expect(out.html).not.toMatch(/force-quit/i);
    expect(out.text).not.toMatch(/TestFlight/i);
  });

  it('ignores locale and always renders the English template (Option C)', () => {
    const en = renderRewardEmail({
      code: 'C', redeemUrl: 'https://x', issueNumber: 1,
      expirationISO: '2026-10-24', locale: 'en',
    });
    const de = renderRewardEmail({
      code: 'C', redeemUrl: 'https://x', issueNumber: 1,
      expirationISO: '2026-10-24', locale: 'de',
    });
    expect(de.subject).toBe(en.subject);
    expect(de.html).toBe(en.html);
  });
});

// Minimal fake DB sufficient for dispatchReward end-to-end label-trigger tests.
class MiniBbeDb implements D1DatabaseLike {
  rows: { code: string; status: string; bug_report_id: string | null; recipient_email: string | null }[] = [
    { code: 'BBETEST001', status: 'available', bug_report_id: null, recipient_email: null },
  ];
  audits: { event: string; bug_report_id: string | null; code: string | null }[] = [];
  prepare(query: string): D1PreparedStatementLike {
    return new MiniStmt(this, query);
  }
}
class MiniStmt implements D1PreparedStatementLike {
  private values: unknown[] = [];
  constructor(private db: MiniBbeDb, private q: string) {}
  bind(...v: unknown[]): D1PreparedStatementLike { this.values = v; return this; }
  async first<T = unknown>(): Promise<T | null> {
    if (this.q.includes('SELECT code FROM bug_bounty_codes') && this.q.includes('WHERE bug_report_id')) {
      const id = String(this.values[0]);
      const row = this.db.rows.find(r => r.bug_report_id === id && ['reserved','used'].includes(r.status));
      return (row ? { code: row.code } : null) as T | null;
    }
    if (this.q.includes("WHERE status = 'available'")) {
      const row = this.db.rows.find(r => r.status === 'available');
      return (row ? { code: row.code } : null) as T | null;
    }
    return null;
  }
  async all<T = unknown>(): Promise<D1Result<T>> { return { results: [] }; }
  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.q.includes('UPDATE bug_bounty_codes') && this.q.includes("status = 'reserved'") && this.q.includes("status = 'available'")) {
      const code = String(this.values[3]);
      const id = String(this.values[2]);
      const row = this.db.rows.find(r => r.code === code && r.status === 'available');
      if (!row) return { meta: { changes: 0 } };
      row.status = 'reserved';
      row.bug_report_id = id;
      row.recipient_email = String(this.values[1]);
      return { meta: { changes: 1 } };
    }
    if (this.q.includes("status = 'used'")) {
      const code = String(this.values[1]);
      const row = this.db.rows.find(r => r.code === code && r.status === 'reserved');
      if (row) row.status = 'used';
      return { meta: { changes: 1 } };
    }
    if (this.q.includes('INSERT INTO bug_bounty_audit')) {
      this.db.audits.push({
        event: String(this.values[1]),
        code: this.values[2] == null ? null : String(this.values[2]),
        bug_report_id: this.values[4] == null ? null : String(this.values[4]),
      });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

describe('dispatchReward trigger gate (Option C)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function envFor(db: MiniBbeDb): BBEEnv {
    return {
      BBE_DB: db,
      RESEND_API_KEY: 'fake',
      BBE_REDEEM_BASE: 'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=',
    };
  }

  it('does NOT dispatch on the legacy approved-for-fix label', async () => {
    const db = new MiniBbeDb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await dispatchReward(envFor(db), {
      issueNumber: 101,
      labels: ['approved-for-fix'],
      recipientEmail: 'reporter@example.com',
    });

    expect(result.status).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('available');
  });

  it('does NOT dispatch on the legacy approved label', async () => {
    const db = new MiniBbeDb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await dispatchReward(envFor(db), {
      issueNumber: 102,
      labels: ['approved'],
      recipientEmail: 'reporter@example.com',
    });

    expect(result.status).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DOES dispatch on the new reward-approved label', async () => {
    const db = new MiniBbeDb();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));

    const result = await dispatchReward(envFor(db), {
      issueNumber: 103,
      labels: ['reward-approved'],
      recipientEmail: 'reporter@example.com',
    });

    expect(result.status).toBe('sent');
    expect(result.code).toBe('BBETEST001');
    expect(db.rows[0].status).toBe('used');
  });

  it('is idempotent on re-applying reward-approved (uses existing DB row check)', async () => {
    const db = new MiniBbeDb();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));

    const first = await dispatchReward(envFor(db), {
      issueNumber: 104,
      labels: ['reward-approved'],
      recipientEmail: 'reporter@example.com',
    });
    expect(first.status).toBe('sent');

    const second = await dispatchReward(envFor(db), {
      issueNumber: 104,
      labels: ['reward-approved'],
      recipientEmail: 'reporter@example.com',
    });
    expect(second.status).toBe('duplicate');
    expect(second.code).toBe('BBETEST001');
    // Still only one row used; no second send
    expect(db.rows.filter(r => r.status === 'used')).toHaveLength(1);
  });

  it('respects the no-reward opt-out even when reward-approved is present', async () => {
    const db = new MiniBbeDb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await dispatchReward(envFor(db), {
      issueNumber: 105,
      labels: ['reward-approved', 'no-reward'],
      recipientEmail: 'reporter@example.com',
    });

    expect(result.status).toBe('opted-out');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rows[0].status).toBe('available');
  });
});
