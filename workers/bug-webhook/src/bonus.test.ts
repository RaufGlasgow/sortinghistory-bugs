import { describe, expect, it, beforeEach } from 'vitest';
import {
  initBonusSchema,
  grantBonus,
  resolveBonusState,
  generateClaimToken,
  verifyClaimToken,
  issueClaimToken,
  claimBonusForDevice,
  dispatchBonus,
  identityHashForEmail,
  renderBonusClaimEmail,
  type BonusEnv,
} from './bonus';
import type { D1DatabaseLike, D1PreparedStatementLike, D1Result } from './bbe';

// ---------------------------------------------------------------------------
// In-memory D1 mock — supports the SQL subset used by bonus.ts.
//
// Tables modeled: historian_bonus_grants, historian_bonus_claims,
// historian_bonus_state. Supports prepared statements with `?` binds for
// the exact queries bonus.ts issues. Not a general-purpose SQLite — just
// enough to exercise the module under test.
// ---------------------------------------------------------------------------

interface GrantRow {
  id: number;
  granted_at: number;
  identity_hash: string;
  email_plaintext: string;
  bug_report_id: string;
  github_issue_num: number | null;
  months_added: number;
  reason: string | null;
  granted_by: string;
}

interface ClaimRow {
  token: string;
  grant_id: number;
  identity_hash: string;
  issued_at: number;
  expires_at: number;
  claimed_at: number | null;
  claimed_device_id: string | null;
  revoked_at: number | null;
}

interface StateRow {
  identity_hash: string;
  bonus_until: number;
  total_months: number;
  lifetime_grants: number;
  last_bug_report_id: string | null;
  updated_at: number;
}

class FakeD1 implements D1DatabaseLike {
  grants: GrantRow[] = [];
  claims: ClaimRow[] = [];
  state: StateRow[] = [];
  private nextGrantId = 1;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStmt(this, query);
  }
}

class FakeStmt implements D1PreparedStatementLike {
  private values: unknown[] = [];
  constructor(private readonly db: FakeD1, private readonly q: string) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const q = this.q;

    // SELECT * FROM historian_bonus_grants WHERE bug_report_id = ? AND identity_hash = ?
    if (q.includes('FROM historian_bonus_grants') && q.includes('bug_report_id = ?') && q.includes('identity_hash = ?')) {
      const [bug, ih] = this.values as [string, string];
      const row = this.db.grants.find((g) => g.bug_report_id === bug && g.identity_hash === ih);
      return (row ?? null) as T | null;
    }

    // SELECT * FROM historian_bonus_grants WHERE id = ?
    if (q.includes('FROM historian_bonus_grants') && q.includes('WHERE id = ?')) {
      const [id] = this.values as [number];
      const row = this.db.grants.find((g) => g.id === id);
      return (row ?? null) as T | null;
    }

    // SELECT * FROM historian_bonus_state WHERE identity_hash = ?
    if (q.includes('FROM historian_bonus_state') && q.includes('identity_hash = ?')) {
      const [ih] = this.values as [string];
      const row = this.db.state.find((s) => s.identity_hash === ih);
      return (row ?? null) as T | null;
    }

    // SELECT * FROM historian_bonus_claims WHERE token = ?
    if (q.includes('FROM historian_bonus_claims') && q.includes('WHERE token = ?')) {
      const [token] = this.values as [string];
      const row = this.db.claims.find((c) => c.token === token);
      return (row ?? null) as T | null;
    }

