#!/usr/bin/env bash
# Tests for custom PIPE-LINT regex hooks. Pure bash, no framework.
# Each test creates a fixture file and asserts the hook fires (or doesn't).
# Repo-aware: fixture paths are chosen to match the in-scope regex of the
# `check-no-claude-models.sh` script in THIS repo. To port the test to a repo
# with different scope, override the IN_SCOPE_*/OUT_OF_SCOPE_* env vars below.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
LINT_DIR="$(dirname "$HERE")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

assert_fail() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "FAIL: $name (expected non-zero, got 0)"
    FAIL=$((FAIL+1))
  else
    echo "PASS: $name"
    PASS=$((PASS+1))
  fi
}

assert_pass() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $name"
    PASS=$((PASS+1))
  else
    echo "FAIL: $name (expected 0, got non-zero)"
    "$@" || true
    FAIL=$((FAIL+1))
  fi
}

# Repo-aware fixture paths. Defaults match this repo's no-claude scope.
# Game-repo scope: Scripts/(analyze-bug|apply-fix), .github/workflows/(bug-|dispatch-to-bugs)
IN_SCOPE_TS="${IN_SCOPE_TS:-Scripts/analyze-bug-fixture.js}"
IN_SCOPE_TS_BAD="${IN_SCOPE_TS_BAD:-Scripts/analyze-bug-bad-fixture.js}"
IN_SCOPE_WF="${IN_SCOPE_WF:-.github/workflows/bug-fixture.yml}"
IN_SCOPE_MD="${IN_SCOPE_MD:-.github/workflows/bug-notes.md}"
OUT_OF_SCOPE_MD="${OUT_OF_SCOPE_MD:-docs/history.md}"

cd "$TMP" || exit 1
mkdir -p Scripts .github/workflows docs
# Ensure parent dirs exist for override paths.
for f in "$IN_SCOPE_TS" "$IN_SCOPE_TS_BAD" "$IN_SCOPE_WF" "$IN_SCOPE_MD" "$OUT_OF_SCOPE_MD"; do
  mkdir -p "$(dirname "$f")"
done

# === ASCII-IDs hook ===
cat >docs/clean.md <<'EOF'
# BUG-123 fix
- Closes BUG-123 per Section 4.
EOF
assert_pass "ascii-ids: ASCII-only ID passes" "$LINT_DIR/check-ascii-ids.sh" docs/clean.md

printf '# BUG\xe2\x80\x94123 fix\n' >docs/dirty.md
assert_fail "ascii-ids: em-dash in ID line fails" "$LINT_DIR/check-ascii-ids.sh" docs/dirty.md

printf '## See \xc2\xa73.2 BUG-9 detail\n' >docs/dirty2.md
assert_fail "ascii-ids: section sign in heading fails" "$LINT_DIR/check-ascii-ids.sh" docs/dirty2.md

# === No-Claude-Models hook ===
cat >"$IN_SCOPE_TS" <<'EOF'
const model = process.env.LLM_MODEL || 'glm-4.7-flash';
EOF
assert_pass "no-claude: glm reference passes (in-scope)" "$LINT_DIR/check-no-claude-models.sh" "$IN_SCOPE_TS"

cat >"$IN_SCOPE_TS_BAD" <<'EOF'
const model = 'claude-sonnet-4-5';
EOF
assert_fail "no-claude: claude-sonnet fails (in-scope)" "$LINT_DIR/check-no-claude-models.sh" "$IN_SCOPE_TS_BAD"

cat >"$IN_SCOPE_WF" <<'EOF'
env:
  MODEL: opus
EOF
assert_fail "no-claude: bare opus in workflow fails (in-scope)" "$LINT_DIR/check-no-claude-models.sh" "$IN_SCOPE_WF"

cat >"$OUT_OF_SCOPE_MD" <<'EOF'
We used to run on Sonnet but moved off.
EOF
assert_pass "no-claude: out-of-scope docs ignored" "$LINT_DIR/check-no-claude-models.sh" "$OUT_OF_SCOPE_MD"

cat >"$IN_SCOPE_MD" <<'EOF'
We previously called claude-3-opus here.
EOF
assert_pass "no-claude: in-scope .md skipped" "$LINT_DIR/check-no-claude-models.sh" "$IN_SCOPE_MD"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
