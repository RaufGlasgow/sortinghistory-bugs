#!/bin/bash
# review-pr.sh — Build and install a PR fix on local simulator
#
# Clones the PR branch, builds locally with xcodebuild, installs on a
# local iOS simulator, and deep-links to the affected screen so the
# reviewer can visually verify the fix with zero manual steps.
#
# Usage: ./review-pr.sh <PR_NUMBER>
#
# Requirements:
#   - gh CLI authenticated (for PR data and private repo clone)
#   - Xcode command line tools (xcodebuild, xcrun simctl)
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
# 1. Get the PR's source branch name
# ---------------------------------------------------------------------------
echo "[1/5] Fetching PR #$PR_NUMBER branch from $REPO..."
BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName -q '.headRefName')

if [ -z "$BRANCH" ]; then
  echo "ERROR: Could not fetch PR #$PR_NUMBER from $REPO"
  echo "       Check that the PR exists and gh is authenticated."
  exit 1
fi

echo "       Branch: $BRANCH"

# ---------------------------------------------------------------------------
# 2. Shallow clone the PR branch
# ---------------------------------------------------------------------------
echo "[2/5] Cloning branch $BRANCH..."
gh repo clone "$REPO" "$TEMP_DIR/repo" -- --branch "$BRANCH" --depth 1 --single-branch

if [ ! -d "$TEMP_DIR/repo/SortingHistory.xcodeproj" ]; then
  echo "ERROR: Clone succeeded but SortingHistory.xcodeproj not found"
  echo "       Contents of cloned directory:"
  ls "$TEMP_DIR/repo" 2>/dev/null || true
  exit 1
fi

echo "       Cloned to $TEMP_DIR/repo"

# ---------------------------------------------------------------------------
# 3. Discover simulator, then build targeting it
# ---------------------------------------------------------------------------
echo "[3/5] Preparing simulator and building..."

# --- Discover or boot a simulator BEFORE building ---
# This ensures xcodebuild targets the exact device we will install on.

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
  echo "       No booted simulator — finding an available iPhone..."

  # Find an available iPhone (prefer iPhone 16 variants, fall back to any)
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

# --- Build locally targeting the discovered device ---
echo "       Building locally... this may take 1-3 minutes"

if ! xcodebuild build \
  -project "$TEMP_DIR/repo/SortingHistory.xcodeproj" \
  -scheme SortingHistory \
  -destination "platform=iOS Simulator,id=$DEVICE_ID" \
  -derivedDataPath "$TEMP_DIR/DerivedData" \
  CODE_SIGNING_ALLOWED=NO \
  -quiet; then
  echo ""
  echo "ERROR: xcodebuild build failed. Check the output above for details."
  exit 1
fi

# Find the built .app bundle
APP_PATH=$(find "$TEMP_DIR/DerivedData/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name "*.app" -type d | head -1)
if [ -z "$APP_PATH" ]; then
  echo "ERROR: Build completed but no .app bundle found in DerivedData"
  echo "       Contents of build products:"
  ls -R "$TEMP_DIR/DerivedData/Build/Products/" 2>/dev/null || true
  exit 1
fi

echo "       Built: $(basename "$APP_PATH")"

# Read bundle ID from the built .app's Info.plist
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Info.plist" 2>/dev/null || echo "")
if [ -z "$BUNDLE_ID" ]; then
  echo "WARNING: Could not read bundle ID from Info.plist, using default"
  BUNDLE_ID="com.raul.sortinghistory.877348"
fi
echo "       Bundle ID: $BUNDLE_ID"

# ---------------------------------------------------------------------------
# 4. Determine deep link from PR changed files
# ---------------------------------------------------------------------------
echo "[4/5] Determining target screen from changed files..."
CHANGED_FILES=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json files -q '.files[].path')

DEEP_LINK=""
SCREEN_NAME="home"

# Filter to view files only, then exclude SettingsView if other views present
# SettingsView is changed in EVERY bug fix PR (version bump) so it would
# always match first, hiding the actual fix screen (BA-007.28)
VIEW_FILES=$(echo "$CHANGED_FILES" | grep -i "View" || true)
if [ "$(echo "$VIEW_FILES" | grep -c .)" -gt 1 ]; then
  TARGET_FILES=$(echo "$VIEW_FILES" | grep -vi "SettingsView")
else
  TARGET_FILES="$CHANGED_FILES"
fi

# Match file patterns to deep links — MUST match BA-007.25 CI mapping exactly
# (auto-fix.yml screenshot step)
if echo "$TARGET_FILES" | grep -qi "SettingsView"; then
  DEEP_LINK="sortinghistory://settings"
  SCREEN_NAME="Settings"
elif echo "$TARGET_FILES" | grep -qi "SetupView\|SetupHelp\|GameSetup"; then
  DEEP_LINK="sortinghistory://setup"
  SCREEN_NAME="Game Setup"
elif echo "$TARGET_FILES" | grep -qi "StatisticsView"; then
  DEEP_LINK="sortinghistory://stats"
  SCREEN_NAME="Statistics"
elif echo "$TARGET_FILES" | grep -qi "TimelineHistory\|HistoryView"; then
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
# 5. Install and launch
# ---------------------------------------------------------------------------
echo "[5/5] Installing and launching..."

# Ensure Simulator.app is in the foreground
open -a Simulator

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
