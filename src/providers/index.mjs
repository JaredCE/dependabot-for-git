import { createBitbucketProvider } from './bitbucket.mjs';
import { createGitlabProvider } from './gitlab.mjs';

// Auto-detects which CI system we're running in from the env vars that
// system provides automatically, so most repos never need to set
// GIT_PROVIDER explicitly. Explicit GIT_PROVIDER always wins.
export function detectProviderName(env = process.env) {
  if (env.GIT_PROVIDER) return env.GIT_PROVIDER;
  if (env.BITBUCKET_WORKSPACE) return 'bitbucket';
  if (env.GITLAB_CI || env.CI_PROJECT_ID) return 'gitlab';
  return undefined;
}

const FACTORIES = {
  bitbucket: createBitbucketProvider,
  gitlab: createGitlabProvider,
};

export function createProvider({ env = process.env, fetchImpl = globalThis.fetch, dryRun = false, name } = {}) {
  const providerName = name ?? detectProviderName(env);
  const factory = providerName && FACTORIES[providerName];
  if (!factory) {
    throw new Error(
      `Unknown or undetected git provider "${providerName}". ` +
        `Set GIT_PROVIDER to one of: ${Object.keys(FACTORIES).join(', ')}.`
    );
  }
  return factory({ env, fetchImpl, dryRun });
}
