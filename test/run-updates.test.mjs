import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runUpdates } from '../src/run-updates.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function makeFakeProvider(overrides = {}) {
  return {
    name: 'fake',
    requiredContextEnv: [],
    getContext: () => ({ repo: 'group/project', commit: 'abc123', host: 'example.com' }),
    buildSourceBlock: (directory) => ({ provider: 'fake', repo: 'group/project', directory, commit: 'abc123' }),
    buildGitSourceCredential: () => ({ type: 'git_source', host: 'example.com', password: 'token', token: 'token' }),
    ...overrides,
  };
}

async function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-for-git-run-updates-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir, entries) {
  writeFileSync(join(dir, 'dependabot-config.json'), JSON.stringify(entries));
}

describe('run-updates orchestration', () => {
  it('generates a job.yaml per config entry using the provider source block and credential', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      await runUpdates({ env: {}, provider, execFileSyncImpl });

      const jobPath = join(dir, '.dependabot-run', 'job-0.yaml');
      expect(existsSync(jobPath)).to.equal(true);
      const job = yaml.load(readFileSync(jobPath, 'utf8'));

      expect(job.job['package-manager']).to.equal('npm_and_yarn');
      expect(job.job.source).to.deep.equal({ provider: 'fake', repo: 'group/project', directory: '/', commit: 'abc123' });
      expect(job.credentials).to.deep.equal([{ type: 'git_source', host: 'example.com', password: 'token', token: 'token' }]);
    });
  });

  it('adds an npm_registry credential when NPM_TOKEN is set', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      await runUpdates({ env: { NPM_TOKEN: 'npm-secret' }, provider, execFileSyncImpl });

      const job = yaml.load(readFileSync(join(dir, '.dependabot-run', 'job-0.yaml'), 'utf8'));
      expect(job.credentials).to.deep.include({
        type: 'npm_registry',
        registry: 'registry.npmjs.org',
        token: 'npm-secret',
      });
    });
  });

  it('omits the npm_registry credential when NPM_TOKEN is unset', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      await runUpdates({ env: {}, provider, execFileSyncImpl });

      const job = yaml.load(readFileSync(join(dir, '.dependabot-run', 'job-0.yaml'), 'utf8'));
      expect(job.credentials).to.have.length(1);
    });
  });

  it('generates one job/output pair per config entry, in order', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [
        { 'package-manager': 'npm_and_yarn', directory: '/' },
        { 'package-manager': 'npm_and_yarn', directory: '/packages/api' },
      ]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      const manifest = await runUpdates({ env: {}, provider, execFileSyncImpl });

      expect(manifest).to.have.length(2);
      expect(manifest[0].directory).to.equal('/');
      expect(manifest[1].directory).to.equal('/packages/api');
      expect(execFileSyncImpl.callCount).to.equal(2);
    });
  });

  it('invokes the dependabot binary with -f/-o pointing at the generated files', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      await runUpdates({ env: { DEPENDABOT_BIN: '/usr/local/bin/dependabot' }, provider, execFileSyncImpl });

      expect(execFileSyncImpl.calledOnce).to.equal(true);
      const [bin, args] = execFileSyncImpl.firstCall.args;
      expect(bin).to.equal('/usr/local/bin/dependabot');
      expect(args).to.include('update');
      expect(args).to.include('-f');
      expect(args).to.include('-o');
      expect(args[args.indexOf('-f') + 1]).to.equal(join(dir, '.dependabot-run', 'job-0.yaml'));
      expect(args[args.indexOf('-o') + 1]).to.equal(join(dir, '.dependabot-run', 'output-0.yaml'));
    });
  });

  it('passes through updater/proxy image overrides when set', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      await runUpdates({
        env: { DEPENDABOT_UPDATER_IMAGE: 'my/updater:latest', DEPENDABOT_PROXY_IMAGE: 'my/proxy:latest' },
        provider,
        execFileSyncImpl,
      });

      const [, args] = execFileSyncImpl.firstCall.args;
      expect(args).to.include('--updater-image');
      expect(args).to.include('my/updater:latest');
      expect(args).to.include('--proxy-image');
      expect(args).to.include('my/proxy:latest');
    });
  });

  it('does not throw when the dependabot binary exits non-zero, and still records the manifest entry', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub().throws(new Error('exit 1'));

      const manifest = await runUpdates({ env: {}, provider, execFileSyncImpl });

      expect(manifest).to.have.length(1);
    });
  });

  it('exits with an error when a required context env var is missing for the provider', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider({ requiredContextEnv: ['SOME_REQUIRED_VAR'] });
      const execFileSyncImpl = sinon.stub();
      const exitStub = sinon.stub(process, 'exit').throws(new Error('process.exit called'));

      try {
        await runUpdates({ env: {}, provider, execFileSyncImpl });
        expect.fail('expected runUpdates to call process.exit');
      } catch (err) {
        expect(err.message).to.equal('process.exit called');
      } finally {
        exitStub.restore();
      }
    });
  });

  it('writes manifest.json summarising every job that ran', async () => {
    await withScratchDir(async (dir) => {
      writeConfig(dir, [{ 'package-manager': 'npm_and_yarn', directory: '/' }]);
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      await runUpdates({ env: {}, provider, execFileSyncImpl });

      const manifest = JSON.parse(readFileSync(join(dir, '.dependabot-run', 'manifest.json'), 'utf8'));
      expect(manifest).to.have.length(1);
      expect(manifest[0]).to.include({ packageManager: 'npm_and_yarn', directory: '/' });
    });
  });

  it('respects DEPENDABOT_CONFIG_PATH to read config from a custom location', async () => {
    await withScratchDir(async (dir) => {
      writeFileSync(join(dir, 'custom-config.json'), JSON.stringify([{ 'package-manager': 'bundler', directory: '/' }]));
      const provider = makeFakeProvider();
      const execFileSyncImpl = sinon.stub();

      const manifest = await runUpdates({
        env: { DEPENDABOT_CONFIG_PATH: 'custom-config.json' },
        provider,
        execFileSyncImpl,
      });

      expect(manifest[0].packageManager).to.equal('bundler');
    });
  });
});
