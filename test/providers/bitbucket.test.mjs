import { expect } from 'chai';
import sinon from 'sinon';
import { createBitbucketProvider } from '../../src/providers/bitbucket.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const BASE_ENV = {
  BITBUCKET_WORKSPACE: 'my-workspace',
  BITBUCKET_REPO_SLUG: 'my-repo',
  BITBUCKET_COMMIT: 'abc123',
  BITBUCKET_GIT_TOKEN: 'read-token',
  BITBUCKET_PR_TOKEN: 'write-token',
};

describe('providers/bitbucket', () => {
  describe('static/context methods (no network)', () => {
    it('reports the provider name and required env vars', () => {
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.name).to.equal('bitbucket');
      expect(provider.requiredContextEnv).to.deep.equal([
        'BITBUCKET_WORKSPACE',
        'BITBUCKET_REPO_SLUG',
        'BITBUCKET_COMMIT',
      ]);
    });

    it('builds repo context from workspace/slug/commit', () => {
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.getContext()).to.deep.equal({
        repo: 'my-workspace/my-repo',
        commit: 'abc123',
        host: 'bitbucket.org',
      });
    });

    it('builds a job.yaml source block', () => {
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.buildSourceBlock('/packages/api')).to.deep.equal({
        provider: 'bitbucket',
        repo: 'my-workspace/my-repo',
        directory: '/packages/api',
        commit: 'abc123',
      });
    });

    it('builds a git_source credential from BITBUCKET_GIT_TOKEN', () => {
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl: sinon.stub() });
      expect(provider.buildGitSourceCredential()).to.deep.equal({
        type: 'git_source',
        host: 'bitbucket.org',
        username: 'x-token-auth',
        password: 'read-token',
        token: 'read-token',
      });
    });

    it('falls back to the generic GIT_READ_TOKEN when BITBUCKET_GIT_TOKEN is unset', () => {
      const env = { ...BASE_ENV, BITBUCKET_GIT_TOKEN: undefined, GIT_READ_TOKEN: 'generic-read' };
      const provider = createBitbucketProvider({ env, fetchImpl: sinon.stub() });
      expect(provider.buildGitSourceCredential().token).to.equal('generic-read');
    });

    it('throws when no read token is configured at all', () => {
      const env = { ...BASE_ENV, BITBUCKET_GIT_TOKEN: undefined };
      const provider = createBitbucketProvider({ env, fetchImpl: sinon.stub() });
      expect(() => provider.buildGitSourceCredential()).to.throw(/BITBUCKET_GIT_TOKEN/);
    });
  });

  describe('getDefaultBranch', () => {
    it('fetches and caches the repo main branch', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({ mainbranch: { name: 'main' } }));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      const branch1 = await provider.getDefaultBranch();
      const branch2 = await provider.getDefaultBranch();

      expect(branch1).to.equal('main');
      expect(branch2).to.equal('main');
      expect(fetchImpl.callCount).to.equal(1); // cached on second call
    });

    it('avoids any network call in dry-run mode', async () => {
      const fetchImpl = sinon.stub();
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl, dryRun: true });

      const branch = await provider.getDefaultBranch();

      expect(branch).to.equal('<default-branch>');
      expect(fetchImpl.called).to.equal(false);
    });
  });

  describe('commitFiles', () => {
    it('POSTs a multipart form to the src endpoint with branch/message/author', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({}));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      await provider.commitFiles({
        branch: 'dependabot/npm_and_yarn/lodash',
        baseBranch: 'main',
        message: 'bump lodash',
        files: [
          { name: 'package.json', directory: '/', content: '{}', operation: 'update' },
          { name: 'old-file.json', directory: '/', deleted: true, operation: 'delete' },
        ],
      });

      expect(fetchImpl.callCount).to.equal(1);
      const [url, options] = fetchImpl.firstCall.args;
      expect(url).to.equal('https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/src');
      expect(options.method).to.equal('POST');
      expect(options.body).to.be.instanceOf(FormData);
      expect(options.body.get('branch')).to.equal('dependabot/npm_and_yarn/lodash');
      expect(options.body.get('message')).to.equal('bump lodash');
      expect(options.body.get('files')).to.equal('old-file.json');
    });

    it('sends an Authorization Bearer header using the write token', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({}));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      await provider.commitFiles({ branch: 'b', baseBranch: 'main', message: 'm', files: [] });

      const [, options] = fetchImpl.firstCall.args;
      expect(options.headers.Authorization).to.equal('Bearer write-token');
    });

    it('does not call fetch in dry-run mode', async () => {
      const fetchImpl = sinon.stub();
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl, dryRun: true });

      await provider.commitFiles({ branch: 'b', baseBranch: 'main', message: 'm', files: [{ name: 'x' }] });

      expect(fetchImpl.called).to.equal(false);
    });

    it('throws a descriptive error when the API call fails', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({ error: 'nope' }, { ok: false, status: 400 }));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      let error;
      try {
        await provider.commitFiles({ branch: 'b', baseBranch: 'main', message: 'm', files: [] });
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.message).to.include('400');
    });
  });

  describe('findOpenPr', () => {
    it('queries by open state and branch name, returning the first match', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({ values: [{ id: 42 }] }));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      const pr = await provider.findOpenPr('dependabot/npm_and_yarn/lodash');

      expect(pr).to.deep.equal({ id: 42 });
      const [url] = fetchImpl.firstCall.args;
      expect(url).to.include('/pullrequests?q=');
      expect(decodeURIComponent(url)).to.include('state="OPEN"');
      expect(decodeURIComponent(url)).to.include('source.branch.name="dependabot/npm_and_yarn/lodash"');
    });

    it('returns undefined when there are no matches', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({ values: [] }));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      expect(await provider.findOpenPr('some-branch')).to.equal(undefined);
    });
  });

  describe('createPullRequest', () => {
    it('creates a new PR when none is open for the branch', async () => {
      const fetchImpl = sinon.stub();
      fetchImpl.onCall(0).resolves(jsonResponse({ values: [] })); // findOpenPr
      fetchImpl.onCall(1).resolves(jsonResponse({ id: 7 })); // POST pullrequests

      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });
      const pr = await provider.createPullRequest({
        branch: 'dependabot/npm_and_yarn/lodash',
        title: 'Bump lodash',
        body: 'body',
        destination: 'main',
      });

      expect(pr).to.deep.equal({ id: 7 });
      const [, postOptions] = fetchImpl.secondCall.args;
      const payload = JSON.parse(postOptions.body);
      expect(payload.title).to.equal('Bump lodash');
      expect(payload.source.branch.name).to.equal('dependabot/npm_and_yarn/lodash');
      expect(payload.destination.branch.name).to.equal('main');
      expect(payload.close_source_branch).to.equal(true);
    });

    it('does not create a duplicate PR when one is already open', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({ values: [{ id: 99 }] }));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      const pr = await provider.createPullRequest({ branch: 'b', title: 't', body: 'x', destination: 'main' });

      expect(pr).to.deep.equal({ id: 99 });
      expect(fetchImpl.callCount).to.equal(1); // only the findOpenPr lookup, no POST
    });

    it('does not call fetch in dry-run mode', async () => {
      const fetchImpl = sinon.stub();
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl, dryRun: true });

      await provider.createPullRequest({ branch: 'b', title: 't', body: 'x', destination: 'main' });

      expect(fetchImpl.called).to.equal(false);
    });
  });

  describe('closePullRequest', () => {
    it('POSTs to the decline endpoint', async () => {
      const fetchImpl = sinon.stub().resolves(jsonResponse({}));
      const provider = createBitbucketProvider({ env: BASE_ENV, fetchImpl });

      await provider.closePullRequest({ id: 15 });

      const [url, options] = fetchImpl.firstCall.args;
      expect(url).to.equal('https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/pullrequests/15/decline');
      expect(options.method).to.equal('POST');
    });
  });
});
