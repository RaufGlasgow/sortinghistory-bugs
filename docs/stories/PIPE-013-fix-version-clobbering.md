# PIPE-013: Fix Pipeline Version Clobbering

**Priority:** P0 — Pipeline produces broken builds that must be rejected
**Points:** 3
**Branch:** `sortinghistory-bugs/main`
**Created:** 2026-03-20
**Principle:** The pipeline must not break working code. A correct fix rejected because of a bad version string is a pipeline failure, not a code failure.

---

## Problem Statement

The fix pipeline (`sdk-bug-fix.yml`) generates bug fixes and bumps the version string in `Views/SettingsView.swift` before creating a PR. PR #165 for issue #163 generated a correct fix (hide Change Category button on Daily Challenge results), but the pipeline also changed the version string from `1.1.0-beta.20` to `1.1.0-alpha.22`. The fix was rejected solely because of the version clobbering.

Root cause: `Scripts/bump-version.sh` has a hardcoded sed pattern that only matches `1.1.0-alpha.XX` and replaces it with `1.1.0-alpha.{N}`. The project switched from `alpha` to `beta` numbering on 2026-03-14. The script:

1. **Cannot find the version string.** The sed pattern `1\.1\.0-alpha\.[0-9][0-9]*` does not match `1.1.0-beta.20`. On Linux (GNU sed), this silently does nothing. On macOS (BSD sed), it also silently does nothing.
2. **The verification grep fails.** Line 67 checks for `1.1.0-alpha.${CURRENT}` which was never written, so the script exits with an error.
3. **But in the actual PR #165 run, the version DID get clobbered.** This implies either: (a) a different code path was used, (b) the orchestrator's AI subagent modified the version string directly during the fix, or (c) an older version of the script was running. Regardless of the specific mechanism, the pipeline must be hardened against all three vectors.

Additionally, the script does not understand the `NEXT_ALPHA_VERSION` variable semantics properly when the prefix is `beta`. The variable is named `NEXT_ALPHA_VERSION` but now tracks beta numbers. The script should use the variable value regardless of prefix.

---

## Incident Reference

**PR #165** (private repo `RaufGlasgow/Sorting-History`), fixing **issue #163**. The fix itself was correct -- the version string was the only problem. Owner rejected the PR, wasting one full pipeline cycle (~$2-3 in API costs, 30+ minutes of macOS runner time).

Also referenced in PIPE-011 (AC-16, AC-17) which identified the problem but scoped it as a sub-component of a larger story. This story extracts it as an independent, immediately shippable fix.

---

## User Stories

**US-1:** As the pipeline owner, when the fix pipeline bumps the version, I want it to preserve the current version prefix (beta/alpha/rc) so the version string is never downgraded or reformatted.

**US-2:** As the pipeline owner, I want the fix pipeline to skip the version bump entirely if the fix does not modify version-sensitive files, so unnecessary version churn does not pollute the commit history.

**US-3:** As the pipeline owner, I want the `NEXT_ALPHA_VERSION` GitHub variable to be the single source of truth for the numeric portion of the version, regardless of whether the prefix is alpha, beta, or rc.

---

## Acceptance Criteria (numbered, testable)

### Part A: Fix `bump-version.sh`

**AC-1:** The sed pattern in `bump-version.sh` matches both `alpha` and `beta` (and `rc`) prefixes. The pattern must match: `1.1.0-(alpha|beta|rc).{digits}`.

**AC-2:** Before replacement, the script detects the current prefix from `SettingsView.swift` and preserves it. If the file contains `1.1.0-beta.20`, the output is `1.1.0-beta.{N}`, never `1.1.0-alpha.{N}`.

**AC-3:** The verification grep (line 67) uses the detected prefix, not a hardcoded `alpha`. It checks for `1.1.0-{detected_prefix}.{N}`.

**AC-4:** The script's echo/log output uses the detected prefix: `Updated SettingsView.swift to 1.1.0-beta.{N}` (not `alpha`).

**AC-5:** If no version string matching `1.1.0-(alpha|beta|rc).{digits}` is found in `SettingsView.swift`, the script exits with a clear error: `ERROR: No version string matching '1.1.0-(alpha|beta|rc).N' found in SettingsView.swift. The version format may have changed.` This prevents silent no-ops.

