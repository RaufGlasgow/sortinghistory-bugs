# Per-Bug Triage Cron Prompt (v2) — PIPE-EMAIL-RESTORE-001 Phase 2

**Cron:** `13 * * * *` (every hour at :13, Lisbon local)
**recurring:** true
**durable:** true

v2 adds the mandatory fix-status check on bugs >3 days old. Established 2026-05-17 after old-bug P0/P2 mistakes.

Paste the block below as the `prompt` field of a `CronCreate` call.

---

```
Scheduled per-bug triage analyzer — PIPE-EMAIL-RESTORE-001 Phase 2 (v2: with fix-already-shipped check).

PURPOSE: Find new untriaged from-app bugs and triage each one. Before classifying, check whether the bug has ALREADY been fixed in commits since it was filed — old bugs are often stale.

STEPS:

1. Find untriaged from-app bugs (limit 2 per fire):
   gh issue list --repo RaufGlasgow/Sorting-History --label from-app --state open --json number,title,body,labels,createdAt -L 50 | jq '[.[] | select((.labels | map(.name) | index("triaged")) == null) | select(.title | startswith("[CANARY") | not) | select(.title | startswith("[Bug] [PM SMOKE TEST") | not) | select(.title | startswith("[Bug] [PIPELINE-OPS") | not)] | .[0:2]'

2. If empty: print "No untriaged bugs. Exiting." and EXIT 0.

3. For each untriaged issue, do ALL of this in-session as the Claude Code agent:

   a. FIX-STATUS CHECK (do this BEFORE classification):
      - Note the createdAt date and the App Version from the body (look for "App Version | X" in the device-info table).
      - If createdAt is older than 3 days, do `cd "/Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory" && git log --oneline --since="<createdAt date>" --all 2>&1 | head -200` and look for commits whose subject mentions the symptom (e.g., for "HP MP teams not showing" search for "hp-mp", "TeamIndicator", "multiplayer"; for "iPhone landscape" search for "LANDSCAPE", "iphone landscape"; for "round count" search for "round", "MULTICAT", "epic"; for "PT showing EN" search for "language", "locale", "translation").
      - If a clear matching fix commit exists, classification=duplicate, severity=P3, confidence=80+, description="Symptom already fixed by commit <SHA> on <date>. Filed against build <X>; current build ships the fix.", recommended_fix="Verify fix on current TestFlight build and close as fixed-in-newer-build if no longer reproducing." Skip to step (d).
      - If no clear fix is found but the bug is >14 days old and on an old build, still proceed with normal classification BUT note in the analysis: "Filed against build <X> which is N versions stale; reporter has not re-confirmed on current build."

   b. Read the issue body and any screenshot URL embedded in the body. If a screenshot URL is present (pattern https://[^)]+/screenshots/BUG-[A-Z0-9-]+\.png), download it and READ it.

   c. Peek at the relevant code (read-only — out-of-lane modifications are forbidden per CLAUDE.md Workstream Lane Discipline): for UI bugs grep Views/, for content bugs grep Data/Events/, for multiplayer bugs grep Networking/ and Models/Multiplayer*. Maximum 5 files read per issue.

   d. Decide classification (one of: gameplay_bug, content_error, ui, translation_error, performance, duplicate, needs_human_review, feature_request, rejected), severity (P0/P1/P2/P3), confidence (0-100), description (1-2 sentence summary), affected_files (list — empty list is fine), recommended_fix (1-3 sentence next-step), analysis (1-2 paragraph root-cause hypothesis).

   e. Write /tmp/analysis-<issue>.json with EXACTLY these fields: classification, severity, confidence, description, affected_files, recommended_fix, analysis. Valid JSON.

   f. Fetch latest script from origin/main:
      cd "/Users/raufglagsow/AI Projects M4/Trivia Game/sortinghistory-bugs" && git fetch origin main:refs/remotes/origin/main && git show origin/main:Scripts/triage_bug.py > /tmp/triage_bug.py

   g. Source credentials and run the finisher:
      cd "/Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory" && set -a && . ./.env.pipeline-ops && set +a && python3 /tmp/triage_bug.py <issue> --analysis /tmp/analysis-<issue>.json

4. Emit ONE LINE per issue triaged: "Triaged #N classification=X severity=Y resend_id=Z"

5. If anything failed, file ONE pipeline-health GitHub issue summarizing failures.

GUARDRAILS:
- Max 2 bugs per fire.
- Do NOT modify triage_bug.py — only invoke it.
- Do NOT switch git branches in any worktree.
- Do NOT modify files outside the bug-pipeline lane (per CLAUDE.md Workstream Lane Discipline). Reading code for triage is fine; writing/editing other workstreams' files is not.
- Skip titles starting with "[CANARY", "[Bug] [PM SMOKE TEST", "[Bug] [PIPELINE-OPS".
- Confidence <60% → classify as needs_human_review.
- Severity P0 = blocks gameplay or shipping; P1 = major regression; P2 = visible bug in non-blocking surface; P3 = polish/minor. Conservative when unsure.
- NEVER classify as P0/P1 without a fix-status check when the bug is older than 3 days. Old bugs on stale builds are duplicate candidates first.

Background: This cron is Phase 2 of PIPE-EMAIL-RESTORE-001 (story at /Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory/docs/stories/PIPE-EMAIL-RESTORE-001.story.md). v2 of this prompt adds the fix-status check after 2026-05-17 mistakes where P0/P2 emails went out on bugs that had already shipped fixes. The retrospective at /Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory/docs/audits/pipeline-failure-progression-20260517.md provides historical context.
```
