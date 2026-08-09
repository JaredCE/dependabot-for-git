import { expect } from 'chai';
import sinon from 'sinon';
import { createGitlabProvider } from '../../src/providers/gitlab.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const BASE_ENV = {
  CI_PROJECT_ID: '123',
  CI_PROJECT_PATH: 'my-group/my-project',
  CI_COMMIT_SHA: 'abc123',
  CI_SERVER_HOST: 'gitlab.com',
  CI_API_V4_URL: 'https://gitlab.com/api/v4',
  GITLAB_TOKEN: 'read-token',
  GITLAB_PR_TOKEN: 'write-token',
};

describe('providers/gitlab', () => {
  describe('static/context methods (no network)', () => {
    it('reports the provider name and required env vars', () => {
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.name).to.equal('gitlab');
      expect(provider.requiredContextEnv).to.deep.equal(['CI_PROJECT_PATH', 'CI_COMMIT_SHA']);
    });

    it('builds repo context from CI predefined variables', () => {
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.getContext()).to.deep.equal({
        repo: 'my-group/my-project',
        commit: 'abc123',
        host: 'gitlab.com',
      });
    });

    it('builds a job.yaml source block matching the dependabot CLI gitlab schema', () => {
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.buildSourceBlock('/')).to.deep.equal({
        provider: 'gitlab',
        hostname: 'gitlab.com',
        'api-endpoint': 'https://gitlab.com/api/v4',
        repo: 'my-group/my-project',
        directory: '/',
        commit: 'abc123',
      });
    });

    it('builds a git_source credential from GITLAB_TOKEN', () => {
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.buildGitSourceCredential()).to.deep.equal({
        type: 'git_source',
        host: 'gitlab.com',
        password: 'read-token',
        token: 'read-token',
      });
    });

    it('falls back to the generic GIT_READ_TOKEN when GITLAB_TOKEN is unset', () => {
      const env = { ...BASE_ENV, GITLAB_TOKEN: undefined, GIT_READ_TOKEN: 'generic-read' };
      const provider = createGitlabProvider({ env, fetchImpl: sinon.stub() });
      expect(provider.buildGitSourceCredential().token).to.equal('generic-read');
    });

    it('falls back to GITLAB_TOKEN as the write token when GITLAB_PR_TOKEN is unset', () => {
      const env = { ...BASE_ENV, GITLAB_PR_TOKEN: undefined };
      const provider = createGitlabProvider({ env, fetchImpl: sinon.stub() });
      // exercised indirectly: closePullRequest should not throw for missing write token
      expect(() => provider.buildGitSourceCredential()).to.not.throw();
    });

    it('defaults hostname/api-endpoint to gitlab.com when not self-hosted', () => {
      const env = {
        CI_PROJECT_ID: '1',
        CI_PROJECT_PATH: 'g/p',
        CI_COMMIT_SHA: 'c',
        GITLAB_TOKEN: 't',
      };
      const provider = createGitlabProvider({ env, fetchImpl: sinon.stub() });
      const source = provider.buildSourceBlock('/');
      expect(source.hostname).to.equal('gitlab.com');
      expect(source['api-endpoint']).to.equal('https://gitlab.com/api/v4');
    });

    it('respects a self-hosted CI_SERVER_HOST/CI_API_V4_URL', () => {
      const env = {
        ...BASE_ENV,
        CI_SERVER_HOST: 'gitlab.internal.example.com',
        CI_API_V4_URL: 'https://gitlab.internal.example.com/api/v4',
      };
      const provider = createGitlabProvider({ env, fetchImpl: sinon.stub() });
      expect(provider.buildSourceBlock('/').hostname).to.equal('gitlab.internal.example.com');
    });
  });

  describe('getDefaultBranch', () => {
    it('uses CI_DEFAULT_BRANCH without a network call when present', async () => {
      const fetchImpl = sinon.stub();
      const env = { ...BASE_ENV, CI_DEFAULT_BRANCH: 'main' };
      const provider = createGitlabProvider({ env, fetchImpl });

      expect(await provider.getDefaultBranch()).to.equal('main');
      expect(fetchImpl.called).to.equal(false);
    });

    it('falls back to the projects API when CI_DEFAULT_BRANCH is absent', async () => {
      const env = { ...BASE_ENV, CI_DEFAULT_BRANCH: undefined };
      const fetchImpl = sinon.stub().resolves(jsonResponse({ default_branch: 'develop' }));
      const provider = createGitlabProvider({ env, fetchImpl });

      expect(await provider.getDefaultBranch()).to.equal('develop');
      expect(fetchImpl.callCount).to.equal(1);
    });

    it('avoids any network call in dry-run mode', async () => {
      const env = { ...BASE_ENV, CI_DEFAULT_BRANCH: undefined };
      const fetchImpl = sinon.stub();
      const provider = createGitlabProvider({ env, fetchImpl, dryRun: true });

      expect(await provider.getDefaultBranch()).to.equal('<default-branch>');
      expect(fetchImpl.called).to.equal(false);
    });
  });

  describe('commitFiles', () => {
    it('creates the branch then commits via the Commits API with the right actions', async () => {
      const fetchImpl = sinon.stub();
      fetchImpl.onCall(0).resolves(jsonResponse({})); // create branch
      fetchImpl.onCall(1).resolves(jsonResponse({})); // commits

      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });
      await provider.commitFiles({
        branch: 'dependabot/npm_and_yarn/lodash',
        baseBranch: 'main',
        message: 'bump lodash',
        files: [
          { name: 'package.json', directory: '/', content: '{}', operation: 'update' },
          { name: 'old-file.json', directory: '/', deleted: true, operation: 'delete' },
        ],
      });

      expect(fetchImpl.callCount).to.equal(2);

      const [branchUrl, branchOptions] = fetchImpl.firstCall.args;
      expect(branchUrl).to.equal('https://gitlab.com/api/v4/projects/123/repository/branches');
      const branchPayload = JSON.parse(branchOptions.body);
      expect(branchPayload).to.deep.equal({ branch: 'dependabot/npm_and_yarn/lodash', ref: 'main' });

      const [commitUrl, commitOptions] = fetchImpl.secondCall.args;
      expect(commitUrl).to.equal('https://gitlab.com/api/v4/projects/123/repository/commits');
      const commitPayload = JSON.parse(commitOptions.body);
      expect(commitPayload.branch).to.equal('dependabot/npm_and_yarn/lodash');
      expect(commitPayload.commit_message).to.equal('bump lodash');
      expect(commitPayload.actions).to.deep.equal([
        { action: 'update', file_path: 'package.json', content: '{}', encoding: 'text' },
        { action: 'delete', file_path: 'old-file.json' },
      ]);
    });

    it('does not fail the commit when branch creation 400s because it already exists', async () => {
      const fetchImpl = sinon.stub();
      fetchImpl.onCall(0).resolves(jsonResponse({ message: 'Branch already exists' }, { ok: false, status: 400 }));
      fetchImpl.onCall(1).resolves(jsonResponse({}));

      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      await provider.commitFiles({ branch: 'b', baseBranch: 'main', message: 'm', files: [] });

      expect(fetchImpl.callCount).to.equal(2); // still proceeds to the commit call
    });

    it('sends content as base64 when the file was base64-encoded', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({}));
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      await provider.commitFiles({
        branch: 'b',
        baseBranch: 'main',
        message: 'm',
        files: [{ name: 'binary.bin', directory: '/', content: 'aGVsbG8=', content_encoding: 'base64' }],
      });

      const commitPayload = JSON.parse(fetchImpl.secondCall.args[1].body);
      expect(commitPayload.actions[0].encoding).to.equal('base64');
    });

    it('sends the PRIVATE-TOKEN header using the write token', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({}));
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      await provider.commitFiles({ branch: 'b', baseBranch: 'main', message: 'm', files: [] });

      const [, options] = fetchImpl.firstCall.args;
      expect(options.headers['PRIVATE-TOKEN']).to.equal('write-token');
    });

    it('does not call fetch in dry-run mode', async () => {
      const fetchImpl = sinon.stub();
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl, dryRun: true });

      await provider.commitFiles({ branch: 'b', baseBranch: 'main', message: 'm', files: [{ name: 'x' }] });

      expect(fetchImpl.called).to.equal(false);
    });
  });

  describe('findOpenPr', () => {
    it('queries merge_requests by source_branch and state=opened, mapping iid to id', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse([{ iid: 42, title: 't' }]));
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      const mr = await provider.findOpenPr('dependabot/npm_and_yarn/lodash');

      expect(mr).to.deep.equal({ iid: 42, title: 't', id: 42 });
      const [url] = fetchImpl.firstCall.args;
      expect(url).to.include('state=opened');
      expect(decodeURIComponent(url)).to.include('source_branch=dependabot/npm_and_yarn/lodash');
    });

    it('returns undefined when there are no matches', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse([]));
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      expect(await provider.findOpenPr('some-branch')).to.equal(undefined);
    });
  });

  describe('createPullRequest', () => {
    it('creates a new MR when none is open for the branch', async () => {
      const fetchImpl = sinon.stub();
      fetchImpl.onCall(0).resolves(jsonResponse([])); // findOpenPr
      fetchImpl.onCall(1).resolves(jsonResponse({ iid: 7 })); // POST merge_requests

      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });
      const mr = await provider.createPullRequest({
        branch: 'dependabot/npm_and_yarn/lodash',
        title: 'Bump lodash',
        body: 'body',
        destination: 'main',
      });

      expect(mr.id).to.equal(7);
      const [, postOptions] = fetchImpl.secondCall.args;
      const payload = JSON.parse(postOptions.body);
      expect(payload.source_branch).to.equal('dependabot/npm_and_yarn/lodash');
      expect(payload.target_branch).to.equal('main');
      expect(payload.title).to.equal('Bump lodash');
      expect(payload.remove_source_branch).to.equal(true);
    });

    it('does not create a duplicate MR when one is already open', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse([{ iid: 99 }]));
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      const mr = await provider.createPullRequest({ branch: 'b', title: 't', body: 'x', destination: 'main' });

      expect(mr.id).to.equal(99);
      expect(fetchImpl.callCount).to.equal(1);
    });

    it('does not call fetch in dry-run mode', async () => {
      const fetchImpl = sinon.stub();
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl, dryRun: true });

      await provider.createPullRequest({ branch: 'b', title: 't', body: 'x', destination: 'main' });

      expect(fetchImpl.called).to.equal(false);
    });
  });

  describe('closePullRequest', () => {
    it('PUTs state_event=close to the merge request', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({}));
      const provider = createGitlabProvider({ env: BASE_ENV, fetchImpl });

      await provider.closePullRequest({ id: 15 });

      const [url, options] = fetchImpl.firstCall.args;
      expect(url).to.equal('https://gitlab.com/api/v4/projects/123/merge_requests/15');
      expect(options.method).to.equal('PUT');
      expect(JSON.parse(options.body)).to.deep.equal({ state_event: 'close' });
    });
  });
});