**AC-6:** The `GITHUB_OUTPUT` variable is renamed from `ALPHA_VERSION` to `VERSION_NUMBER` for clarity (since it may be a beta number). For backward compatibility, both `ALPHA_VERSION` and `VERSION_NUMBER` are written to `GITHUB_OUTPUT`.

### Part B: Guard Against AI Subagent Version Modification

**AC-7:** The `sdk-bug-fix.yml` workflow adds a post-fix verification step (after the orchestrator runs, before commit) that checks whether `SettingsView.swift` was modified by the subagent. If the subagent changed the version string:
- Revert only the version line in `SettingsView.swift` to its pre-fix state (using `git checkout -p` or targeted `git diff`/`git apply`)
- Log a warning: `Subagent modified version string -- reverted. Version bump is handled by bump-version.sh.`

**AC-8:** The verification in AC-7 compares the version string before and after the fix subagent runs. It stores the pre-fix version in a step output and compares after the subagent completes.

### Part C: Conditional Version Bump

**AC-9:** The `sdk-bug-fix.yml` workflow makes the version bump conditional. The bump runs only if the fix modifies files that would require a new build for testing. Skip the bump if the only changed files are documentation (`.md`), test files, or non-compiled assets.

**AC-10:** The skip logic checks the list of modified files (from `steps.changes.outputs.modified_files`). If ALL modified files match `*.md`, `*Tests*`, `*.json` (non-event data), or `docs/*`, skip the version bump step.

### Part D: Workflow References

**AC-11:** All references to `ALPHA_VERSION` in `sdk-bug-fix.yml` (the "How to Test" section in the PR body, the email step) use the correct prefix. The PR body must say `1.1.0-beta.{N}` (not `1.1.0-alpha.{N}`) when the current prefix is `beta`. Pass the full version string (e.g., `1.1.0-beta.22`) as a step output, not just the number.

---

## Technical Design

### 1. Fix `bump-version.sh` (Lines 58-81)

Replace the hardcoded `alpha` pattern with prefix-detecting logic:

```bash
# ── Step 2: Find and update SettingsView.swift ────────────────────────
SETTINGS_FILE="${GAME_REPO_PATH:-game-code}/Views/SettingsView.swift"

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "ERROR: SettingsView.swift not found at $SETTINGS_FILE"
  exit 1
fi

# Detect current version prefix (alpha, beta, rc)
CURRENT_PREFIX=$(grep -oE '1\.1\.0-(alpha|beta|rc)\.' "$SETTINGS_FILE" | head -1 | sed 's/1\.1\.0-//' | sed 's/\.//')
if [ -z "$CURRENT_PREFIX" ]; then
  echo "ERROR: No version string matching '1.1.0-(alpha|beta|rc).N' found in $SETTINGS_FILE"
  echo "The version format may have changed. Update bump-version.sh to match."
  grep -n "1\.1\.0" "$SETTINGS_FILE" || true
  exit 1
fi

echo "Detected version prefix: $CURRENT_PREFIX"

# Replace version with preserved prefix (handle both BSD and GNU sed)
if [[ "${OSTYPE:-}" == darwin* ]]; then
  sed -i '' "s/1\.1\.0-\(alpha\|beta\|rc\)\.[0-9][0-9]*/1.1.0-${CURRENT_PREFIX}.${CURRENT}/" "$SETTINGS_FILE"
else
  sed -i "s/1\.1\.0-\(alpha\|beta\|rc\)\.[0-9][0-9]*/1.1.0-${CURRENT_PREFIX}.${CURRENT}/" "$SETTINGS_FILE"
fi

# Verify with detected prefix
if ! grep -q "1.1.0-${CURRENT_PREFIX}.${CURRENT}" "$SETTINGS_FILE"; then
  echo "ERROR: Version replacement failed in $SETTINGS_FILE"
  echo "Expected to find '1.1.0-${CURRENT_PREFIX}.${CURRENT}' after sed replacement."
  exit 1
fi

FULL_VERSION="1.1.0-${CURRENT_PREFIX}.${CURRENT}"
echo "Updated SettingsView.swift to ${FULL_VERSION}"
```

Update the output section:

