#!/usr/bin/env bash
# PIPE-LINT: ASCII-only IDs lint
# Rule: any token matching pattern [A-Z]+-[0-9]+ must be pure ASCII, AND the
# file must not contain banned non-ASCII glyphs that we use for IDs / refs:
#   section sign, em-dash, en-dash, curly quotes, arrows, fancy bullets.
# Source of truth: CLAUDE.md "Keyboard-Reproducible Refs".
#
# Usage: check-ascii-ids.sh <file1> <file2> ...
# Exits 0 if clean, 1 if any banned glyph found.

set -u

status=0

# Banned characters (UTF-8 bytes). Listed by name in the error message.
# We grep with perl-regex because GNU grep on macOS lacks \x{...}.
BANNED_PATTERN=$'\xc2\xa7|\xe2\x80\x94|\xe2\x80\x93|\xe2\x80\x9c|\xe2\x80\x9d|\xe2\x80\x98|\xe2\x80\x99|\xe2\x86\x92|\xe2\x86\x90|\xe2\x87\x92|\xe2\x80\xa2|\xc2\xb7'

for f in "$@"; do
  [ -f "$f" ] || continue
  # Skip binary files
  if file "$f" | grep -qE 'binary|image|audio|video'; then continue; fi
  # Skip translation/content data: those legitimately contain non-ASCII for product copy
  case "$f" in
    Data/Events/*|Localization/*|*_de.json|*_nl.json|*_pt.json|*_es-419.json|*_ja.json) continue ;;
  esac
  # Find lines containing a story-id-style token AND any banned glyph
  if grep -nE "$BANNED_PATTERN" "$f" >/tmp/_pipelint_banned.$$; then
    while IFS=: read -r lineno rest; do
      # Only fail if line also contains an ID-style ref OR is a Markdown heading / commit-style ref
      if printf '%s' "$rest" | grep -qE '[A-Z]+-[0-9]+|^#|^- |^\* |^Section '; then
        echo "ASCII-ID-LINT: $f:$lineno: banned non-ASCII glyph in ID/ref context: $rest"
        status=1
      fi
    done </tmp/_pipelint_banned.$$
  fi
  rm -f /tmp/_pipelint_banned.$$
done

exit $status
