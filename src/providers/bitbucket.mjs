// Bitbucket Cloud provider. Implements the common provider interface used by
// src/run-updates.mjs and src/create-prs.mjs:
//   getContext()                               -> { repo, commit, host }
//   buildSourceBlock(directory)                -> job.source block for job.yaml
//   buildGitSourceCredential()                 -> job.credentials[] entry (read-only)
//   getDefaultBranch()
//   commitFiles({ branch, baseBranch, message, files })
//   findOpenPr(branch)                         -> { id, ... } | undefined
//   createPullRequest({ branch, title, body, destination })
//   closePullRequest(pr)
//
// `env` and `fetchImpl` are injectable so this can be unit tested without
// touching real env vars or the network.
export function createBitbucketProvider({ env = process.env, fetchImpl = globalThis.fetch, dryRun = false } = {}) {
  const workspace = env.BITBUCKET_WORKSPACE;
  const repoSlug = env.BITBUCKET_REPO_SLUG;
  const commit = env.BITBUCKET_COMMIT;
  // Provider-specific env var names take priority; GIT_READ_TOKEN/GIT_WRITE_TOKEN
  // are the generic fallbacks shared across providers.
  const readToken = env.BITBUCKET_GIT_TOKEN ?? env.GIT_READ_TOKEN;
  const writeToken = env.BITBUCKET_PR_TOKEN ?? env.GIT_WRITE_TOKEN;
  const username = env.BITBUCKET_USERNAME;
  const appPassword = env.BITBUCKET_APP_PASSWORD;

  const API_ROOT = 'https://api.bitbucket.org/2.0';
  const repoPath = `${workspace}/${repoSlug}`;

  function authHeader() {
    if (writeToken) return `Bearer ${writeToken}`;
    if (username && appPassword) {
      return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
    }
    throw new Error('Bitbucket: set BITBUCKET_PR_TOKEN (or GIT_WRITE_TOKEN), or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD');
  }

  async function apiFetch(path, options = {}) {
    const url = path.startsWith('http') ? path : `${API_ROOT}${path}`;
    const res = await fetchImpl(url, {
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

  return {
    name: 'bitbucket',
    requiredContextEnv: ['BITBUCKET_WORKSPACE', 'BITBUCKET_REPO_SLUG', 'BITBUCKET_COMMIT'],

    getContext() {
      return { repo: repoPath, commit, host: 'bitbucket.org' };
    },

    buildSourceBlock(directory) {
      return { provider: 'bitbucket', repo: repoPath, directory, commit };
    },

    buildGitSourceCredential() {
      if (!readToken) throw new Error('Bitbucket: set BITBUCKET_GIT_TOKEN (or GIT_READ_TOKEN)');
      return {
        type: 'git_source',
        host: 'bitbucket.org',
        username: 'x-token-auth',
        password: readToken,
        token: readToken,
      };
    },

    async getDefaultBranch() {
      if (defaultBranchCache) return defaultBranchCache;
      if (dryRun) {
        // Avoid a real API call so DRY_RUN=true works fully offline.
        defaultBranchCache = '<default-branch>';
        return defaultBranchCache;
      }
      const res = await apiFetch(`/repositories/${repoPath}`);
      const data = await res.json();
      defaultBranchCache = data.mainbranch?.name ?? 'main';
      return defaultBranchCache;
    },

    // Writes/deletes files directly to a branch using Bitbucket's "src"
    // endpoint, creating the branch if it doesn't already exist. Avoids
    // needing a local git clone.
    async commitFiles({ branch, baseBranch, message, files }) {
      if (dryRun) {
        console.log(`[dry-run] would commit ${files.length} file(s) to ${branch} (base: ${baseBranch})`);
        return;
      }

      const form = new FormData();
      form.append('branch', branch);
      form.append('message', message);
      form.append('author', 'dependabot <noreply@dependabot-for-git.local>');

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

      await apiFetch(`/repositories/${repoPath}/src`, { method: 'POST', body: form });
    },

    async findOpenPr(branch) {
      const q = encodeURIComponent(`state="OPEN" AND source.branch.name="${branch}"`);
      const res = await apiFetch(`/repositories/${repoPath}/pullrequests?q=${q}`);
      const data = await res.json();
      return data.values?.[0];
    },

    async createPullRequest({ branch, title, body, destination }) {
      if (dryRun) {
        console.log(`[dry-run] would open PR "${title}" ${branch} -> ${destination}`);
        return;
      }

      const existing = await this.findOpenPr(branch);
      if (existing) {
        console.log(`PR already open for ${branch}: !${existing.id} - leaving as-is (new commit was still pushed)`);
        return existing;
      }

      const res = await apiFetch(`/repositories/${repoPath}/pullrequests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: body,
          source: { branch: { name: branch } },
          destination: { branch: { name: destination } },
          close_source_branch: true,
        }),
      });
      const pr = await res.json();
      console.log(`Opened PR !${pr.id}: ${title}`);
      return pr;
    },

    async closePullRequest(pr) {
      if (dryRun) {
        console.log(`[dry-run] would decline PR !${pr.id}`);
        return;
      }
      await apiFetch(`/repositories/${repoPath}/pullrequests/${pr.id}/decline`, { method: 'POST' });
      console.log(`Declined PR !${pr.id}`);
    },
  };
}