```bash
# ── Export for workflow use ────────────────────────────────────────────
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "ALPHA_VERSION=${CURRENT}" >> "$GITHUB_OUTPUT"    # backward compat
  echo "VERSION_NUMBER=${CURRENT}" >> "$GITHUB_OUTPUT"   # new canonical name
  echo "VERSION_PREFIX=${CURRENT_PREFIX}" >> "$GITHUB_OUTPUT"
  echo "FULL_VERSION=${FULL_VERSION}" >> "$GITHUB_OUTPUT"
fi
```

### 2. Pre-Fix Version Capture (new step in `sdk-bug-fix.yml`)

Add before the orchestrator step:

```yaml
- name: Capture pre-fix version string
  id: pre-fix-version
  if: (steps.guard.outputs.blocked || 'false') != 'true' && env.PIPELINE_MODE == 'full'
  working-directory: game-repo
  run: |
    VERSION_LINE=$(grep -n '1\.1\.0-\(alpha\|beta\|rc\)\.[0-9]' Views/SettingsView.swift | head -1)
    echo "version_line=$VERSION_LINE" >> $GITHUB_OUTPUT
    VERSION_STRING=$(echo "$VERSION_LINE" | grep -oE '1\.1\.0-(alpha|beta|rc)\.[0-9]+')
    echo "version_string=$VERSION_STRING" >> $GITHUB_OUTPUT
    echo "Pre-fix version: $VERSION_STRING"
```

### 3. Post-Fix Version Guard (new step in `sdk-bug-fix.yml`)

Add after the orchestrator step, before the commit step:

```yaml
- name: Guard against subagent version modification
  if: (steps.guard.outputs.blocked || 'false') != 'true' && env.PIPELINE_MODE == 'full' && steps.fix.outputs.applied == 'true'
  working-directory: game-repo
  run: |
    PRE_VERSION="${{ steps.pre-fix-version.outputs.version_string }}"
    CURRENT_VERSION=$(grep -oE '1\.1\.0-(alpha|beta|rc)\.[0-9]+' Views/SettingsView.swift | head -1)

    if [ "$CURRENT_VERSION" != "$PRE_VERSION" ]; then
      echo "::warning::Subagent modified version string from $PRE_VERSION to $CURRENT_VERSION -- reverting"
      git checkout -- Views/SettingsView.swift
      # Re-check: if the subagent also made legitimate changes to SettingsView.swift,
      # we need a more targeted revert. For now, if SettingsView.swift was modified,
      # it was likely ONLY for the version string (the subagent should not be editing settings).
      echo "Version string reverted to $PRE_VERSION. Version bump is handled by bump-version.sh."
    else
      echo "Version string unchanged by subagent -- OK"
    fi
```

### 4. PR Body Version Reference Fix

In the "Create PR on private repo" step, change:

```yaml
# Before (hardcoded alpha):
echo "1. Install build version **1.1.0-alpha.${ALPHA_VERSION}** on device or simulator"

# After (use full version from bump script):
FULL_VERSION="${{ steps.bump-version.outputs.FULL_VERSION }}"
if [ -z "$FULL_VERSION" ]; then
  FULL_VERSION="1.1.0-beta.${ALPHA_VERSION}"  # fallback
fi
echo "1. Install build version **${FULL_VERSION}** on device or simulator"
```

### 5. Conditional Version Bump

Wrap the existing bump step with a file-type check:

```yaml
- name: Check if version bump needed
  id: bump-needed
  if: ... && steps.changes.outputs.has_changes == 'true' && steps.fix.outputs.applied == 'true'
  run: |
    FILES="${{ steps.changes.outputs.modified_files }}"
    NEEDS_BUMP=false
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      case "$f" in
        *.md|*Tests*|docs/*|.github/*) ;;  # skip non-compiled files
        *.swift|*.plist|*.pbxproj|*.xcscheme|*.json)
          # .json could be event data -- still needs a build to test
          NEEDS_BUMP=true
          break
          ;;
        *) NEEDS_BUMP=true; break ;;
      esac
    done <<< "$FILES"
    echo "needs_bump=$NEEDS_BUMP" >> $GITHUB_OUTPUT
```

Then add `&& steps.bump-needed.outputs.needs_bump == 'true'` to the existing bump version step condition.

