# Releasing @vedmalex/statemachine

## Prerequisites

1. **npm scope claim verification** — confirm `@vedmalex` scope is registered to the publisher account: `npm view @vedmalex/statemachine` returns metadata for published versions or 404 for unpublished.
2. **NPM_TOKEN** — operator generates an npm access token (granular, publish-only scope to `@vedmalex`):
   - https://www.npmjs.com/settings/<user>/tokens → "Generate New Token" → "Publish" → "Granular Access Token" → scope `@vedmalex` → "Read and write".
   - Add as repo secret in GitHub: Settings → Secrets and variables → Actions → New repository secret → Name `NPM_TOKEN`, Value `npm_xxxxxxxx`.
3. **GitHub Actions enabled** — confirm CI workflow runs on `main` branch.

## Pre-release flow (each new beta)

1. Author per-change Markdown files in `.changeset/`:
   ```
   bunx changeset
   ```
   Pick affected packages; pick bump type (`patch`/`minor`/`major`); write summary.
2. When ready to release a new version, bump:
   ```
   bunx changeset version
   ```
   This consumes pending changesets, bumps `package.json`, updates `CHANGELOG.md`, and stages the changes for commit.
3. Commit + push the version-bump:
   ```
   git add . && git commit -m "chore(release): version" && git push
   ```
4. Trigger publish: GitHub UI → Actions → Release workflow → Run workflow on `main`.
5. Verify on npm: `npm view @vedmalex/statemachine` shows the new version.

## First publish (1.0.0-beta.0)

TASK-007 of the standalone-evolution roadmap (RM-001) handles the inaugural publish. See `memory-bank/tasks/2026-05-03_TASK-007_*` for the operator playbook.

## Troubleshooting

- `npm publish` 403: NPM_TOKEN missing or scoped incorrectly.
- `npm publish` 401: token expired; regenerate.
- `bunx changeset publish` no-op: no pending changesets; author one with `bunx changeset`.
