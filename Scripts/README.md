# Scripts Directory

This directory contains all automation scripts for the SortingHistory bug pipeline.

## Active Scripts

### Legacy Pipeline (pre-SDK)

| Script | Called By | Purpose |
|--------|-----------|---------|
| `analyze-bug.js` | `bug-analysis.yml` | AI-powered bug report analysis, label assignment, triage |
| `apply-fix.js` | `auto-fix.yml` | Generates and applies automated bug fixes (content, code, UX) |
| `visual-review.js` | `auto-fix.yml` | AI visual review of simulator screenshots (light + dark mode) |

### SDK Pipeline (new)

| Script | Called By | Purpose |
|--------|-----------|---------|
| `sdk/orchestrator.ts` | `sdk-content-pipeline.yml` | Main entry point for the Claude Agent SDK pipeline |

The SDK orchestrator supports multiple commands:

- `triage` -- Classify and route issues (dispatched via `analyze` event)
- `content-e2e` -- End-to-end content verification pipeline
- `resume` -- Resume paused workflows after human approval/rejection
- `proof` -- Read-only Haiku proof (test suite)
- `routing-test` -- Routing logic tests
- `resume-by-issue-test` -- Resume lookup tests
- `triage-test` -- Bug triage test suite
- `pause-resume` -- Pause/resume proof test

### Utilities

| Script | Called By | Purpose |
|--------|-----------|---------|
| `review-pr.sh` | (manual) | Local utility to build and install a PR fix on simulator |
| `context/architecture-registry.json` | `apply-fix.js` | Architecture context for the AI fix generator |

## SDK Structure (`Scripts/sdk/`)

```
sdk/
  orchestrator.ts       # Entry point -- CLI command router
  config.ts             # SDK configuration (models, timeouts, hooks)
  lib/                  # Shared libraries
    categories.ts       #   Category validation and mapping
    hooks.ts            #   Lifecycle hooks (pre/post workflow)
    json-extract.ts     #   JSON extraction from AI responses
    routing.ts          #   Issue-to-workflow routing logic
    session.ts          #   Session management
    state.ts            #   Pause/resume state persistence
    subagent.ts         #   Sub-agent spawning utilities
    worker-utils.ts     #   Cloudflare Worker API helpers
  workflows/            # Workflow definitions (triage, content-fix, verify)
  prompts/              # System prompts for AI sub-agents
  tests/                # Unit and integration tests
  test-data/            # Fixtures for tests
```

## Running the SDK Locally

```bash
cd Scripts/sdk

# Install dependencies
npm ci

# Type-check
npx tsc --noEmit

# Build TypeScript to JavaScript
npm run build

# Run tests
npm test

# Run a specific command (after build)
node dist/orchestrator.js proof
node dist/orchestrator.js routing-test
node dist/orchestrator.js triage-test
```

**Required environment variables for live runs:**

- `ANTHROPIC_API_KEY` -- Claude API key for SDK sub-agents
- `PRIVATE_REPO_PAT` -- GitHub PAT with access to the private game repo
- `GH_TOKEN` -- GitHub token (usually same as PRIVATE_REPO_PAT)

## Workflow-to-Script Mapping

| Workflow YAML | Trigger | Scripts Used |
|---------------|---------|--------------|
| `bug-analysis.yml` | `repository_dispatch: analyze` | `analyze-bug.js` |
| `auto-fix.yml` | `repository_dispatch: approve` | `apply-fix.js`, `visual-review.js` |
| `fix-rejected.yml` | `repository_dispatch: reject-fix` | (none -- pure YAML) |
| `sdk-content-pipeline.yml` | `repository_dispatch: analyze, sdk-content-verify, sdk-content-resume` | `sdk/dist/orchestrator.js` |
