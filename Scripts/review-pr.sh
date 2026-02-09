#!/bin/bash
# review-pr.sh — Download and install a PR build on local simulator
#
# Downloads the build artifact linked in a PR, installs it on a local
# iOS simulator, and deep-links to the affected screen so the reviewer
# can visually verify the fix with zero manual steps.
#
# Usage: ./review-pr.sh <PR_NUMBER>
#
# Requirements:
#   - gh CLI authenticated (for PR data and release downloads)
#   - Xcode command line tools (xcrun simctl)
#   - macOS with Simulator.app

set -euo pipefail

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
PR_NUMBER="${1:?Usage: review-pr.sh <PR_NUMBER>}"
REPO="RaufGlasgow/Sorting-History"

TEMP_DIR=$(mktemp -d)
# Ensure temp dir is cleaned up on exit (success or failure)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "=== Reviewing PR #$PR_NUMBER ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Fetch PR body and extract the build download URL
# ---------------------------------------------------------------------------
echo "[1/6] Fetching PR #$PR_NUMBER from $REPO..."
PR_BODY=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json body -q '.body')

if [ -z "$PR_BODY" ]; then
  echo "ERROR: Could not fetch PR #$PR_NUMBER from $REPO"
  echo "       Check that the PR exists and gh is authenticated."
  exit 1
fi

# The PR body contains a markdown link like:
#   [Download Build (.app.zip)](https://github.com/.../releases/download/.../SortingHistory-....zip)
# Extract the URL from inside the parentheses.
DOWNLOAD_URL=$(echo "$PR_BODY" | grep -oE 'https://github\.com/[^)]+\.zip' | head -1)

if [ -z "$DOWNLOAD_URL" ]; then
  echo "ERROR: No build artifact found on PR #$PR_NUMBER"
  echo "       The PR body must contain a .zip download link."
  echo ""
  echo "PR body (first 500 chars):"
  echo "$PR_BODY" | head -c 500
  exit 1
fi

echo "       Build URL: $DOWNLOAD_URL"

# ---------------------------------------------------------------------------
# 2. Download and unzip the build
# ---------------------------------------------------------------------------
echo "[2/6] Downloading build..."
ZIP_PATH="$TEMP_DIR/build.zip"

# Get a GitHub token from gh CLI for authenticated downloads.
# This handles both public releases and private repo assets.
GH_TOKEN=$(gh auth token 2>/dev/null || true)

CURL_AUTH_ARGS=()
if [ -n "$GH_TOKEN" ]; then
  CURL_AUTH_ARGS=(-H "Authorization: token $GH_TOKEN")
fi

HTTP_CODE=$(curl -sL -w "%{http_code}" "${CURL_AUTH_ARGS[@]}" "$DOWNLOAD_URL" -o "$ZIP_PATH")
if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Failed to download build from $DOWNLOAD_URL (HTTP $HTTP_CODE)"
  exit 1
fi

if [ ! -f "$ZIP_PATH" ] || [ ! -s "$ZIP_PATH" ]; then
  echo "ERROR: Download produced no .zip file or file is empty"
  exit 1
fi

echo "       Downloaded $(du -h "$ZIP_PATH" | cut -f1) to temp dir"

echo "[3/6] Unzipping..."
unzip -q "$ZIP_PATH" -d "$TEMP_DIR/app"

# Find the .app bundle (may be nested in subdirectories)
APP_PATH=$(find "$TEMP_DIR/app" -name "*.app" -type d | head -1)
if [ -z "$APP_PATH" ]; then
  echo "ERROR: No .app bundle found in downloaded archive"
  echo "       Contents of archive:"
  ls -R "$TEMP_DIR/app" 2>/dev/null || true
  exit 1
fi

echo "       App bundle: $(basename "$APP_PATH")"

# Read bundle ID from the .app's Info.plist (don't hardcode — it may differ)
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Info.plist" 2>/dev/null || echo "")
if [ -z "$BUNDLE_ID" ]; then
  echo "WARNING: Could not read bundle ID from Info.plist, using default"
  BUNDLE_ID="com.raul.sortinghistory.877348"
fi
echo "       Bundle ID: $BUNDLE_ID"

