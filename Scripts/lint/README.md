# PIPE-LINT - Adopted lint stack

Story: `docs/stories/PIPE-LINT.story.codify-dont-repeat-rules.md` (game repo)
Architect review: `docs/architecture/PIPE-ARCH-REVIEW-tech-spec-20260502.md`

## What runs

Configured in `.pre-commit-config.yaml` at repo root. Run with `pre-commit run --all-files` or `pre-commit install` for git hook integration.

| Hook | Source | Purpose |
|------|--------|---------|
| `actionlint` | `rhysd/actionlint v1.7.12` | GitHub Actions YAML syntax, expression-length errors, shell inside `run:` blocks. Replaces our hand-rolled multi-K-character expression detector. |
| `zizmor` | `zizmorcore/zizmor v1.17.0` (CI-only) | GitHub Actions security audits. Run in CI on changed workflow files only; not a pre-commit hook because zizmor audits the whole repo regardless of file filters. |
| `shellcheck` | `shellcheck-py v0.11.0.1` | Shell script lint. Catches `\|\| true` / `\|\| echo` swallow patterns, unquoted vars, common bash bugs. Replaces our hand-rolled silent-failure grep. |
| `ascii-ids` | local - `Scripts/lint/check-ascii-ids.sh` | Banned non-ASCII glyphs (section sign, em/en-dash, curly quotes, arrows, fancy bullets) in ID/ref-bearing lines. Source: CLAUDE.md "Keyboard-Reproducible Refs". |
| `no-claude-models` | local - `Scripts/lint/check-no-claude-models.sh` | Bans `claude-*`, `sonnet`, `opus`, `haiku`, `@anthropic-ai/` in bug-pipeline source paths. Source: `memory/project_no_sonnet_in_bug_pipeline.md`. |

## How to update versions

```bash
pre-commit autoupdate
git diff .pre-commit-config.yaml   # review revs
# open PR; CI runs the new revs against all files
```

## How to add an exception

Each adopted tool ships its own exception mechanism - use it; do not add bespoke exception files.

- `actionlint`: `# actionlint-ignore: <code>` inline, or `actionlint.yaml` at repo root.
- `zizmor`: `# zizmor: ignore[<rule>]` inline, or `.zizmor.yml` config.
- `shellcheck`: `# shellcheck disable=SC2086` inline.
- `ascii-ids` / `no-claude-models`: add the path to the `exclude:` glob in `.pre-commit-config.yaml`. PR description must explain why; PM sign-off required.

## How to add a new lint

1. If an OSS tool exists, add it as a `pre-commit` repo entry pinned to a specific rev.
2. If a custom rule is needed, add a script under `Scripts/lint/`, a fixture-based test under `Scripts/lint/tests/`, and a `local` hook entry. Keep custom code under ~50 LOC per rule; if it grows, look harder for OSS.
3. Update this README row.
4. Document the standing rule it codifies (CLAUDE.md or memory file).

## Performance

Target: full `pre-commit run --all-files` under 60s on the CI runner. If a hook drifts, narrow its `files:` glob before adding more parallelism.
