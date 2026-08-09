// Reads the output-*.yaml files produced by `dependabot update -o ...`
// (see src/run-updates.mjs) and turns each recorded call into a real
// Bitbucket Cloud pull request.
//
// The dependabot CLI's job-description/output format isn't formally
// documented (see https://github.com/dependabot/cli#job-description-file),
// so this is defensive: it logs anything it doesn't recognise instead of
// crashing, and falls back to sane defaults for titles/messages when the
// updater didn't provide one.
//
// Required env vars:
//   BITBUCKET_WORKSPACE, BITBUCKET_REPO_SLUG   (provided by Bitbucket Pipelines)
//   BITBUCKET_PR_TOKEN   - Bitbucket access token with write/PR permissions
//                          (kept separate from the read-only token used to
//                          run the update job, per Dependabot's own guidance)
// Optional:
//   BITBUCKET_USERNAME, BITBUCKET_APP_PASSWORD - alternative to BITBUCKET_PR_TOKEN
//   DRY_RUN=true                    - log what would happen without calling the API
//   SKIP_TRANSITIVE_ONLY_UPDATES    - defaults to true; set "false" to also PR transitive-only bumps

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// js-yaml is CommonJS-only; loading it via createRequire avoids ESM/CJS
// default-export interop issues that can crop up depending on the local
// npm/node_modules setup ("does not provide an export named 'default'").
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// The real output shape nests the payload under `expect.data`, e.g.:
//   - type: create_pull_request
//     expect:
//       data:
//         dependencies: [...]
//         updated-dependency-files: [...]
// Fall back to a top-level `data` key too, in case that ever changes.
function getData(entry) {
  return entry.expect?.data ?? entry.data ?? {};
}

// Output types the CLI emits that don't correspond to a PR action - safe to
// skip quietly rather than logging them as "unhandled".
const IGNORED_OUTPUT_TYPES = new Set(['update_dependency_list', 'mark_as_processed']);

