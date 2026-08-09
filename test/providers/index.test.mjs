import { expect } from 'chai';
import sinon from 'sinon';
import { detectProviderName, createProvider } from '../../src/providers/index.mjs';

describe('providers/index', () => {
  describe('detectProviderName', () => {
    it('prefers an explicit GIT_PROVIDER over anything auto-detected', () => {
      const env = { GIT_PROVIDER: 'gitlab', BITBUCKET_WORKSPACE: 'w' };
      expect(detectProviderName(env)).to.equal('gitlab');
    });

    it('detects bitbucket from BITBUCKET_WORKSPACE', () => {
      expect(detectProviderName({ BITBUCKET_WORKSPACE: 'w' })).to.equal('bitbucket');
    });

    it('detects gitlab from GITLAB_CI', () => {
      expect(detectProviderName({ GITLAB_CI: 'true' })).to.equal('gitlab');
    });

    it('detects gitlab from CI_PROJECT_ID', () => {
      expect(detectProviderName({ CI_PROJECT_ID: '123' })).to.equal('gitlab');
    });

    it('returns undefined when nothing matches', () => {
      expect(detectProviderName({})).to.equal(undefined);
    });
  });

  describe('createProvider', () => {
    it('creates a bitbucket provider when detected', () => {
      const env = {
        BITBUCKET_WORKSPACE: 'w',
        BITBUCKET_REPO_SLUG: 'r',
        BITBUCKET_COMMIT: 'c',
        BITBUCKET_GIT_TOKEN: 't',
      };
      const provider = createProvider({ env, fetchImpl: sinon.stub() });
      expect(provider.name).to.equal('bitbucket');
    });

    it('creates a gitlab provider when detected', () => {
      const env = {
        CI_PROJECT_ID: '1',
        CI_PROJECT_PATH: 'g/p',
        CI_COMMIT_SHA: 'c',
        GITLAB_TOKEN: 't',
      };
      const provider = createProvider({ env, fetchImpl: sinon.stub() });
      expect(provider.name).to.equal('gitlab');
    });

    it('respects an explicit name override even without matching env vars', () => {
      const provider = createProvider({ env: {}, name: 'gitlab', fetchImpl: sinon.stub() });
      expect(provider.name).to.equal('gitlab');
    });

    it('throws a helpful error when no provider can be determined', () => {
      expect(() => createProvider({ env: {} })).to.throw(/Unknown or undetected git provider/);
    });

    it('throws a helpful error for an unrecognised explicit provider name', () => {
      expect(() => createProvider({ env: {}, name: 'gitea' })).to.throw(/gitea/);
    });
  });
});
