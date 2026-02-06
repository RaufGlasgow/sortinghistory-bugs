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
