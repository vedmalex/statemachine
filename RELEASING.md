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

## First publish (1.0.0-beta.0) — TASK-007 playbook

TASK-007 of the standalone-evolution roadmap (RM-001) handles the inaugural publish. See `memory-bank/tasks/2026-05-03_TASK-007_*` for the operator playbook.

### Pre-publish (agent steps)

1. Verify scope: `npm view @vedmalex/statemachine versions` returns 404 (or list without 1.0.0-beta.0).
2. Verify pre-mode: `.changeset/pre.json` has mode=pre, tag=beta. If absent: `bunx changeset pre enter beta`.
3. Author changeset at `.changeset/phase-1-baseline.md` with `"@vedmalex/statemachine": patch` bump.
4. Run `bunx changeset version` from the monorepo root.
5. Commit + push: `chore(TASK-007): version bump for 1.0.0-beta.x publish`.
6. Wait for CI green on remote.

### Operator-action steps

1. Confirm `NPM_TOKEN` repo secret is configured in GitHub.
2. Trigger Actions → Release → Run workflow on main.
3. Wait for completion (~3-5 min).
4. Verify: `npm view @vedmalex/statemachine@1.0.0-beta.1` returns metadata.
5. Smoke install in clean dir:
   ```bash
   mkdir /tmp/sm-smoke && cd /tmp/sm-smoke
   npm init -y && npm install @vedmalex/statemachine@1.0.0-beta.1
   node scripts/post-publish-smoke.cjs
   node scripts/post-publish-smoke.mjs
   ```
6. Notify agent of result.

### Post-publish (agent steps)

1. Re-run `npm view` to confirm metadata.
2. Tag: `git tag task-007-published-stable && git push origin task-007-published-stable`.
3. Verify Q12: no `@grainjs` references in published tarball.
4. Verify Q13: published `package.json` dependencies empty.

### Failure-path branches

- Step 4 fail (`npm view` no metadata): release.yml partial. Inspect logs; do NOT push tag; transition to QA-failure.
- Step 5 fail (smoke install errors): version published but broken. Author follow-up changeset for `1.0.0-beta.2` fix.
- NPM_TOKEN expiry: regenerate + retry workflow.

### GitHub Pages first deploy

Before triggering `.github/workflows/docs.yml`:
1. Verify Repo Settings → Pages → Source: "Deploy from a branch" with `gh-pages` selected.
2. If the `gh-pages` branch doesn't exist yet, the first run of docs.yml creates it; Pages settings auto-detect.
3. Subsequent docs.yml runs deploy to the same gh-pages branch.

## Troubleshooting

- `npm publish` 403: NPM_TOKEN missing or scoped incorrectly.
- `npm publish` 401: token expired; regenerate.
- `bunx changeset publish` no-op: no pending changesets; author one with `bunx changeset`.
