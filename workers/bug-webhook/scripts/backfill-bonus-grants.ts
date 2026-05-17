#!/usr/bin/env -S npx tsx
/**
 * BUG-267A — Retroactive comp-back backfill script.
 *
 * Enumerates every GH issue ever labeled `reward-email-sent` (the BBE-002
 * label that marks "we sent an offer code to this reporter") and posts a
 * grant to /api/bonus/grant for each. Idempotent via the UNIQUE constraint
 * on (bug_report_id, identity_hash) — safe to re-run.
 *
 * Usage:
 *   # dry run (default) — prints what would be granted, no DB writes
 *   GITHUB_TOKEN=ghp_xxx BBE_ADMIN_TOKEN=xxx BONUS_API_BASE=https://sortinghistory.com \
 *     npx tsx workers/bug-webhook/scripts/backfill-bonus-grants.ts
 *
 *   # apply
 *   ... --apply
 *
 * Required env:
 *   GITHUB_TOKEN       PAT with issues:read on RaufGlasgow/Sorting-History
 *   BBE_ADMIN_TOKEN    Worker admin token (same one used for /api/bbe/*)
 *   BONUS_API_BASE     e.g. https://sortinghistory.com
 *
 * Optional env:
 *   GITHUB_REPO        Default RaufGlasgow/Sorting-History
 *   MONTHS_ADDED       Default 2
 *   SEND_CLAIM_EMAIL   Default 'true' — sends comp-back email on apply.
 *                      Set to 'false' to grant silently (no email).
 *
 * Architect spec: docs/architecture/BUG-267A-SERVER-GRANTED-REWARD-ARCHITECT-DESIGN.md
 * Story:         docs/stories/BUG-267A.story.bug-reward-code-fails-to-extend-trial.md
 */

interface GHIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  created_at: string;
}

interface BackfillCandidate {
  issueNumber: number;
  title: string;
  email: string;
  confirmationId: string;
  createdAt: string;
}

interface BackfillResult {
  candidate: BackfillCandidate;
  posted: boolean;
  idempotent: boolean | null;
  grantId?: number;
  error?: string;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'RaufGlasgow/Sorting-History';
const BBE_ADMIN_TOKEN = process.env.BBE_ADMIN_TOKEN;
const BONUS_API_BASE = (process.env.BONUS_API_BASE || 'https://sortinghistory.com').replace(/\/$/, '');
const MONTHS_ADDED = Number.parseInt(process.env.MONTHS_ADDED || '2', 10);
const SEND_CLAIM_EMAIL = (process.env.SEND_CLAIM_EMAIL || 'true').toLowerCase() !== 'false';
const APPLY = process.argv.includes('--apply');

function fail(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

if (!GITHUB_TOKEN) fail('GITHUB_TOKEN required');
if (!BBE_ADMIN_TOKEN) fail('BBE_ADMIN_TOKEN required');
if (!Number.isFinite(MONTHS_ADDED) || MONTHS_ADDED <= 0) fail(`MONTHS_ADDED invalid: ${MONTHS_ADDED}`);

async function ghIssuesWithLabel(label: string): Promise<GHIssue[]> {
  const out: GHIssue[] = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/issues?state=all&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'SortingHistory-Backfill/267A',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      fail(`GitHub list issues page ${page} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const batch = await res.json() as GHIssue[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

function extractEmail(body: string): string | null {
  const m = body.match(/\*\*Contact Email:\*\*\s*(\S+@\S+)/i);
  return m ? m[1].trim() : null;
}

function extractConfirmationId(body: string, fallback: number): string {
  const m = body.match(/BUG-[A-Z0-9]+-[A-Z0-9]+/);
  return m ? m[0] : `BUG-${fallback}`;
}

async function postGrant(c: BackfillCandidate): Promise<{ ok: boolean; idempotent?: boolean; grantId?: number; error?: string }> {
  const res = await fetch(`${BONUS_API_BASE}/api/bonus/grant`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BBE_ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bug_report_id: c.confirmationId,
      email: c.email,
      months_added: MONTHS_ADDED,
      github_issue_num: c.issueNumber,
      reason: `retroactive 267A comp (issue #${c.issueNumber}, created ${c.createdAt})`,
      granted_by: 'migration:267A',
      send_claim_email: SEND_CLAIM_EMAIL,
    }),
  });
  const txt = await res.text();
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
  }
  try {
    const data = JSON.parse(txt) as { ok?: boolean; idempotent?: boolean; grant_id?: number };
    return { ok: !!data.ok, idempotent: data.idempotent, grantId: data.grant_id };
  } catch {
    return { ok: false, error: `unparseable response: ${txt.slice(0, 200)}` };
  }
}

