# Pipeline Digest Cron Prompt — PIPE-EMAIL-RESTORE-001 Phase 1

**Cron:** `57 8,17 * * *` (Lisbon local — twice daily at 8:57 AM and 5:57 PM)
**recurring:** true
**durable:** true

Paste the block below as the `prompt` field of a `CronCreate` call.

---

```
Scheduled pipeline digest send — PIPE-EMAIL-RESTORE-001 Phase 1.

Run the digest. Steps:

1. Fetch latest script from origin/main (the local bugs-repo working tree is on a feature branch so we read from origin):
   cd "/Users/raufglagsow/AI Projects M4/Trivia Game/sortinghistory-bugs" && git fetch origin main:refs/remotes/origin/main && git show origin/main:Scripts/pipeline_digest.py > /tmp/pipeline_digest.py

2. Source credentials from the game repo's .env.pipeline-ops (gitignored, mode 600) and run the script:
   cd "/Users/raufglagsow/AI Projects M4/Trivia Game/SortingHistory" && set -a && . ./.env.pipeline-ops && set +a && python3 /tmp/pipeline_digest.py

3. Report ONE LINE on stdout: format exactly "Digest sent. id=<resend-id> subject=<subject> bugs=<n> prs=<m>" extracted from the script's output.

4. If anything failed (git fetch failed, script error, Resend HTTP error, missing env var), capture the FULL error output and file a GitHub issue: gh issue create --repo RaufGlasgow/Sorting-History --title "pipeline-health: digest cron failure $(date -u +%Y-%m-%dT%H:%MZ)" --body "Cron fired but failed. Error output: ..." --label pipeline-health. Then exit cleanly so the next scheduled run tries again.

Do NOT modify the script. Do NOT investigate failures beyond capturing them in the issue. Do NOT switch git branches in any worktree. This is a scheduled task — minimal in/out, exit cleanly within 60 seconds.

Background: This cron is the Phase 1 deliverable of PIPE-EMAIL-RESTORE-001 (story at docs/stories/PIPE-EMAIL-RESTORE-001.story.md in the game repo). The script sends a styled HTML digest to emptycupmedianv@gmail.com summarizing open from-app bugs + open fix PRs. Reads RESEND_API_KEY and AUTH_TOKEN from .env.pipeline-ops in the game repo. Worker action buttons in the email POST formData to bug-webhook.emptycupmedia.workers.dev/api/pipeline/*.
```
