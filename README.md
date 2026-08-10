# dependabot-for-git

Reusable CLI that runs [dependabot/cli](https://github.com/dependabot/cli) update jobs against a git
repo and turns the results into real pull/merge requests — across Bitbucket Cloud and
GitLab, without copying scripts into every repo.

## Supported providers

| Provider                     | Status | Notes                                                             |
| ---------------------------- | ------ | ----------------------------------------------------------------- |
| Bitbucket Cloud              | ✅     | writes files via the `src` API, opens PRs via `/pullrequests`     |
| GitLab (SaaS or self-hosted) | ✅     | writes files via the Commits API, opens MRs via `/merge_requests` |

Provider is auto-detected from CI environment variables (Bitbucket Pipelines sets
`BITBUCKET_WORKSPACE`; GitLab CI sets `CI_PROJECT_ID`/`GITLAB_CI`), so most repos never
need to configure it explicitly. Override with `GIT_PROVIDER=bitbucket` or
`GIT_PROVIDER=gitlab` if you ever need to force it.

Adding a new provider means implementing the interface in `src/providers/bitbucket.mjs` /
`src/providers/gitlab.mjs` (`getContext`, `buildSourceBlock`, `buildGitSourceCredential`,
`getDefaultBranch`, `commitFiles`, `findOpenPr`, `createPullRequest`, `closePullRequest`)
and registering it in `src/providers/index.mjs` — `src/run-updates.mjs` and
`src/create-prs.mjs` don't need to change at all.

## Using it in a repo

### Bitbucket Cloud

Copy [`templates/bitbucket-pipelines.yml`](templates/bitbucket-pipelines.yml) -> `bitbucket-pipelines.yml` and
[`templates/dependabot-config.json`](templates/dependabot-config.json) -> `dependabot-config.json`. Set the three repository
variables listed in the template's header comment, then trigger the `dependabot-update`
custom pipeline manually or on a schedule (Repo settings -> Pipelines -> Schedules).

### GitLab

Copy [`templates/gitlab-ci.yml`](templates/gitlab-ci.yml) -> `.gitlab-ci.yml` and [`templates/dependabot-config.json`](templates/dependabot-config.json)
-> `dependabot-config.json`. Set the CI/CD variables listed in the template's header
comment (Settings -> CI/CD -> Variables), then trigger it manually ("Run pipeline") or on
a schedule (Build -> Pipeline schedules).

Either way: no scripts to copy, no logic to keep in sync. Behaviour for every repo comes
from bumping this package's version.

## What the two CLI commands do

### `dependabot-run-updates`

Reads `./dependabot-config.json` in the current working directory, builds a job
description per entry (using the detected provider's `source` block + `git_source`
credential), and runs `dependabot update`, writing `.dependabot-run/output-N.yaml` + a
`manifest.json` describing what ran.

### `dependabot-create-prs`

Reads `.dependabot-run/manifest.json` (or explicit `output-*.yaml` paths passed as
arguments) and turns each recorded `create_pull_request` / `update_pull_request` /
`close_pull_request` entry into a real PR/MR via the detected provider — no local git
clone needed.

**Filters applied automatically, on every provider:**

- Skips `update_dependency_list` / `mark_as_processed` entries (informational, not PR
  actions).
- Skips transitive-only dependency bumps by default (updates that only touch a lockfile,
  never the manifest) — otherwise `npm_and_yarn` in particular can produce 100+ PRs for a
  small project. Set `SKIP_TRANSITIVE_ONLY_UPDATES=false` to disable.
- Truncates PR/MR descriptions over ~30KB (release notes for monorepo packages like
  `@aws-sdk/*` can be huge; Bitbucket in particular rejects descriptions over ~32KB).

`DRY_RUN=true` runs fully offline and just logs what it would do, for either provider.

## Token env vars

Each provider checks its own env var names first, falling back to the generic
`GIT_READ_TOKEN` / `GIT_WRITE_TOKEN` if unset - handy if you'd rather configure tokens
once and reuse the same CI/CD variable names across providers.

|                                   | Bitbucket             | GitLab                                           |
| --------------------------------- | --------------------- | ------------------------------------------------ |
| Read (used by the updater itself) | `BITBUCKET_GIT_TOKEN` | `GITLAB_TOKEN`                                   |
| Write (used to open PRs/MRs)      | `BITBUCKET_PR_TOKEN`  | `GITLAB_PR_TOKEN` (falls back to `GITLAB_TOKEN`) |

## Testing

```bash
npm install
npm test
```

Unit tests (mocha + chai + sinon) live in `test/`:

- `test/lib/format.test.mjs` - pure helpers (branch naming, title/body generation,
  truncation, the transitive-dependency filter).
- `test/providers/bitbucket.test.mjs`, `test/providers/gitlab.test.mjs` - each provider's
  API calls, with `fetch` stubbed via sinon so nothing touches the network.
- `test/providers/index.test.mjs` - provider auto-detection.
- `test/create-prs.test.mjs`, `test/run-updates.test.mjs` - the orchestration logic, using
  a fake provider object so these tests exercise the actual routing/filtering decisions
  without depending on any specific provider's implementation.

## Local development on this package

```bash
npm install
npm link   # makes dependabot-run-updates / dependabot-create-prs available globally

cd /path/to/some/other/repo
npm link dependabot-for-git
BITBUCKET_WORKSPACE=... BITBUCKET_REPO_SLUG=... ... dependabot-run-updates
```

## ⚠️ Still worth verifying against dpenedabot-cli

The dependabot CLI's job/output schema isn't formally documented. The Bitbucket field
names this package relies on (`updated-dependency-files`, `pr-title`, `pr-body`,
`commit-message`, etc.) were confirmed against real output from `dependabot-cli`; the
GitLab `source` block schema was confirmed against the upstream CLI's own README and a
GitHub issue showing a real GitLab job description, but hasn't been exercised against a
live GitLab run the way the Bitbucket path has. If your fork diverges further, re-check
`src/create-prs.mjs` and the relevant `src/providers/*.mjs` against a fresh `output.yaml`,
ideally with `DRY_RUN=true` first.
