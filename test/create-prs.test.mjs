import { expect } from 'chai';
import sinon from 'sinon';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createPullRequests } from '../src/create-prs.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

function makeFakeProvider(overrides = {}) {
  return {
    name: 'fake',
    getDefaultBranch: sinon.stub().resolves('main'),
    commitFiles: sinon.stub().resolves(),
    findOpenPr: sinon.stub().resolves(undefined),
    createPullRequest: sinon.stub().resolves({ id: 1 }),
    closePullRequest: sinon.stub().resolves(),
    ...overrides,
  };
}

// Runs createPullRequests with cwd temporarily pointed at a scratch dir so
// the relative path lookups (.dependabot-run/manifest.json etc.) are isolated
// per test.
async function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dependabot-for-git-test-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeOutputFile(dir, filename, outputEntries) {
  const path = join(dir, filename);
  writeFileSync(path, yaml.dump({ output: outputEntries }));
  return path;
}

const DIRECT_DEP_ENTRY = {
  type: 'create_pull_request',
  expect: {
    data: {
      'base-commit-sha': 'abc',
      dependencies: [{ name: 'lodash', 'previous-version': '4.17.20', version: '4.17.21' }],
      'updated-dependency-files': [
        { name: 'package.json', directory: '/', content: '{}', operation: 'update' },
        { name: 'package-lock.json', directory: '/', content: '{}', operation: 'update' },
      ],
    },
  },
};

const TRANSITIVE_ONLY_ENTRY = {
  type: 'create_pull_request',
  expect: {
    data: {
      'base-commit-sha': 'abc',
      dependencies: [{ name: 'some-transitive-dep', 'previous-version': '1.0.0', version: '1.0.1' }],
      'updated-dependency-files': [{ name: 'package-lock.json', directory: '/', content: '{}', operation: 'update' }],
    },
  },
};

describe('create-prs orchestration', () => {
  afterEach(() => {
    delete process.env.DRY_RUN;
    delete process.env.SKIP_TRANSITIVE_ONLY_UPDATES;
  });

  it('opens a PR for a direct dependency update', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [DIRECT_DEP_ENTRY]);
      const provider = makeFakeProvider();

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.commitFiles.calledOnce).to.equal(true);
      expect(provider.createPullRequest.calledOnce).to.equal(true);
      const call = provider.createPullRequest.firstCall.args[0];
      expect(call.branch).to.equal('dependabot/dependencies/lodash');
      expect(call.title).to.equal('Bump lodash from 4.17.20 to 4.17.21');
    });
  });

  it('skips a transitive-only dependency update by default', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [TRANSITIVE_ONLY_ENTRY]);
      const provider = makeFakeProvider();

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.commitFiles.called).to.equal(false);
      expect(provider.createPullRequest.called).to.equal(false);
    });
  });

  it('processes transitive-only updates when SKIP_TRANSITIVE_ONLY_UPDATES=false', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [TRANSITIVE_ONLY_ENTRY]);
      const provider = makeFakeProvider();

      await createPullRequests([outputPath], { env: { SKIP_TRANSITIVE_ONLY_UPDATES: 'false' }, provider });

      expect(provider.commitFiles.calledOnce).to.equal(true);
      expect(provider.createPullRequest.calledOnce).to.equal(true);
    });
  });

  it('handles a mixed file: one direct update opens a PR, one transitive update is skipped', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [DIRECT_DEP_ENTRY, TRANSITIVE_ONLY_ENTRY]);
      const provider = makeFakeProvider();

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.createPullRequest.calledOnce).to.equal(true);
    });
  });

  it('silently ignores update_dependency_list and mark_as_processed entries', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [
        { type: 'update_dependency_list', expect: { data: { dependencies: [] } } },
        { type: 'mark_as_processed', expect: { data: {} } },
      ]);
      const provider = makeFakeProvider();

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.commitFiles.called).to.equal(false);
      expect(provider.createPullRequest.called).to.equal(false);
      expect(provider.closePullRequest.called).to.equal(false);
    });
  });

  it('pushes a new commit to the existing PR/MR on update_pull_request without opening a duplicate', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [
        { ...DIRECT_DEP_ENTRY, type: 'update_pull_request' },
      ]);
      const provider = makeFakeProvider({ findOpenPr: sinon.stub().resolves({ id: 5 }) });

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.commitFiles.calledOnce).to.equal(true);
      expect(provider.createPullRequest.called).to.equal(false); // already open, don't duplicate
    });
  });

  it('opens a fresh PR/MR on update_pull_request if the original was closed manually', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [
        { ...DIRECT_DEP_ENTRY, type: 'update_pull_request' },
      ]);
      const provider = makeFakeProvider({ findOpenPr: sinon.stub().resolves(undefined) });

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.createPullRequest.calledOnce).to.equal(true);
    });
  });

  it('closes the matching PR/MR on close_pull_request', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [
        { ...DIRECT_DEP_ENTRY, type: 'close_pull_request' },
      ]);
      const provider = makeFakeProvider({ findOpenPr: sinon.stub().resolves({ id: 9 }) });

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.closePullRequest.calledOnceWith({ id: 9 })).to.equal(true);
    });
  });

  it('does nothing on close_pull_request when no matching PR/MR is open', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [
        { ...DIRECT_DEP_ENTRY, type: 'close_pull_request' },
      ]);
      const provider = makeFakeProvider({ findOpenPr: sinon.stub().resolves(undefined) });

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.closePullRequest.called).to.equal(false);
    });
  });

  it('continues processing later entries when one entry throws', async () => {
    await withScratchDir(async (dir) => {
      const outputPath = writeOutputFile(dir, 'output-0.yaml', [DIRECT_DEP_ENTRY, DIRECT_DEP_ENTRY]);
      const provider = makeFakeProvider();
      provider.commitFiles.onFirstCall().rejects(new Error('boom'));

      await createPullRequests([outputPath], { env: {}, provider });

      expect(provider.commitFiles.callCount).to.equal(2); // second entry still processed
      expect(process.exitCode).to.equal(1);
      process.exitCode = 0; // reset for subsequent tests
    });
  });

  it('reads from .dependabot-run/manifest.json when no explicit files are passed', async () => {
    await withScratchDir(async (dir) => {
      mkdirSync(join(dir, '.dependabot-run'));
      const outputPath = writeOutputFile(dir, join('.dependabot-run', 'output-0.yaml'), [DIRECT_DEP_ENTRY]);
      writeFileSync(
        join(dir, '.dependabot-run', 'manifest.json'),
        JSON.stringify([{ packageManager: 'npm_and_yarn', outputPath }])
      );
      const provider = makeFakeProvider();

      await createPullRequests([], { env: {}, provider });

      expect(provider.createPullRequest.calledOnce).to.equal(true);
    });
  });

  it('does not throw when an output file referenced by the manifest is missing (no updates found)', async () => {
    await withScratchDir(async (dir) => {
      mkdirSync(join(dir, '.dependabot-run'));
      writeFileSync(
        join(dir, '.dependabot-run', 'manifest.json'),
        JSON.stringify([{ packageManager: 'npm_and_yarn', outputPath: join(dir, '.dependabot-run', 'missing.yaml') }])
      );
      const provider = makeFakeProvider();

      await createPullRequests([], { env: {}, provider });

      expect(provider.createPullRequest.called).to.equal(false);
    });
  });
});
