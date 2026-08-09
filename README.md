# Dependabot for Git

Reusable CLI that runs [dependabot/cli](https://github.com/dependabot/cli) update jobs against a
Bitbucket Cloud repo and turns the results into real pull requests.

## Using it in a repo

Copy the two files from `templates/` into the repo:

- `bitbucket-pipelines.yml` — the custom `dependabot-update` pipeline
- `dependabot-config.json` — which ecosystems/directories to check (edit as needed, same
  idea as the `updates:` list in a normal `.github/dependabot.yml`)

Set the three repository variables (see comments at the top of the pipeline template),
then trigger it manually from the Pipelines UI ("Run pipeline" -> custom:
dependabot-update), or wire it to a schedule under Repo settings -> Pipelines ->
Schedules.

That's it — no scripts to copy, no logic to keep in sync. Bumping behaviour for every
repo now comes from bumping this package's version.

## What the two CLI commands do

### `dependabot-run-updates`

Reads `./dependabot-config.json` in the current working directory (the consuming repo),
builds a job description per entry, and runs `dependabot update` against Bitbucket Cloud,
writing `.dependabot-run/output-N.yaml` + a `manifest.json` describing what ran.

Same required env vars as before: `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`,
`BITBUCKET_COMMIT` (all provided automatically by Bitbucket Pipelines), plus
`BITBUCKET_GIT_TOKEN` and optionally `NPM_TOKEN`.

### `dependabot-create-prs`

Reads `.dependabot-run/manifest.json` (or explicit `output-*.yaml` paths passed as
arguments) and turns each recorded `create_pull_request` / `update_pull_request` /
`close_pull_request` entry into a real Bitbucket PR via the REST API — writing files
straight to a branch via the `src` endpoint, no local git clone needed.

Requires `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`, and `BITBUCKET_PR_TOKEN` (or
`BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`).

**Filters applied automatically:**

- Skips `update_dependency_list` / `mark_as_processed` entries (informational, not PR
  actions).
- Skips transitive-only dependency bumps by default (updates that only touch a lockfile,
  never the manifest) — otherwise `npm_and_yarn` in particular can produce 100+ PRs for a
  small project. Set `SKIP_TRANSITIVE_ONLY_UPDATES=false` to disable.
- Truncates PR descriptions over ~30KB (release notes for monorepo packages like
  `@aws-sdk/*` can be huge; Bitbucket rejects descriptions over ~32KB).

`DRY_RUN=true` runs fully offline and just logs what it would do.

## Local development on this package

```bash
npm install
npm link   # makes dependabot-run-updates / dependabot-create-prs available globally

cd /path/to/some/other/repo
npm link @aat-labs/dependabot-bitbucket-bridge
BITBUCKET_WORKSPACE=... BITBUCKET_REPO_SLUG=... ... dependabot-run-updates
```
