// Reads the output-*.yaml files produced by `dependabot update -o ...`
// (see src/run-updates.mjs) and turns each recorded call into a real PR/MR
// via whichever git provider is detected/configured.
//
// The dependabot CLI's job-description/output format isn't formally
// documented (see https://github.com/dependabot/cli#job-description-file),
// so this is defensive: it logs anything it doesn't recognise instead of
// crashing, and falls back to sane defaults for titles/messages when the
// updater didn't provide one.
//
// Provider is auto-detected from CI env vars (or set explicitly via
// GIT_PROVIDER=bitbucket|gitlab).
//
// Optional env vars:
//   DRY_RUN=true                    - log what would happen without calling any provider API
//   SKIP_TRANSITIVE_ONLY_UPDATES    - defaults to true; set "false" to also PR transitive-only bumps

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createProvider } from './providers/index.mjs';
import {
  getData,
  IGNORED_OUTPUT_TYPES,
  touchesManifestFile,
  branchNameFor,
  defaultTitle,
  defaultBody,
  truncateBody,
} from './lib/format.mjs';

// js-yaml is CommonJS-only; loading it via createRequire avoids ESM/CJS
// default-export interop issues that can crop up depending on the local
// npm/node_modules setup ("does not provide an export named 'default'").
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

export async function createPullRequests(argv = [], { env = process.env, provider } = {}) {
  const dryRun = env.DRY_RUN === 'true';
  const skipTransitiveOnly = env.SKIP_TRANSITIVE_ONLY_UPDATES !== 'false';

  provider = provider ?? createProvider({ env, dryRun });

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
    const destination = await provider.getDefaultBranch();

    await provider.commitFiles({ branch, baseBranch: destination, message, files });
    await provider.createPullRequest({ branch, title, body: truncateBody(body), destination });
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
    const destination = await provider.getDefaultBranch();
    await provider.commitFiles({ branch, baseBranch: destination, message, files });

    const pr = await provider.findOpenPr(branch);
    if (!pr) {
      // No open PR/MR found for this branch (e.g. it was closed manually) - open a fresh one.
      await provider.createPullRequest({
        branch,
        title: data['pr-title'] ?? defaultTitle(dependencies),
        body: truncateBody(data['pr-body'] ?? defaultBody(dependencies)),
        destination,
      });
    } else {
      console.log(`Pushed update to existing PR/MR !${pr.id} (${branch})`);
    }
  }

  async function handleClosePullRequest(entry) {
    const data = getData(entry);
    const dependencies = data.dependencies ?? [];
    const packageManager = entry['package-manager'] ?? data['package-manager'] ?? 'dependencies';
    const branch = branchNameFor(packageManager, dependencies);

    const pr = await provider.findOpenPr(branch);
    if (!pr) {
      console.log(`close_pull_request: no open PR/MR found for ${branch}, nothing to do`);
      return;
    }
    await provider.closePullRequest(pr);
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
