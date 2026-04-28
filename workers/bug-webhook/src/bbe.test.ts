import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimCode,
  fetchReporterEmailFromIssue,
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