# ---------------------------------------------------------------------------
# 4. Determine deep link from PR changed files
# ---------------------------------------------------------------------------
echo "[4/6] Determining target screen from changed files..."
CHANGED_FILES=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json files -q '.files[].path')

DEEP_LINK=""
SCREEN_NAME="home"

# Match file patterns to deep links — MUST match BA-007.25 CI mapping exactly
# (auto-fix.yml lines 266-273)
if echo "$CHANGED_FILES" | grep -qi "SettingsView"; then
  DEEP_LINK="sortinghistory://settings"
  SCREEN_NAME="Settings"
elif echo "$CHANGED_FILES" | grep -qi "SetupView\|SetupHelp\|GameSetup"; then
  DEEP_LINK="sortinghistory://setup"
  SCREEN_NAME="Game Setup"
elif echo "$CHANGED_FILES" | grep -qi "StatisticsView"; then
  DEEP_LINK="sortinghistory://stats"
  SCREEN_NAME="Statistics"
elif echo "$CHANGED_FILES" | grep -qi "TimelineHistory\|HistoryView"; then
  DEEP_LINK="sortinghistory://history"
  SCREEN_NAME="History"
fi

if [ -n "$DEEP_LINK" ]; then
  echo "       Target: $SCREEN_NAME ($DEEP_LINK)"
else
  echo "       No deep-link match for changed files — will launch to home screen"
  echo "       Changed files:"
  echo "$CHANGED_FILES" | sed 's/^/         /'
fi

# ---------------------------------------------------------------------------
# 5. Boot simulator (or reuse already-booted one)
# ---------------------------------------------------------------------------
echo "[5/6] Preparing simulator..."

# Check for an already-booted simulator
DEVICE_ID=$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if d.get('state') == 'Booted':
            print(d['udid'])
            sys.exit(0)
" 2>/dev/null || true)

if [ -n "$DEVICE_ID" ]; then
  echo "       Reusing booted simulator: $DEVICE_ID"
else
  echo "       No booted simulator — looking for iPhone 16..."

  # Find an available iPhone 16 (any variant)
  DEVICE_ID=$(xcrun simctl list devices available -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if 'iPhone 16' in d['name'] and d.get('isAvailable', False):
            print(d['udid'])
            sys.exit(0)
# Fallback: any available iPhone
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if 'iPhone' in d['name'] and d.get('isAvailable', False):
            print(d['udid'])
            sys.exit(0)
print('', file=sys.stderr)
sys.exit(1)
" 2>/dev/null)

  if [ -z "$DEVICE_ID" ]; then
    echo "ERROR: No available iPhone simulator found"
    echo "       Run 'xcrun simctl list devices available' to check available devices."
    exit 1
  fi

  echo "       Booting simulator $DEVICE_ID..."
  xcrun simctl boot "$DEVICE_ID"

  # Open Simulator.app so the user can see it
  open -a Simulator
  echo "       Waiting for simulator to finish booting..."
  sleep 5
fi

# Ensure Simulator.app is in the foreground (even if already booted)
open -a Simulator

# ---------------------------------------------------------------------------
# 6. Install and launch
# ---------------------------------------------------------------------------
echo "[6/6] Installing and launching..."

# Terminate app if already running (clean state — lesson from BA-007.25 QA)
xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" 2>/dev/null || true
sleep 1

# Install the .app
xcrun simctl install "$DEVICE_ID" "$APP_PATH"

# Small delay to let install complete
sleep 1

# Launch to the correct screen
if [ -n "$DEEP_LINK" ]; then
  echo "       Launching via deep link: $DEEP_LINK"
  xcrun simctl openurl "$DEVICE_ID" "$DEEP_LINK"
else
  echo "       Launching to home screen"
  xcrun simctl launch "$DEVICE_ID" "$BUNDLE_ID"
fi

# Wait for app to finish launching
sleep 3

echo ""
echo "========================================="
echo "  PR #$PR_NUMBER build is running"
echo "  Screen: $SCREEN_NAME"
echo "========================================="
echo ""
echo "Review the fix, then approve or request changes on the PR:"
echo "  gh pr review $PR_NUMBER --repo $REPO --approve"
echo "  gh pr review $PR_NUMBER --repo $REPO --request-changes"
