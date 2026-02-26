# Sorting History - Bug Automation

Automated bug analysis and fix generation for the Sorting History iOS game.

This repo contains the CI/CD workflows and scripts for processing bug reports. The game source code lives in a separate private repository.

## How It Works

1. Bug reports are filed as issues in the private game repo
2. A lightweight dispatch workflow triggers analysis in this repo
3. AI analyzes the bug and posts triage results
4. On `/approve`, a fix is generated, validated, and submitted as a PR

## Workflows

- `bug-analysis.yml` - AI-powered bug analysis and triage
- `auto-fix.yml` - Fix generation with build validation

## Prompt Change Convention (BA-011)

The triage prompt (`Scripts/sdk/prompts/bug-triager.md`) controls how bugs are classified. Changes to this file directly affect pipeline accuracy and cost.

### Commit convention

- Commit message: `prompt: <description of change>`
- Only `bug-triager.md` changes in prompt commits — no mixed commits with code changes
- Example: `prompt: add crash_bug vs gameplay_bug boundary examples`

### Rollback procedure

If a prompt change causes accuracy regression:

```bash
git log --oneline -- Scripts/sdk/prompts/bug-triager.md   # find the commit
git revert <commit-hash>                                    # revert it
git push                                                     # deploy immediately
```

### Validation before deployment

Run the dry-run script to compare accuracy before and after prompt changes:

```bash
npx tsx Scripts/sdk/tests/triage-dry-run.ts   # requires ANTHROPIC_API_KEY
```
