// Runs `dependabot update` once per entry in ./dependabot-config.json
// (resolved relative to the current working directory, i.e. the consuming
// repo) against whichever git provider is detected/configured, writing one
// output-N.yaml per entry.
//
// Provider is auto-detected from CI env vars (or set explicitly via
// GIT_PROVIDER=bitbucket|gitlab). See src/providers/*.mjs for the env vars
// each provider reads for repo context and tokens.
//
// Optional env vars:
//   NPM_TOKEN               - npm token for private npmjs.org packages/scopes
//   DEPENDABOT_BIN          - path to the dependabot binary (default: "dependabot" on PATH)
//   DEPENDABOT_UPDATER_IMAGE, DEPENDABOT_PROXY_IMAGE
//   DEPENDABOT_CONFIG_PATH  - override the path to dependabot-config.json (default: ./dependabot-config.json)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createProvider } from './providers/index.mjs';

// js-yaml is CommonJS-only; loading it via createRequire avoids ESM/CJS
// default-export interop issues that can crop up depending on the local
// npm/node_modules setup ("does not provide an export named 'default'").
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

export async function runUpdates({ env = process.env, provider, execFileSyncImpl = execFileSync } = {}) {
  provider = provider ?? createProvider({ env });

  const missing = provider.requiredContextEnv.filter((name) => !env[name]);
  if (missing.length) {
    console.error(`Missing required env var(s) for provider "${provider.name}": ${missing.join(', ')}`);
    process.exit(1);
  }

  const {
    NPM_TOKEN,
    DEPENDABOT_BIN = 'dependabot',
    DEPENDABOT_UPDATER_IMAGE,
    DEPENDABOT_PROXY_IMAGE,
    DEPENDABOT_CONFIG_PATH = 'dependabot-config.json',
  } = env;

  const workDir = resolve('.dependabot-run');
  mkdirSync(workDir, { recursive: true });

  const config = JSON.parse(readFileSync(resolve(DEPENDABOT_CONFIG_PATH), 'utf8'));

  const manifest = [];

  config.forEach((entry, index) => {
    const packageManager = entry['package-manager'];
    const directory = entry.directory ?? '/';

    const credentials = [provider.buildGitSourceCredential()];

    // npm_and_yarn / npm private packages on npmjs.org - provider-agnostic,
    // dependabot-core supports this credential type regardless of git host.
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
        source: provider.buildSourceBlock(directory),
      },
      credentials,
    };

    const jobPath = resolve(workDir, `job-${index}.yaml`);
    const outputPath = resolve(workDir, `output-${index}.yaml`);
    writeFileSync(jobPath, yaml.dump(job));

    const args = ['update', '-f', jobPath, '-o', outputPath];
    if (DEPENDABOT_UPDATER_IMAGE) args.push('--updater-image', DEPENDABOT_UPDATER_IMAGE);
    if (DEPENDABOT_PROXY_IMAGE) args.push('--proxy-image', DEPENDABOT_PROXY_IMAGE);

    console.log(`\n=== Running update: ${packageManager} @ ${directory} (${provider.name}) ===`);
    try {
      execFileSyncImpl(DEPENDABOT_BIN, args, { stdio: 'inherit' });
    } catch (err) {
      // A non-zero exit here usually just means "no updates" in some CLI
      // versions, but treat genuine failures as fatal. Surface either way and
      // let create-prs decide there's nothing to do if the output file
      // wasn't produced.
      console.error(`dependabot update exited with an error for ${packageManager} @ ${directory}:`, err.message);
    }

    manifest.push({ packageManager, directory, outputPath });
  });

  writeFileSync(resolve(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote manifest with ${manifest.length} entr${manifest.length === 1 ? 'y' : 'ies'} to ${workDir}/manifest.json`);

  return manifest;
}