async function main() {
  console.log(`BUG-267A backfill — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Source: ${GITHUB_REPO}, label=reward-email-sent`);
  console.log(`Months added per grant: ${MONTHS_ADDED}`);
  console.log(`Claim email on apply: ${SEND_CLAIM_EMAIL}`);
  console.log('');

  const issues = await ghIssuesWithLabel('reward-email-sent');
  console.log(`Found ${issues.length} issues with reward-email-sent label.`);

  const candidates: BackfillCandidate[] = [];
  const skipped: { issue: number; reason: string }[] = [];

  for (const issue of issues) {
    const body = issue.body || '';
    const email = extractEmail(body);
    if (!email) {
      skipped.push({ issue: issue.number, reason: 'no Contact Email in body' });
      continue;
    }
    const confirmationId = extractConfirmationId(body, issue.number);
    candidates.push({
      issueNumber: issue.number,
      title: issue.title,
      email,
      confirmationId,
      createdAt: issue.created_at,
    });
  }

  console.log('');
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Skipped:    ${skipped.length}`);
  console.log('');

  // Top-N sample for PM review BEFORE apply.
  const SAMPLE_N = 10;
  console.log(`---- Top ${Math.min(SAMPLE_N, candidates.length)} candidates (PM verify before --apply) ----`);
  for (const c of candidates.slice(0, SAMPLE_N)) {
    const masked = c.email.replace(/(.).+(@)/, '$1***$2');
    console.log(`  #${c.issueNumber}  ${c.confirmationId}  ${masked}  ${c.createdAt}  "${c.title.slice(0, 60)}"`);
  }
  if (candidates.length > SAMPLE_N) {
    console.log(`  ... (${candidates.length - SAMPLE_N} more)`);
  }
  if (skipped.length) {
    console.log('');
    console.log(`---- Skipped (no email in body) ----`);
    for (const s of skipped) console.log(`  #${s.issue}  ${s.reason}`);
  }

  if (!APPLY) {
    console.log('');
    console.log('DRY RUN complete. Re-run with --apply to post grants.');
    return;
  }

  console.log('');
  console.log(`---- APPLYING ${candidates.length} grants ----`);
  const results: BackfillResult[] = [];
  for (const c of candidates) {
    const r = await postGrant(c);
    if (r.ok) {
      results.push({ candidate: c, posted: true, idempotent: r.idempotent ?? null, grantId: r.grantId });
      const tag = r.idempotent ? 'IDEMPOTENT' : 'NEW';
      console.log(`  ${tag}  #${c.issueNumber}  ${c.confirmationId}  grant=${r.grantId ?? '?'}`);
    } else {
      results.push({ candidate: c, posted: false, idempotent: null, error: r.error });
      console.log(`  FAILED #${c.issueNumber}  ${c.confirmationId}  ${r.error}`);
    }
  }

  const okCount = results.filter((r) => r.posted).length;
  const newCount = results.filter((r) => r.posted && r.idempotent === false).length;
  const idempotentCount = results.filter((r) => r.posted && r.idempotent === true).length;
  const failedCount = results.filter((r) => !r.posted).length;

  console.log('');
  console.log(`Backfill complete. ok=${okCount} (new=${newCount}, idempotent=${idempotentCount}) failed=${failedCount}`);
}

main().catch((err) => {
  console.error('Backfill threw:', err);
  process.exit(1);
});