---

## Edge Cases

1. **Version prefix changes in the future (e.g., `rc`).** The script already handles `alpha|beta|rc`. If a new prefix like `release` is introduced, the regex must be updated. A comment in the script header documents this.

2. **Multiple version strings in SettingsView.swift.** The file has one `InfoRow` with the version. The `head -1` in the grep ensures only the first match is used. If the file structure changes to have multiple version-like strings, the grep should be made more specific (e.g., anchored to the `InfoRow` context).

3. **Subagent modifies SettingsView.swift for legitimate reasons.** If the bug fix requires changes to `SettingsView.swift` (e.g., a UI bug in settings), the AC-7 guard (`git checkout -- Views/SettingsView.swift`) would revert the legitimate fix. Mitigation: the guard only reverts if the version string specifically changed. If the subagent changed other parts of `SettingsView.swift` without touching the version, no revert happens. If both changed, a more targeted approach (stash the version line, restore after) is needed -- but this is extremely unlikely given that the subagent has no reason to touch the version string as part of a bug fix.

4. **`NEXT_ALPHA_VERSION` variable not set.** The script already handles this (line 34-39, exits with error). No change needed.

5. **Race condition: two pipelines read the same `NEXT_ALPHA_VERSION`.** The concurrency group `sdk-fix-${{ issue_number }}` prevents concurrent runs for the same issue, but two different issues could race. The `gh variable set` is not atomic. Mitigation: this is a known limitation. The worst case is two builds with the same version number, which is detectable at TestFlight upload (Apple rejects duplicate build numbers). A future story could use a lock or atomic increment.

6. **BSD sed on macOS runners vs GNU sed on Linux.** The script already branches on `${OSTYPE}`. The extended regex `\(alpha\|beta\|rc\)` uses BRE (basic regex) which works on both BSD and GNU sed. Do NOT use `-E` flag with `\|` -- use BRE alternation `\(a\|b\)` for portability.

7. **Empty `modified_files` output.** If the changes step produces an empty list, the conditional bump check defaults to `false` (no bump), which is correct -- no changes means no build needed.

---

## Dependencies

| Dependency | Status | Blocking? |
|-----------|--------|-----------|
| `Scripts/bump-version.sh` in sortinghistory-bugs repo | Exists | No |
| `sdk-bug-fix.yml` workflow | Exists | No |
| `NEXT_ALPHA_VERSION` GitHub variable | Configured | No |
| `PRIVATE_REPO_PAT` secret with repo scope | Configured | No |

No new secrets or infrastructure required. This is a fix to existing code.

---

## Effort Estimate

| Component | Points | Notes |
|-----------|--------|-------|
| A: Fix `bump-version.sh` (prefix detection + regex) | 1 | Straightforward sed/grep fix |
| B: Subagent version guard (new workflow steps) | 1 | Two new steps in YAML |
| C: Conditional bump + PR body fix | 1 | Logic check + string interpolation |
| **Total** | **3** | Single PR to `sortinghistory-bugs/main` |

### Suggested Implementation Order

1. **Part A first** -- this is the immediate fix that prevents the next pipeline run from clobbering. Ship and merge before anything else.
2. **Parts B + C together** -- defense in depth. Can be a separate commit in the same PR or a follow-up.

---

## Out of Scope

- **Renaming the `NEXT_ALPHA_VERSION` variable** to `NEXT_VERSION_NUMBER`. The variable name is baked into GitHub Actions and potentially other scripts. Renaming it is a coordination task across multiple workflows. The script outputs both `ALPHA_VERSION` (backward compat) and `VERSION_NUMBER` (new) to bridge this.
- **Atomic version number allocation.** Preventing race conditions between concurrent pipeline runs for different issues requires a locking mechanism (e.g., GitHub API concurrency, a KV store). This is a separate story.
- **`CFBundleVersion` management.** The build number in `Info.plist` is separate from the marketing version in `SettingsView.swift`. Managing it is scoped to PIPE-011 (approve-and-deploy workflow).
- **Full version format migration tooling.** If the project moves to `2.0.0` or a different format entirely, `bump-version.sh` needs a rewrite. This story only handles the `1.1.0-{prefix}.{N}` format.
