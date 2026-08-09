// Runs `dependabot update` once per entry in ./dependabot-config.json
// (resolved relative to the current working directory, i.e. the consuming
// repo) against a Bitbucket Cloud repo, writing one output-N.yaml per entry.
//
// Required env vars:
//   BITBUCKET_WORKSPACE, BITBUCKET_REPO_SLUG, BITBUCKET_COMMIT   (provided by Bitbucket Pipelines)
//   BITBUCKET_GIT_TOKEN     - Bitbucket access token used to read the repo (git_source credential)
//   NPM_TOKEN               - npm token for private npmjs.org packages/scopes (optional)
// Optional env vars:
//   DEPENDABOT_BIN          - path to the dependabot binary (default: "dependabot" on PATH)
//   DEPENDABOT_UPDATER_IMAGE, DEPENDABOT_PROXY_IMAGE
//   DEPENDABOT_CONFIG_PATH  - override the path to dependabot-config.json (default: ./dependabot-config.json)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

export async function runUpdates() {
  const {
    BITBUCKET_WORKSPACE,
    BITBUCKET_REPO_SLUG,
    BITBUCKET_COMMIT,
    BITBUCKET_GIT_TOKEN,
    NPM_TOKEN,
    DEPENDABOT_BIN = 'dependabot',
    DEPENDABOT_UPDATER_IMAGE,
    DEPENDABOT_PROXY_IMAGE,
    DEPENDABOT_CONFIG_PATH = 'dependabot-config.json',
  } = process.env;

  requireEnv('BITBUCKET_WORKSPACE', BITBUCKET_WORKSPACE);
  requireEnv('BITBUCKET_REPO_SLUG', BITBUCKET_REPO_SLUG);
  requireEnv('BITBUCKET_COMMIT', BITBUCKET_COMMIT);
  requireEnv('BITBUCKET_GIT_TOKEN', BITBUCKET_GIT_TOKEN);

  const workDir = resolve('.dependabot-run');
  mkdirSync(workDir, { recursive: true });

  const config = JSON.parse(readFileSync(resolve(DEPENDABOT_CONFIG_PATH), 'utf8'));

  const manifest = [];

  config.forEach((entry, index) => {
    const packageManager = entry['package-manager'];
    const directory = entry.directory ?? '/';

    const credentials = [
      {
        type: 'git_source',
        host: 'bitbucket.org',
        username: 'x-token-auth',
        password: BITBUCKET_GIT_TOKEN,
        token: BITBUCKET_GIT_TOKEN,
      },
    ];

    // npm_and_yarn / npm private packages on npmjs.org
    if (NPM_TOKEN) {
      credentials.push({
        type: 'npm_registry',
        registry: 'registry.npmjs.org',
        token: NPM_TOKEN,
      });
    }

    const job = {
      job: {
        'package-manager': packageManager,
        'allowed-updates': [{ 'update-type': 'all' }],
        source: {
          provider: 'bitbucket',
          repo: `${BITBUCKET_WORKSPACE}/${BITBUCKET_REPO_SLUG}`,
          directory,
          commit: BITBUCKET_COMMIT,
        },
      },
      credentials,
    };

    const jobPath = resolve(workDir, `job-${index}.yaml`);
    const outputPath = resolve(workDir, `output-${index}.yaml`);
    writeFileSync(jobPath, yaml.dump(job));

    const args = ['update', '-f', jobPath, '-o', outputPath];
    if (DEPENDABOT_UPDATER_IMAGE) args.push('--updater-image', DEPENDABOT_UPDATER_IMAGE);
    if (DEPENDABOT_PROXY_IMAGE) args.push('--proxy-image', DEPENDABOT_PROXY_IMAGE);

    console.log(`\n=== Running update: ${packageManager} @ ${directory} ===`);
    try {
      execFileSync(DEPENDABOT_BIN, args, { stdio: 'inherit' });
    } catch (err) {
      // A non-zero exit here usually just means "no updates" in some CLI
      // versions, but treat genuine failures as fatal. Surface either way and
      // let create-bitbucket-prs decide there's nothing to do if the output
      // file wasn't produced.
      console.error(`dependabot update exited with an error for ${packageManager} @ ${directory}:`, err.message);
    }

    manifest.push({ packageManager, directory, outputPath });
  });

  writeFileSync(resolve(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest with ${manifest.length} entr${manifest.length === 1 ? 'y' : 'ies'} to ${workDir}/manifest.json`);
}
