#!/usr/bin/env bash
# BUG-PIPE-007: Smoke test for /label/fix, /label/needs-info, /label/ignore routes.
#
# Usage:
#   SMOKE_ISSUE=<github-issue-number> \
#   AUTH_TOKEN=<token> \
#   WORKER_URL=https://bug-webhook.emptycupmedia.workers.dev \
#   bash workers/bug-webhook/scripts/smoke.sh
#
# Required env vars:
#   SMOKE_ISSUE   — GitHub issue number to use as the test target
#   AUTH_TOKEN    — The AUTH_TOKEN wrangler secret (for pipeline email action links)
#
# Optional env vars:
#   WORKER_URL    — Defaults to https://bug-webhook.emptycupmedia.workers.dev
#   GH_REPO       — Defaults to RaufGlasgow/Sorting-History
#
# Pre-condition: The issue must be OPEN before the script runs (it will be closed by
# the /label/ignore test). After the script, re-open the issue and strip labels manually
# (or use: gh issue edit $SMOKE_ISSUE --remove-label approved-for-fix,needs-info,wontfix)
#
# The script exits non-zero on the first failure.

set -euo pipefail

WORKER_URL="${WORKER_URL:-https://bug-webhook.emptycupmedia.workers.dev}"
GH_REPO="${GH_REPO:-RaufGlasgow/Sorting-History}"

if [[ -z "${SMOKE_ISSUE:-}" ]]; then
  echo "ERROR: SMOKE_ISSUE env var is required (GitHub issue number)"
  exit 1
fi

if [[ -z "${AUTH_TOKEN:-}" ]]; then
  echo "ERROR: AUTH_TOKEN env var is required"
  exit 1
fi

ISSUE="$SMOKE_ISSUE"
BASE="${WORKER_URL}"

echo "=== BUG-PIPE-007 smoke test ==="
echo "Worker : $BASE"
echo "Repo   : $GH_REPO"
echo "Issue  : #$ISSUE"
echo ""

# ── Helper ────────────────────────────────────────────────────────────────────

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; exit 1; }

# Fetch a URL and return the HTTP status code
http_status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# Fetch a URL and return the response body
http_body() {
  curl -s "$@"
}

# ── Check 1: Bad token → 401 ─────────────────────────────────────────────────
echo "--- Check 1: bad token → 401 ---"
STATUS=$(http_status "${BASE}/label/fix?issue=${ISSUE}&token=WRONG_TOKEN")
if [[ "$STATUS" == "401" ]]; then
  pass "bad token → 401"
else
  fail "expected 401, got $STATUS"
fi

# ── Check 2: Bad issue → 400 ─────────────────────────────────────────────────
echo "--- Check 2: bad issue param → 400 ---"
STATUS=$(http_status "${BASE}/label/fix?issue=abc&token=${AUTH_TOKEN}")
if [[ "$STATUS" == "400" ]]; then
  pass "bad issue → 400"
else
  fail "expected 400, got $STATUS"
fi

# ── Check 3: POST → 405 ──────────────────────────────────────────────────────
echo "--- Check 3: POST → 405 ---"
STATUS=$(http_status -X POST "${BASE}/label/fix?issue=${ISSUE}&token=${AUTH_TOKEN}")
if [[ "$STATUS" == "405" ]]; then
  pass "POST → 405"
else
  fail "expected 405, got $STATUS"
fi

# ── Check 4: /label/fix → 200 + label applied ────────────────────────────────
echo "--- Check 4: /label/fix → 200, label applied ---"
STATUS=$(http_status "${BASE}/label/fix?issue=${ISSUE}&token=${AUTH_TOKEN}")
if [[ "$STATUS" == "200" ]]; then
  pass "/label/fix → 200"
else
  fail "expected 200, got $STATUS"
fi
# Verify label was applied
if gh issue view "$ISSUE" --repo "$GH_REPO" --json labels --jq '.labels[].name' 2>/dev/null | grep -q "approved-for-fix"; then
  pass "label 'approved-for-fix' found on issue #$ISSUE"
else
  fail "label 'approved-for-fix' NOT found on issue #$ISSUE"
fi

# ── Check 5: /label/needs-info → 200 + label applied ────────────────────────
echo "--- Check 5: /label/needs-info → 200, label applied ---"
STATUS=$(http_status "${BASE}/label/needs-info?issue=${ISSUE}&token=${AUTH_TOKEN}")
if [[ "$STATUS" == "200" ]]; then
  pass "/label/needs-info → 200"
else
  fail "expected 200, got $STATUS"
fi
if gh issue view "$ISSUE" --repo "$GH_REPO" --json labels --jq '.labels[].name' 2>/dev/null | grep -q "needs-info"; then
  pass "label 'needs-info' found on issue #$ISSUE"
else
  fail "label 'needs-info' NOT found on issue #$ISSUE"
fi

# ── Check 6: /label/ignore → 200 + wontfix label + issue closed ──────────────
echo "--- Check 6: /label/ignore → 200, wontfix label, issue closed ---"
STATUS=$(http_status "${BASE}/label/ignore?issue=${ISSUE}&token=${AUTH_TOKEN}")
if [[ "$STATUS" == "200" ]]; then
  pass "/label/ignore → 200"
else
  fail "expected 200, got $STATUS"
fi
if gh issue view "$ISSUE" --repo "$GH_REPO" --json labels --jq '.labels[].name' 2>/dev/null | grep -q "wontfix"; then
  pass "label 'wontfix' found on issue #$ISSUE"
else
  fail "label 'wontfix' NOT found on issue #$ISSUE"
fi
ISSUE_STATE=$(gh issue view "$ISSUE" --repo "$GH_REPO" --json state --jq '.state' 2>/dev/null || echo "unknown")
if [[ "$ISSUE_STATE" == "CLOSED" ]]; then
  pass "issue #$ISSUE is closed"
else
  fail "issue #$ISSUE is not closed (state=$ISSUE_STATE)"
fi

# ── Cleanup instructions ──────────────────────────────────────────────────────
echo ""
echo "=== All checks passed ==="
echo ""
echo "Cleanup (run manually to restore issue for next round):"
echo "  gh issue reopen $ISSUE --repo $GH_REPO"
echo "  gh issue edit $ISSUE --repo $GH_REPO --remove-label approved-for-fix,needs-info,wontfix"