// Filenames that count as "the manifest" per ecosystem - an update whose
// updated-dependency-files ONLY touches lockfiles (e.g. package-lock.json,
// yarn.lock) and never one of these was a transitive/indirect dependency
// bump, not something listed directly in package.json. Left unfiltered,
// npm_and_yarn in particular can produce a separate create_pull_request for
// every transitive package in the lockfile - easily 100+ PRs for a small
// project. Skipped by default; set SKIP_TRANSITIVE_ONLY_UPDATES=false to
// disable this filter and get a PR for every update, direct or not.
const MANIFEST_FILENAMES = new Set(['package.json', 'Gemfile', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json']);

function touchesManifestFile(files) {
  return files.some((f) => MANIFEST_FILENAMES.has(f.name));
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function branchNameFor(packageManager, dependencies) {
  const depSlug = dependencies.map((d) => slugify(d.name ?? d['dependency-name'])).join('-and-');
  return `dependabot/${slugify(packageManager)}/${depSlug}`;
}

function defaultTitle(dependencies) {
  if (dependencies.length === 1) {
    const d = dependencies[0];
    return `Bump ${d.name} from ${d['previous-version']} to ${d.version}`;
  }
  return `Bump ${dependencies.map((d) => d.name).join(', ')}`;
}

function defaultBody(dependencies) {
  const lines = dependencies.map(
    (d) => `- \`${d.name}\`: ${d['previous-version'] ?? '?'} -> ${d.version ?? '?'}`
  );
  return `Dependency updates produced by dependabot CLI:\n\n${lines.join('\n')}`;
}

// pr-body from dependabot-core can be very large (release notes + changelog +
// full commit list per dependency, sometimes tens of KB for monorepo
// packages like @aws-sdk/*). Bitbucket Cloud rejects PR descriptions above
// ~32KB, so truncate defensively rather than let the API call fail outright.
const MAX_PR_BODY_LENGTH = 30000;
function truncateBody(body) {
  if (!body || body.length <= MAX_PR_BODY_LENGTH) return body;
  return `${body.slice(0, MAX_PR_BODY_LENGTH)}\n\n... (truncated, see the original dependency's release notes for the full changelog)`;
}

export async function createPullRequests(argv = []) {
  const {
    BITBUCKET_WORKSPACE,
    BITBUCKET_REPO_SLUG,
    BITBUCKET_PR_TOKEN,
    BITBUCKET_USERNAME,
    BITBUCKET_APP_PASSWORD,
    DRY_RUN,
    SKIP_TRANSITIVE_ONLY_UPDATES,
  } = process.env;

  requireEnv('BITBUCKET_WORKSPACE', BITBUCKET_WORKSPACE);
  requireEnv('BITBUCKET_REPO_SLUG', BITBUCKET_REPO_SLUG);

  if (!BITBUCKET_PR_TOKEN && !(BITBUCKET_USERNAME && BITBUCKET_APP_PASSWORD)) {
    console.error('Set BITBUCKET_PR_TOKEN, or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD');
    process.exit(1);
  }

  const dryRun = DRY_RUN === 'true';
  const skipTransitiveOnly = SKIP_TRANSITIVE_ONLY_UPDATES !== 'false';
  const API_ROOT = 'https://api.bitbucket.org/2.0';
  const repoPath = `${BITBUCKET_WORKSPACE}/${BITBUCKET_REPO_SLUG}`;

  function authHeader() {
    if (BITBUCKET_PR_TOKEN) return `Bearer ${BITBUCKET_PR_TOKEN}`;
    const basic = Buffer.from(`${BITBUCKET_USERNAME}:${BITBUCKET_APP_PASSWORD}`).toString('base64');
    return `Basic ${basic}`;
  }

  async function bbFetch(path, options = {}) {
    const url = path.startsWith('http') ? path : `${API_ROOT}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader(),
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Bitbucket API ${options.method ?? 'GET'} ${url} -> ${res.status}: ${body}`);
    }
    return res;
  }

  let defaultBranchCache;
  async function getDefaultBranch() {
    if (defaultBranchCache) return defaultBranchCache;
    if (dryRun) {
      // Avoid a real API call so DRY_RUN=true works fully offline.
      defaultBranchCache = '<default-branch>';
      return defaultBranchCache;
    }
    const res = await bbFetch(`/repositories/${repoPath}`);
    const data = await res.json();
    defaultBranchCache = data.mainbranch?.name ?? 'main';
    return defaultBranchCache;
  }

  // Writes/deletes the files from an `updated-dependency-files` entry directly
  // to a branch using Bitbucket's "src" endpoint, creating the branch if it
  // doesn't already exist. This avoids needing a local git clone.
  async function commitFiles({ branch, baseBranch, message, files }) {
    const form = new FormData();
    form.append('branch', branch);
    form.append('message', message);
    form.append('author', 'dependabot <noreply@dependabot-cli.local>');

    for (const file of files) {
      const path = [file.directory, file.name].filter(Boolean).join('/').replace(/^\/+/, '');
      if (file.deleted || file.operation === 'delete') {
        form.append('files', path);
        continue;
      }
      const content =
        file.content_encoding === 'base64'
          ? Buffer.from(file.content, 'base64')
          : Buffer.from(file.content ?? '', 'utf8');
      form.append(path, new Blob([content]));
    }

    if (dryRun) {
      console.log(`[dry-run] would commit ${files.length} file(s) to ${branch} (base: ${baseBranch})`);
      return;
    }

    await bbFetch(`/repositories/${repoPath}/src`, {
      method: 'POST',
      body: form,
    });
  }

  async function findOpenPrByBranch(branch) {
    const q = encodeURIComponent(`state="OPEN" AND source.branch.name="${branch}"`);
    const res = await bbFetch(`/repositories/${repoPath}/pullrequests?q=${q}`);
    const data = await res.json();
    return data.values?.[0];
  }

  async function createPullRequest({ branch, title, body }) {
    const destination = await getDefaultBranch();

    if (dryRun) {
      console.log(`[dry-run] would open PR "${title}" ${branch} -> ${destination}`);
      return;
    }

    const existing = await findOpenPrByBranch(branch);
    if (existing) {
      console.log(`PR already open for ${branch}: !${existing.id} - leaving as-is (new commit was still pushed)`);
      return existing;
    }

    const res = await bbFetch(`/repositories/${repoPath}/pullrequests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: truncateBody(body),
        source: { branch: { name: branch } },
        destination: { branch: { name: destination } },
        close_source_branch: true,
      }),
    });
    const pr = await res.json();
    console.log(`Opened PR !${pr.id}: ${title}`);
    return pr;
  }

  async function declinePullRequest(pr) {
    if (dryRun) {
      console.log(`[dry-run] would decline PR !${pr.id}`);
      return;
    }
    await bbFetch(`/repositories/${repoPath}/pullrequests/${pr.id}/decline`, { method: 'POST' });
    console.log(`Declined PR !${pr.id}`);
  }

  async function handleCreatePullRequest(entry) {
    const data = getData(entry);
    const dependencies = data.dependencies ?? [];
    const files = data['updated-dependency-files'] ?? data.updatedDependencyFiles ?? [];
    const packageManager = entry['package-manager'] ?? data['package-manager'] ?? 'dependencies';

    if (!files.length) {
      console.warn('create_pull_request entry had no updated-dependency-files, skipping:', dependencies.map((d) => d.name));
      return;
    }

    if (skipTransitiveOnly && !touchesManifestFile(files)) {
      console.log(
        `Skipping transitive-only update for ${dependencies.map((d) => d.name).join(', ')} ` +
          `(only touches ${files.map((f) => f.name).join(', ')}, not the manifest)`
      );
      return;
    }

    const branch = branchNameFor(packageManager, dependencies);
    const title = data['pr-title'] ?? defaultTitle(dependencies);
    const body = data['pr-body'] ?? data['commit-message'] ?? defaultBody(dependencies);
    const message = data['commit-message'] ?? title;

    await commitFiles({ branch, baseBranch: await getDefaultBranch(), message, files });
    await createPullRequest({ branch, title, body });
  }

  async function handleUpdatePullRequest(entry) {
    const data = getData(entry);
    const dependencies = data.dependencies ?? [];
    const files = data['updated-dependency-files'] ?? data.updatedDependencyFiles ?? [];
    const packageManager = entry['package-manager'] ?? data['package-manager'] ?? 'dependencies';
    const branch = branchNameFor(packageManager, dependencies);

    if (!files.length) {
      console.warn('update_pull_request entry had no updated-dependency-files, skipping:', dependencies.map((d) => d.name));
      return;
    }

    if (skipTransitiveOnly && !touchesManifestFile(files)) {
      console.log(
        `Skipping transitive-only update for ${dependencies.map((d) => d.name).join(', ')} ` +
          `(only touches ${files.map((f) => f.name).join(', ')}, not the manifest)`
      );
      return;
    }

    const message = data['commit-message'] ?? `Update ${dependencies.map((d) => d.name).join(', ')}`;
    await commitFiles({ branch, baseBranch: await getDefaultBranch(), message, files });

    const pr = await findOpenPrByBranch(branch);
    if (!pr) {
      // No open PR found for this branch (e.g. it was closed manually) - open a fresh one.
      await createPullRequest({
        branch,
        title: data['pr-title'] ?? defaultTitle(dependencies),
        body: data['pr-body'] ?? defaultBody(dependencies),
      });
    } else {
      console.log(`Pushed update to existing PR !${pr.id} (${branch})`);
    }
  }

  async function handleClosePullRequest(entry) {
    const data = getData(entry);
    const dependencies = data.dependencies ?? [];
    const packageManager = entry['package-manager'] ?? data['package-manager'] ?? 'dependencies';
    const branch = branchNameFor(packageManager, dependencies);

    const pr = await findOpenPrByBranch(branch);
    if (!pr) {
      console.log(`close_pull_request: no open PR found for ${branch}, nothing to do`);
      return;
    }
    await declinePullRequest(pr);
  }

  async function processOutputFile(outputPath, packageManager) {
    if (!existsSync(outputPath)) {
      console.log(`No output file at ${outputPath} (likely no updates found), skipping`);
      return;
    }
    const parsed = yaml.load(readFileSync(outputPath, 'utf8'));
    const calls = parsed?.output ?? parsed ?? [];

    for (const entry of calls) {
      entry['package-manager'] ??= packageManager;

      if (IGNORED_OUTPUT_TYPES.has(entry.type)) {
        continue;
      }

      try {
        switch (entry.type) {
          case 'create_pull_request':
            await handleCreatePullRequest(entry);
            break;
          case 'update_pull_request':
            await handleUpdatePullRequest(entry);
            break;
          case 'close_pull_request':
            await handleClosePullRequest(entry);
            break;
          default:
            console.log(`Unhandled output type "${entry.type}", skipping`);
        }
      } catch (err) {
        console.error(`Failed to process ${entry.type} entry:`, err.message);
        process.exitCode = 1;
      }
    }
  }

  const manifestPath = resolve('.dependabot-run/manifest.json');
  const explicitFiles = argv;

  if (explicitFiles.length) {
    for (const file of explicitFiles) {
      await processOutputFile(resolve(file), 'dependencies');
    }
    return;
  }

  if (!existsSync(manifestPath)) {
    console.error(`No manifest found at ${manifestPath} and no files passed as arguments.`);
    console.error('Run dependabot-run-updates first, or pass output-*.yaml paths directly.');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const { packageManager, outputPath } of manifest) {
    await processOutputFile(outputPath, packageManager);
  }
}
