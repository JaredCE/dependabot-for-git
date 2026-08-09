// GitLab provider (GitLab.com or self-hosted). Implements the same interface
// as src/providers/bitbucket.mjs - see that file for the interface contract.
//
// Confirmed against the dependabot CLI's own gitlab job-description examples
// (see https://github.com/dependabot/cli/issues/193 and the CLI README):
//   source:
//     provider: gitlab
//     hostname: gitlab.com
//     api-endpoint: https://gitlab.com/api/v4
//     repo: group/project
//     directory: /
//   credentials:
//     - type: git_source
//       host: gitlab.com
//       password: <token>
//
// GitLab CI predefined variables (https://docs.gitlab.com/ee/ci/variables/predefined_variables.html)
// give us the repo context for free when running inside a GitLab CI job:
// CI_PROJECT_ID, CI_PROJECT_PATH, CI_COMMIT_SHA, CI_SERVER_HOST, CI_API_V4_URL,
// CI_DEFAULT_BRANCH.
export function createGitlabProvider({ env = process.env, fetchImpl = globalThis.fetch, dryRun = false } = {}) {
  const host = env.CI_SERVER_HOST ?? env.GITLAB_HOST ?? 'gitlab.com';
  const apiRoot = env.CI_API_V4_URL ?? `https://${host}/api/v4`;
  const projectId = env.CI_PROJECT_ID ?? env.GITLAB_PROJECT_ID;
  const projectPath = env.CI_PROJECT_PATH ?? env.GITLAB_PROJECT_PATH;
  const commit = env.CI_COMMIT_SHA ?? env.GITLAB_COMMIT;
  // Provider-specific env var names take priority; GIT_READ_TOKEN/GIT_WRITE_TOKEN
  // are the generic fallbacks shared across providers. A single "api"-scoped
  // token can usually serve as both, so GITLAB_TOKEN alone is enough for most setups.
  const readToken = env.GITLAB_TOKEN ?? env.GIT_READ_TOKEN;
  const writeToken = env.GITLAB_PR_TOKEN ?? env.GIT_WRITE_TOKEN ?? readToken;

  // Project ID is preferred (no URL-encoding needed); fall back to the
  // URL-encoded path if only that was supplied.
  const projectIdentifier = projectId ?? (projectPath ? encodeURIComponent(projectPath) : undefined);

  function authHeaders() {
    if (!writeToken) throw new Error('GitLab: set GITLAB_PR_TOKEN (or GIT_WRITE_TOKEN)');
    return { 'PRIVATE-TOKEN': writeToken };
  }

  async function apiFetch(path, options = {}) {
    const url = path.startsWith('http') ? path : `${apiRoot}${path}`;
    const res = await fetchImpl(url, {
      ...options,
      headers: {
        ...authHeaders(),
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitLab API ${options.method ?? 'GET'} ${url} -> ${res.status}: ${body}`);
    }
    return res;
  }

  let defaultBranchCache = env.CI_DEFAULT_BRANCH;

  return {
    name: 'gitlab',
    requiredContextEnv: ['CI_PROJECT_PATH', 'CI_COMMIT_SHA'],

    getContext() {
      return { repo: projectPath, commit, host };
    },

    buildSourceBlock(directory) {
      return {
        provider: 'gitlab',
        hostname: host,
        'api-endpoint': apiRoot,
        repo: projectPath,
        directory,
        commit,
      };
    },

    buildGitSourceCredential() {
      if (!readToken) throw new Error('GitLab: set GITLAB_TOKEN (or GIT_READ_TOKEN)');
      return { type: 'git_source', host, password: readToken, token: readToken };
    },

    async getDefaultBranch() {
      if (defaultBranchCache) return defaultBranchCache;
      if (dryRun) {
        defaultBranchCache = '<default-branch>';
        return defaultBranchCache;
      }
      const res = await apiFetch(`/projects/${projectIdentifier}`);
      const data = await res.json();
      defaultBranchCache = data.default_branch ?? 'main';
      return defaultBranchCache;
    },

    // Creates the branch (if needed) and writes/deletes files on it in one
    // commit via the Commits API. No local git clone needed.
    async commitFiles({ branch, baseBranch, message, files }) {
      if (dryRun) {
        console.log(`[dry-run] would commit ${files.length} file(s) to ${branch} (base: ${baseBranch})`);
        return;
      }

      // Create the branch from baseBranch; ignore failure if it already
      // exists (GitLab returns 400 in that case).
      await apiFetch(`/projects/${projectIdentifier}/repository/branches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, ref: baseBranch }),
      }).catch(() => {});

      const actions = files.map((file) => {
        const path = [file.directory, file.name].filter(Boolean).join('/').replace(/^\/+/, '');
        if (file.deleted || file.operation === 'delete') {
          return { action: 'delete', file_path: path };
        }
        return {
          action: 'update',
          file_path: path,
          content: file.content ?? '',
          encoding: file.content_encoding === 'base64' ? 'base64' : 'text',
        };
      });

      await apiFetch(`/projects/${projectIdentifier}/repository/commits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, commit_message: message, actions }),
      });
    },

    async findOpenPr(branch) {
      const res = await apiFetch(
        `/projects/${projectIdentifier}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`
      );
      const data = await res.json();
      const mr = data[0];
      return mr ? { ...mr, id: mr.iid } : undefined;
    },

    async createPullRequest({ branch, title, body, destination }) {
      if (dryRun) {
        console.log(`[dry-run] would open MR "${title}" ${branch} -> ${destination}`);
        return;
      }

      const existing = await this.findOpenPr(branch);
      if (existing) {
        console.log(`MR already open for ${branch}: !${existing.id} - leaving as-is (new commit was still pushed)`);
        return existing;
      }

      const res = await apiFetch(`/projects/${projectIdentifier}/merge_requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_branch: branch,
          target_branch: destination,
          title,
          description: body,
          remove_source_branch: true,
        }),
      });
      const mr = await res.json();
      console.log(`Opened MR !${mr.iid}: ${title}`);
      return { ...mr, id: mr.iid };
    },

    async closePullRequest(pr) {
      if (dryRun) {
        console.log(`[dry-run] would close MR !${pr.id}`);
        return;
      }
      await apiFetch(`/projects/${projectIdentifier}/merge_requests/${pr.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_event: 'close' }),
      });
      console.log(`Closed MR !${pr.id}`);
    },
  };
}
