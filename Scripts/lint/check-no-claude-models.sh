#!/usr/bin/env bash
# PIPE-LINT: ban Claude model names from bug pipeline source paths.
# Rule (CLAUDE.md + memory project_no_sonnet_in_bug_pipeline):
#   Bug pipeline must not depend on Claude. Stack is GLM + Kimi + local/manual.
# Banned tokens (case-insensitive, word-bounded where applicable):
#   claude-*, sonnet, opus, haiku, anthropic SDK references in pipeline code.
#
# Scope: bug pipeline source paths only. Other paths (e.g., docs of past
# decisions, Claude Code harness configs, content/translation tooling) are out
# of scope and pass automatically.
#
# Usage: check-no-claude-models.sh <file1> <file2> ...
# Exits 0 if clean, 1 if any banned token found in scope.

set -u

status=0

# In-scope path prefixes (regex against the path string).
IN_SCOPE_RE='^(workers/bug-webhook/|Scripts/(agent|analyze-bug|apply-fix|review-pr|visual-review)|\.github/workflows/(bug-|agent-|fix-|review-|approve-|rebase-|record-))'

# Banned token patterns (extended regex, case-insensitive).
BANNED_RE='claude-[a-z0-9.-]+|\b(sonnet|opus|haiku)\b|@anthropic-ai/'

for f in "$@"; do
  [ -f "$f" ] || continue
  # Only check in-scope files
  if ! printf '%s\n' "$f" | grep -qE "$IN_SCOPE_RE"; then continue; fi
  # Skip self (this script + sibling lint scripts mention banned words by design)
  case "$f" in Scripts/lint/*) continue ;; esac
  # Skip doc/markdown: explanatory references to past Claude usage are allowed
  case "$f" in *.md) continue ;; esac
  if grep -nEi "$BANNED_RE" "$f" >/tmp/_pipelint_claude.$$; then
    while IFS= read -r hit; do
      echo "NO-CLAUDE-LINT: $f: banned model reference: $hit"
      status=1
    done </tmp/_pipelint_claude.$$
  fi
  rm -f /tmp/_pipelint_claude.$$
done

exit $status
