/**
 * BBE-003 regression: pin the intake "thank you" email copy.
 *
 * The intake `sendThankYouEmail` in `src/index.ts` lives inside the default-
 * export object and is not directly importable for unit testing. Per the
 * BBE-001 AC5 regression test pattern from the private worktree
 * (`SortingHistory/workers/bug-webhook/src/bbe.test.ts:504`), we read the
 * source file as text and assert canonical phrases are present + stale
 * phrases are absent, in all 5 supported locales (en/de/nl/pt/es-419).
 *
 * Also asserts:
 *   - `bbeReserveIntakeCode` is wired into `sendThankYouEmail`
 *   - `bbeMarkUsed` and `bbeReleaseCode` are called to settle the reservation
 *   - the BBE-002 label-trigger handler is left in place as a safety-net
 *
 * Plus a unit test of the new `reserveIntakeCode` helper in `bbe.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  reserveIntakeCode,
  initSchemaAndImport,
  type BBEEnv,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1Result,
} from './bbe';

const INDEX_TS = readFileSync(join(__dirname, 'index.ts'), 'utf8');

describe('BBE-003: intake thank-you copy pinning (5 locales)', () => {
  it('en: contains canonical "two months" copy', () => {
    expect(INDEX_TS).toMatch(/two months free Historian access/);
    expect(INDEX_TS).toMatch(/2 months of Historian on us/);
  });
  it('de: contains canonical "2 Monate" copy', () => {
    expect(INDEX_TS).toMatch(/2 Monate kostenlosen \$\{tierName\}-Zugang/);
    expect(INDEX_TS).toMatch(/2 Monate Historiker gehen auf uns/);
  });
  it('pt: contains canonical "2 meses" copy', () => {
    expect(INDEX_TS).toMatch(/2 meses gr\\u00E1tis de acesso \$\{tierName\}/);
    expect(INDEX_TS).toMatch(/2 meses de Historiador por conta da casa/);
  });
  it('nl: contains canonical "2 maanden" copy', () => {
    expect(INDEX_TS).toMatch(/2 maanden gratis \$\{tierName\}-toegang/);
    expect(INDEX_TS).toMatch(/2 maanden Historicus van ons/);
  });
  it('es: contains canonical "2 meses" copy', () => {
    expect(INDEX_TS).toMatch(/2 meses gratis de acceso \$\{tierName\}/);
    expect(INDEX_TS).toMatch(/2 meses de Historiador de regalo/);
  });

  it('does NOT contain stale "one month" copy in any locale (AC5 regression)', () => {
    expect(INDEX_TS).not.toMatch(/one month of Historian access/);
    expect(INDEX_TS).not.toMatch(/einen Monat Historian-Zugang/);
    expect(INDEX_TS).not.toMatch(/einen Monat Historiker-Zugang/);
    expect(INDEX_TS).not.toMatch(/um m\\u00EAs de acesso Historian/);
    expect(INDEX_TS).not.toMatch(/een maand Historian-toegang/);
    expect(INDEX_TS).not.toMatch(/un mes de acceso Historian/);
  });

  it('does NOT contain the stale FR-160 subject line ("feedback")', () => {
    // Old subject was "Thank you for your feedback - Sorting History".
    // BBE-003 subject mentions "bug report" + "Historian on us".
    expect(INDEX_TS).not.toMatch(/Thank you for your feedback \\u2014 Sorting History/);
  });
});

describe('BBE-003: intake email wiring', () => {
  it('sendThankYouEmail reserves a code via bbeReserveIntakeCode', () => {
    expect(INDEX_TS).toMatch(/reservation = await bbeReserveIntakeCode\(/);
  });
  it('sendThankYouEmail marks the code used on Resend success', () => {
    expect(INDEX_TS).toMatch(/await bbeMarkUsed\(env2, reservation\.code\)/);
  });
  it('sendThankYouEmail releases the code on Resend failure', () => {
    expect(INDEX_TS).toMatch(/await bbeReleaseCode\(env2, reservation\.code,/);
  });
  it('intake email body embeds reservation.code and reservation.redeemUrl', () => {
    expect(INDEX_TS).toMatch(/escHtml\(reservation\.code\)/);
    expect(INDEX_TS).toMatch(/escHtml\(reservation\.redeemUrl\)/);
  });
  it('text/plain alternative is sent alongside HTML in intake email', () => {
    // Locate the sendThankYouEmail function and verify its Resend payload
    // includes both `html` and `text` fields (so non-HTML mail clients see
    // the code + redeem URL).
    const fnStart = INDEX_TS.indexOf('async sendThankYouEmail(');
    expect(fnStart).toBeGreaterThan(0);
    // Find the next function definition to bound the slice.
    const fnEnd = INDEX_TS.indexOf('async sendOwnerNotifyEmail(', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const fnBody = INDEX_TS.slice(fnStart, fnEnd);
    expect(fnBody).toMatch(/html,\s*\n\s*text,/);
    // And the text body is constructed (not just an empty placeholder).
    expect(fnBody).toMatch(/const text = \[/);
  });
  it('label-trigger BBE-002 handler is preserved as safety-net', () => {
    // bbeDispatchReward should still be called on issues.labeled events.
    // Duplicate-protection inside claimCode prevents double-burn.
    expect(INDEX_TS).toMatch(/bbeDispatchReward\(env2, \{/);
    expect(INDEX_TS).toMatch(/labelName === 'approved-for-fix'/);
  });
});

// ---------------------------------------------------------------------------
// reserveIntakeCode unit test
// ---------------------------------------------------------------------------

class FakeDb implements D1DatabaseLike {
  rows: { code: string; status: string; bug_report_id: string | null }[] = [
    { code: 'TESTCODE001', status: 'available', bug_report_id: null },
    { code: 'TESTCODE002', status: 'available', bug_report_id: null },
  ];
  audit: { event: string; code?: string }[] = [];
  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query);
  }
}

class FakeStmt implements D1PreparedStatementLike {
  private values: unknown[] = [];
  constructor(private db: FakeDb, private query: string) {}
  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes('SELECT COUNT(*) AS n FROM bug_bounty_codes')) {
      return { n: this.db.rows.length } as unknown as T;
    }
    if (this.query.includes('WHERE bug_report_id = ?')) {
      const id = String(this.values[0]);
      const row = this.db.rows.find(
        (r) => r.bug_report_id === id && ['reserved', 'used'].includes(r.status)
      );
      return (row ? { code: row.code } : null) as T | null;
    }
    if (this.query.includes("WHERE status = 'available'")) {
      const row = this.db.rows.find((r) => r.status === 'available');
      return (row ? { code: row.code } : null) as T | null;
    }
    return null;
  }
  async all<T = unknown>(): Promise<D1Result<T>> { return { results: [] }; }
  async run<T = unknown>(): Promise<D1Result<T>> {
    if (this.query.includes('UPDATE bug_bounty_codes') && this.query.includes("status = 'reserved'")) {
      const candidate = String(this.values[3]);
      const bugReportId = String(this.values[2]);
      const row = this.db.rows.find((r) => r.code === candidate && r.status === 'available');
      if (row) {
        row.status = 'reserved';
        row.bug_report_id = bugReportId;
        return { meta: { changes: 1 } } as D1Result<T>;
      }
      return { meta: { changes: 0 } } as D1Result<T>;
    }
    if (this.query.includes('INSERT INTO bug_bounty_audit')) {
      this.db.audit.push({ event: String(this.values[1]), code: this.values[2] as string | undefined });
      return { meta: { changes: 1 } } as D1Result<T>;
    }
    return { meta: { changes: 0 } } as D1Result<T>;
  }
}

function makeEnv(db: D1DatabaseLike): BBEEnv {
  return {
    BBE_DB: db,
    RESEND_API_KEY: 'test-key',
    BBE_BATCH_EXPIRATION: '2026-10-24',
    BBE_REDEEM_BASE: 'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=',
  };
}

describe('BBE-003: reserveIntakeCode', () => {
  it('reserves a code and returns code+redeemUrl+expirationISO', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const result = await reserveIntakeCode(env, '250', 'reporter@example.com');
    expect(result).not.toBeNull();
    expect(result!.code).toBe('TESTCODE001');
    expect(result!.redeemUrl).toBe(
      'https://apps.apple.com/redeem?ctx=offercodes&id=6760428599&code=TESTCODE001'
    );
    expect(result!.expirationISO).toBe('2026-10-24');
    expect(db.rows[0].status).toBe('reserved');
    expect(db.rows[0].bug_report_id).toBe('250');
  });

  it('returns null on duplicate (same bug_report_id)', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const first = await reserveIntakeCode(env, '250', 'reporter@example.com');
    expect(first).not.toBeNull();
    const second = await reserveIntakeCode(env, '250', 'reporter@example.com');
    expect(second).toBeNull();
    // Pool inventory unchanged after duplicate request
    const stillAvailable = db.rows.filter((r) => r.status === 'available').length;
    expect(stillAvailable).toBe(1);
  });

  it('initSchemaAndImport is a no-op when codes already loaded', async () => {
    const db = new FakeDb();
    const env = makeEnv(db);
    const imported = await initSchemaAndImport(env);
    expect(imported).toBe(0);
  });
});