    // Latest grant by identity (lookup-by-email path)
    if (q.includes('FROM historian_bonus_grants') && q.includes('ORDER BY granted_at DESC')) {
      const [ih] = this.values as [string];
      const rows = this.db.grants.filter((g) => g.identity_hash === ih)
        .sort((a, b) => b.granted_at - a.granted_at);
      return (rows[0] ?? null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const q = this.q;
    // SELECT * FROM historian_bonus_grants WHERE identity_hash = ? ORDER BY granted_at ASC
    if (q.includes('FROM historian_bonus_grants') && q.includes('ORDER BY granted_at ASC')) {
      const [ih] = this.values as [string];
      const rows = this.db.grants.filter((g) => g.identity_hash === ih)
        .sort((a, b) => a.granted_at - b.granted_at);
      return { results: rows as unknown as T[] };
    }
    return { results: [] };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const q = this.q;

    // CREATE TABLE / CREATE INDEX — no-op for the mock.
    if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
      return { meta: { changes: 0 } };
    }

    // INSERT INTO historian_bonus_grants ... 8 binds
    if (q.includes('INSERT INTO historian_bonus_grants')) {
      const [granted_at, identity_hash, email_plaintext, bug_report_id, github_issue_num, months_added, reason, granted_by] =
        this.values as [number, string, string, string, number | null, number, string | null, string];
      // UNIQUE(bug_report_id, identity_hash)
      const exists = this.db.grants.some((g) => g.bug_report_id === bug_report_id && g.identity_hash === identity_hash);
      if (exists) {
        throw new Error('UNIQUE constraint failed: historian_bonus_grants.bug_report_id, historian_bonus_grants.identity_hash');
      }
      const id = (this.db['nextGrantId'] as number);
      (this.db as unknown as { nextGrantId: number }).nextGrantId = id + 1;
      this.db.grants.push({
        id,
        granted_at,
        identity_hash,
        email_plaintext,
        bug_report_id,
        github_issue_num,
        months_added,
        reason,
        granted_by,
      });
      return { meta: { changes: 1, last_row_id: id } };
    }

    // INSERT INTO historian_bonus_state ... ON CONFLICT DO UPDATE
    if (q.includes('INSERT INTO historian_bonus_state')) {
      const [identity_hash, bonus_until, total_months, lifetime_grants, last_bug_report_id, updated_at] =
        this.values as [string, number, number, number, string | null, number];
      const existing = this.db.state.find((s) => s.identity_hash === identity_hash);
      if (existing) {
        existing.bonus_until = bonus_until;
        existing.total_months = total_months;
        existing.lifetime_grants = lifetime_grants;
        existing.last_bug_report_id = last_bug_report_id;
        existing.updated_at = updated_at;
      } else {
        this.db.state.push({ identity_hash, bonus_until, total_months, lifetime_grants, last_bug_report_id, updated_at });
      }
      return { meta: { changes: 1 } };
    }

    // INSERT INTO historian_bonus_claims
    if (q.includes('INSERT INTO historian_bonus_claims')) {
      const [token, grant_id, identity_hash, issued_at, expires_at] =
        this.values as [string, number, string, number, number];
      this.db.claims.push({
        token, grant_id, identity_hash, issued_at, expires_at,
        claimed_at: null, claimed_device_id: null, revoked_at: null,
      });
      return { meta: { changes: 1 } };
    }

    // UPDATE historian_bonus_claims SET claimed_at = ?, claimed_device_id = ? WHERE token = ? AND claimed_at IS NULL
    if (q.includes('UPDATE historian_bonus_claims') && q.includes('SET claimed_at')) {
      const [claimed_at, device_id, token] = this.values as [number, string | null, string];
      const row = this.db.claims.find((c) => c.token === token && c.claimed_at === null);
      if (!row) return { meta: { changes: 0 } };
      row.claimed_at = claimed_at;
      row.claimed_device_id = device_id;
      return { meta: { changes: 1 } };
    }

    // UPDATE historian_bonus_claims SET revoked_at
    if (q.includes('UPDATE historian_bonus_claims') && q.includes('SET revoked_at')) {
      const [revoked_at, token] = this.values as [number, string];
      const row = this.db.claims.find((c) => c.token === token && c.revoked_at === null);
      if (!row) return { meta: { changes: 0 } };
      row.revoked_at = revoked_at;
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 0 } };
  }
}

