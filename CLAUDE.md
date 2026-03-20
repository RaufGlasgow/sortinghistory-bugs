# sortinghistory-bugs — SDK Automation Pipeline

This is the PUBLIC automation repo for the SortingHistory iOS game. It contains CI workflows, SDK orchestration code, and automation scripts. **No game source code (Swift, Views, Models, assets, content JSON) belongs here.**

## Source of Truth Documents

These live in the PRIVATE game repo (`RaufGlasgow/Sorting-History`). Read them before starting any story:

| Document | Path (in game repo) | What it tells you |
|----------|---------------------|-------------------|
| PRD | `docs/prd-automation-system.md` | What to build and why (FR1-FR52) |
| Architecture | `docs/architecture-automation-system.md` | How to build it (components, data models, APIs) |
| Epics & Stories | `docs/epics-automation-system.md` | Story-level acceptance criteria and FR coverage |

## Attempt Log — READ BEFORE FIXING ANYTHING

**`docs/sdk-attempt-log.md`** tracks every significant fix, experiment, and config change to this pipeline.

**MANDATORY PROCESS (FR49-FR52):**

1. **Before starting a fix:** Check `docs/sdk-attempt-log.md` for prior attempts at the same problem
2. **If a prior attempt failed:** Your approach must be materially different. Explain WHY it will work where the prior approach did not
3. **Before implementing:** Add a PLANNED entry to the attempt log with your approach and expected outcome
4. **After CI runs:** Update the entry with the actual result (PASS/FAIL/PARTIAL), CI run ID, and lessons learned
5. **Never delete failed entries** — they are institutional memory

This exists because the BA-008 pipeline spent a month repeating the same broken approach 4 times. We will not do that again.

## Tech Specs

Pipeline change specs live in `docs/tech-specs/`. Each spec references its attempt log entry (ATT-XXX).

Current specs:
- `TS-SDK-001-path-and-bash-fix.md` — Fix proof path resolution + read-only tool enforcement (ATT-003)

## Repo Structure

```
sortinghistory-bugs/
├── .github/workflows/      # CI workflows (Actions)
│   └── sdk-content-pipeline.yml  # SDK pipeline — proof, verification, fixes
├── Scripts/
│   ├── sdk/                # Claude Agent SDK orchestration (TypeScript)
│   │   ├── config.ts       # Models, paths, tool sets, limits
│   │   ├── orchestrator.ts # Entry point — run/resume/status/proof
│   │   ├── workflows/      # Workflow implementations (proof, verify, fix)
│   │   └── lib/            # Shared utilities (subagent, state, session, hooks)
│   └── context/            # Architecture registry for game views
├── docs/
│   ├── sdk-attempt-log.md  # MANDATORY — check before any fix
│   └── tech-specs/         # Change specifications
└── state/                  # Workflow state files (created by CI, committed by sdk-bot)
```

## SDK Pipeline Rules

### Path Resolution
The SDK runs in CI with `working-directory: Scripts/sdk`. This means `process.cwd()` is NOT the repo root — it's `Scripts/sdk/`. Use `process.env.GITHUB_WORKSPACE` for the repo root in CI. See TS-SDK-001 for details.

### Tool Sets
- `PROOF_TOOLS` — Minimal read-only: Read, Glob, Grep. For proof workflows only.
- `VERIFIER_TOOLS` — Read-only + Bash: Read, Glob, Grep, Bash. For verification workflows that may run scripts.
- `FIXER_TOOLS` — Read-write: Read, Write, Edit, Glob, Grep, Bash. For fix generation, restricted via hooks.

### Environment Variables
| Variable | Set by | Purpose |
|----------|--------|---------|
| `GITHUB_WORKSPACE` | GitHub Actions (automatic) | Repo root in CI |
| `SDK_REPO_ROOT` | Manual (local dev) | Override repo root locally |
| `SDK_GAME_REPO` | Manual or default `game-repo` | Path to private game repo checkout |
| `SDK_STATE_DIR` | Manual or default `state/workflows` | Workflow state directory |
| `ANTHROPIC_API_KEY` | GitHub Secret | Claude API access |

### Safety
- `permissionMode: "bypassPermissions"` is used in CI — hooks are the enforcement layer
- PreToolUse hooks block writes to `.swift`, `.pbxproj`, and other game source files
- Every PR requires human approval before merge — no auto-merge, ever
- JSON validation runs before and after every file modification

## Version Variable
`NEXT_BUILD_NUMBER` on `RaufGlasgow/Sorting-History` — check before claiming any version number:
```bash
gh variable get NEXT_BUILD_NUMBER --repo RaufGlasgow/Sorting-History
```

## Secrets
- `ANTHROPIC_API_KEY` — Claude Agent SDK
- `OPENROUTER_API_BUGS` — OpenRouter (legacy pipeline)
- `PRIVATE_REPO_PAT` — Cross-repo checkout of game content
