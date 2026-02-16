#!/bin/bash
set -euo pipefail

# bump-version.sh — Centralized version bump for SortingHistory pipelines
#
# Reads NEXT_ALPHA_VERSION from the private repo GitHub variable,
# updates SettingsView.swift with the new version number, and
# increments the variable for the next pipeline run.
#
# Requirements:
#   - GH_TOKEN env var set with a PAT that has repo scope on Sorting-History
#   - GAME_REPO_PATH env var pointing to the game repo checkout (default: game-code)
#   - gh CLI installed
#
# Usage:
#   export GH_TOKEN="ghp_..."
#   export GAME_REPO_PATH="./game-code"
#   bash Scripts/bump-version.sh
#
# Outputs (for GitHub Actions):
#   ALPHA_VERSION — the version number used (written to GITHUB_OUTPUT)

REPO="RaufGlasgow/Sorting-History"

# ── Pre-flight: GH_TOKEN must be set ──────────────────────────────────
if [ -z "${GH_TOKEN:-}" ]; then
  echo "ERROR: GH_TOKEN is not set."
  echo "The gh CLI defaults to GITHUB_TOKEN which only has public repo scope."
  echo "Export GH_TOKEN from PRIVATE_REPO_PAT before calling this script."
  exit 1
fi

# ── Step 1: Read NEXT_ALPHA_VERSION ───────────────────────────────────
CURRENT=$(gh variable get NEXT_ALPHA_VERSION --repo "$REPO" 2>&1) || {
  echo "ERROR: Failed to read NEXT_ALPHA_VERSION from $REPO"
  echo "Ensure GH_TOKEN is set with repo scope (not GITHUB_TOKEN)"
  echo "Raw output: $CURRENT"
  exit 1
}

# Validate it's a number
if ! [[ "$CURRENT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: NEXT_ALPHA_VERSION is not a number: '$CURRENT'"
  exit 1
fi

echo "Read NEXT_ALPHA_VERSION: $CURRENT"

# ── Step 2: Find and update SettingsView.swift ────────────────────────
SETTINGS_FILE="${GAME_REPO_PATH:-game-code}/Views/SettingsView.swift"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "ERROR: SettingsView.swift not found at $SETTINGS_FILE"
  echo "Set GAME_REPO_PATH to the game repo checkout directory."
  exit 1
fi

# Use regex pattern match, NOT line numbers (line numbers shift)
# Handle both macOS (BSD sed) and Linux (GNU sed)
if [[ "${OSTYPE:-}" == darwin* ]]; then
  sed -i '' "s/1\.1\.0-alpha\.[0-9][0-9]*/1.1.0-alpha.${CURRENT}/" "$SETTINGS_FILE"
else
  sed -i "s/1\.1\.0-alpha\.[0-9][0-9]*/1.1.0-alpha.${CURRENT}/" "$SETTINGS_FILE"
fi

# Verify the replacement happened
if ! grep -q "1.1.0-alpha.${CURRENT}" "$SETTINGS_FILE"; then
  echo "ERROR: Version replacement failed in $SETTINGS_FILE"
  echo "Expected to find '1.1.0-alpha.${CURRENT}' after sed replacement."
  exit 1
fi

echo "Updated SettingsView.swift to 1.1.0-alpha.${CURRENT}"

# ── Step 3: Increment variable for next use ───────────────────────────
NEXT=$((CURRENT + 1))
gh variable set NEXT_ALPHA_VERSION --repo "$REPO" --body "$NEXT"

echo "NEXT_ALPHA_VERSION set to ${NEXT}"
echo "Version bumped to 1.1.0-alpha.${CURRENT}"

# ── Export for workflow use ────────────────────────────────────────────
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ALPHA_VERSION=${CURRENT}" >> "$GITHUB_OUTPUT"
fi