function makeEnv(): BonusEnv & { db: FakeD1 } {
  const db = new FakeD1();
  return {
    db,
    BBE_DB: db,
    BONUS_CLAIM_HMAC_SECRET: 'test-secret-do-not-use-in-prod',
    BONUS_CLAIM_BASE_URL: 'https://sortinghistory.com',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bonus: HMAC claim tokens', () => {
  it('signs and verifies a fresh token', async () => {
    const env = makeEnv();
    const ih = await identityHashForEmail('alice@example.com');
    const { token } = await generateClaimToken(env, 42, ih, 30);
    const verified = await verifyClaimToken(env, token);
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.payload.gid).toBe(42);
      expect(verified.payload.ih).toBe(ih);
      expect(verified.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('rejects a tampered payload', async () => {
    const env = makeEnv();
    const { token } = await generateClaimToken(env, 1, 'x'.repeat(64), 30);
    const [payload, sig] = token.split('.');
    // Mutate a single character in the payload — signature must reject.
    const mutated = `${payload.slice(0, payload.length - 1)}${payload.endsWith('A') ? 'B' : 'A'}.${sig}`;
    const verified = await verifyClaimToken(env, mutated);
    expect(verified.valid).toBe(false);
    if (!verified.valid) {
      expect(['bad_signature', 'malformed']).toContain(verified.reason);
    }
  });

  it('rejects an expired token', async () => {
    const env = makeEnv();
    // ttl = -1 day → token born already-expired.
    const { token } = await generateClaimToken(env, 1, 'a'.repeat(64), -1);
    const verified = await verifyClaimToken(env, token);
    expect(verified.valid).toBe(false);
    if (!verified.valid) expect(verified.reason).toBe('expired');
  });

  it('rejects malformed tokens', async () => {
    const env = makeEnv();
    const v1 = await verifyClaimToken(env, 'not.a.real.token');
    expect(v1.valid).toBe(false);
    const v2 = await verifyClaimToken(env, '!!!.!!!');
    expect(v2.valid).toBe(false);
  });
});

describe('bonus: grantBonus idempotency', () => {
  let env: BonusEnv & { db: FakeD1 };
  beforeEach(async () => {
    env = makeEnv();
    await initBonusSchema(env);
  });

  it('second grant for same (bug, identity) returns existing, does not double-add', async () => {
    const r1 = await grantBonus(env, {
      bug_report_id: 'BUG-AAA',
      email: 'alice@example.com',
      months_added: 2,
      granted_by: 'test',
    });
    expect(r1.idempotent).toBe(false);
    expect(r1.state.lifetime_grants).toBe(1);
    expect(r1.state.total_months).toBe(2);
    const firstUntil = r1.state.bonus_until;

    const r2 = await grantBonus(env, {
      bug_report_id: 'BUG-AAA',
      email: 'alice@example.com',
      months_added: 2,
      granted_by: 'test',
    });
    expect(r2.idempotent).toBe(true);
    expect(r2.grant.id).toBe(r1.grant.id);
    expect(r2.state.bonus_until).toBe(firstUntil);
    expect(r2.state.lifetime_grants).toBe(1);
    expect(env.db.grants.length).toBe(1);
  });

  it('email case + whitespace normalize to same identity', async () => {
    await grantBonus(env, { bug_report_id: 'BUG-CCC', email: 'Bob@Example.com', months_added: 2, granted_by: 'test' });
    const r = await grantBonus(env, { bug_report_id: 'BUG-CCC', email: '  bob@example.com  ', months_added: 2, granted_by: 'test' });
    expect(r.idempotent).toBe(true);
    expect(env.db.grants.length).toBe(1);
  });
});

describe('bonus: resolveBonusState additive stacking', () => {
  let env: BonusEnv & { db: FakeD1 };
  beforeEach(async () => {
    env = makeEnv();
    await initBonusSchema(env);
  });

  it('stacks two grants from now-anchored chain', async () => {
    const r1 = await grantBonus(env, { bug_report_id: 'BUG-1', email: 'c@example.com', months_added: 2, granted_by: 'test' });
    const r2 = await grantBonus(env, { bug_report_id: 'BUG-2', email: 'c@example.com', months_added: 2, granted_by: 'test' });
    expect(r2.idempotent).toBe(false);
    expect(r2.state.lifetime_grants).toBe(2);
    expect(r2.state.total_months).toBe(4);
    // Second grant base = max(now, r1.bonus_until) which is r1.bonus_until (still future).
    expect(r2.state.bonus_until).toBeGreaterThan(r1.state.bonus_until);
    expect(r2.state.bonus_until - r1.state.bonus_until).toBeGreaterThanOrEqual(2 * 30 * 86400 - 5);

    const resolved = await resolveBonusState(env, r2.state.identity_hash);
    expect(resolved).not.toBeNull();
    expect(resolved!.is_active).toBe(true);
    expect(resolved!.lifetime_grants).toBe(2);
  });

  it('returns null for unknown identity', async () => {
    const r = await resolveBonusState(env, 'f'.repeat(64));
    expect(r).toBeNull();
  });
});

describe('bonus: end-to-end dispatch + claim flow', () => {
  let env: BonusEnv & { db: FakeD1 };
  beforeEach(async () => {
    env = makeEnv();
    await initBonusSchema(env);
  });

  it('dispatchBonus skips when reward-approved label missing', async () => {
    const r = await dispatchBonus(env, { issueNumber: 1, labels: ['code-bug'], recipientEmail: 'a@b.com' });
    expect(r.status).toBe('skipped');
  });

  it('dispatchBonus returns no-email when email missing', async () => {
    const r = await dispatchBonus(env, { issueNumber: 1, labels: ['reward-approved'], recipientEmail: '' });
    expect(r.status).toBe('no-email');
  });

  it('dispatchBonus returns opted-out when no-reward label present', async () => {
    const r = await dispatchBonus(env, { issueNumber: 1, labels: ['reward-approved', 'no-reward'], recipientEmail: 'a@b.com' });
    expect(r.status).toBe('opted-out');
  });

  it('claim flow: grant -> issue token -> claim with device -> state active', async () => {
    const g = await grantBonus(env, { bug_report_id: 'BUG-XYZ', email: 'd@example.com', months_added: 2, granted_by: 'test' });
    const issued = await issueClaimToken(env, g.grant, 30);
    expect(issued.token).toBeTruthy();
    expect(issued.claim_url).toContain('/claim/');

    const claimed = await claimBonusForDevice(env, issued.token, 'IDFV-DEVICE-1');
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimed.state.is_active).toBe(true);
      expect(claimed.bonus_until).toBe(g.state.bonus_until);
    }

    // Re-claim from a DIFFERENT device → already_claimed.
    const reclaimed = await claimBonusForDevice(env, issued.token, 'IDFV-DEVICE-2');
    expect(reclaimed.ok).toBe(false);
    if (!reclaimed.ok) expect(reclaimed.reason).toBe('already_claimed');

    // Same device re-claim → idempotent success.
    const idem = await claimBonusForDevice(env, issued.token, 'IDFV-DEVICE-1');
    expect(idem.ok).toBe(true);
  });

  it('renderBonusClaimEmail produces compback subject when isCompback set', () => {
    const r = renderBonusClaimEmail({
      to: 'x@y.com',
      claimUrl: 'https://sortinghistory.com/claim/abc',
      bonusUntilISO: '2026-07-22',
      refId: 'BUG-FOO',
      isCompback: true,
    });
    expect(r.subject).toContain('We owe you');
    expect(r.text).toContain('BUG-FOO');
    expect(r.html).toContain('https://sortinghistory.com/claim/abc');
  });

  it('renderBonusClaimEmail produces standard subject by default', () => {
    const r = renderBonusClaimEmail({
      to: 'x@y.com',
      claimUrl: 'https://sortinghistory.com/claim/abc',
      bonusUntilISO: '2026-07-22',
      refId: 'BUG-FOO',
    });
    expect(r.subject).toContain('shipped');
    expect(r.subject).toContain('Historian');
  });
});
