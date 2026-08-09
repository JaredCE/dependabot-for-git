import { expect } from 'chai';
import {
  slugify,
  branchNameFor,
  defaultTitle,
  defaultBody,
  truncateBody,
  MAX_PR_BODY_LENGTH,
  getData,
  touchesManifestFile,
  IGNORED_OUTPUT_TYPES,
  MANIFEST_FILENAMES,
} from '../../src/lib/format.mjs';

describe('lib/format', () => {
  describe('slugify', () => {
    it('lowercases and replaces disallowed characters with hyphens', () => {
      expect(slugify('@aws-sdk/client-dynamodb')).to.equal('aws-sdk-client-dynamodb');
    });

    it('strips leading/trailing hyphens produced by disallowed chars', () => {
      expect(slugify('!!!hello!!!')).to.equal('hello');
    });

    it('truncates to 60 characters', () => {
      const long = 'a'.repeat(100);
      expect(slugify(long)).to.have.length(60);
    });

    it('coerces non-string input to a string first', () => {
      expect(slugify(123)).to.equal('123');
    });
  });

  describe('branchNameFor', () => {
    it('builds a branch name from package manager and a single dependency', () => {
      const branch = branchNameFor('npm_and_yarn', [{ name: '@aws-sdk/client-dynamodb' }]);
      expect(branch).to.equal('dependabot/npm_and_yarn/aws-sdk-client-dynamodb');
    });

    it('joins multiple dependencies with "-and-"', () => {
      const branch = branchNameFor('npm_and_yarn', [{ name: 'lodash' }, { name: 'date-fns' }]);
      expect(branch).to.equal('dependabot/npm_and_yarn/lodash-and-date-fns');
    });

    it('falls back to dependency-name key when name is absent', () => {
      const branch = branchNameFor('npm_and_yarn', [{ 'dependency-name': 'lodash' }]);
      expect(branch).to.equal('dependabot/npm_and_yarn/lodash');
    });
  });

  describe('defaultTitle', () => {
    it('formats a single-dependency bump', () => {
      const title = defaultTitle([{ name: 'lodash', 'previous-version': '4.17.20', version: '4.17.21' }]);
      expect(title).to.equal('Bump lodash from 4.17.20 to 4.17.21');
    });

    it('lists names for multiple dependencies', () => {
      const title = defaultTitle([{ name: 'lodash' }, { name: 'date-fns' }]);
      expect(title).to.equal('Bump lodash, date-fns');
    });
  });

  describe('defaultBody', () => {
    it('lists each dependency with its version bump', () => {
      const body = defaultBody([{ name: 'lodash', 'previous-version': '4.17.20', version: '4.17.21' }]);
      expect(body).to.include('`lodash`: 4.17.20 -> 4.17.21');
    });

    it('uses "?" for missing version info', () => {
      const body = defaultBody([{ name: 'lodash' }]);
      expect(body).to.include('`lodash`: ? -> ?');
    });
  });

  describe('truncateBody', () => {
    it('leaves short bodies untouched', () => {
      expect(truncateBody('short body')).to.equal('short body');
    });

    it('passes through null/undefined unchanged', () => {
      expect(truncateBody(undefined)).to.equal(undefined);
      expect(truncateBody(null)).to.equal(null);
    });

    it('truncates bodies over the max length and appends a note', () => {
      const big = 'x'.repeat(MAX_PR_BODY_LENGTH + 10000);
      const result = truncateBody(big);
      expect(result.length).to.be.lessThan(big.length);
      expect(result).to.include('... (truncated');
      expect(result.startsWith('x'.repeat(100))).to.equal(true);
    });

    it('truncates to exactly MAX_PR_BODY_LENGTH before appending the note', () => {
      const big = 'y'.repeat(MAX_PR_BODY_LENGTH + 1);
      const result = truncateBody(big);
      const notePrefix = '\n\n... (truncated';
      const noteIndex = result.indexOf(notePrefix);
      expect(noteIndex).to.equal(MAX_PR_BODY_LENGTH);
    });
  });

  describe('getData', () => {
    it('reads the real nested expect.data shape', () => {
      const entry = { type: 'create_pull_request', expect: { data: { dependencies: ['x'] } } };
      expect(getData(entry)).to.deep.equal({ dependencies: ['x'] });
    });

    it('falls back to a top-level data key', () => {
      const entry = { type: 'create_pull_request', data: { dependencies: ['y'] } };
      expect(getData(entry)).to.deep.equal({ dependencies: ['y'] });
    });

    it('returns an empty object when neither shape is present', () => {
      expect(getData({ type: 'create_pull_request' })).to.deep.equal({});
    });

    it('handles undefined/null entries without throwing', () => {
      expect(getData(undefined)).to.deep.equal({});
      expect(getData(null)).to.deep.equal({});
    });
  });

  describe('IGNORED_OUTPUT_TYPES', () => {
    it('includes the known non-PR output types', () => {
      expect(IGNORED_OUTPUT_TYPES.has('update_dependency_list')).to.equal(true);
      expect(IGNORED_OUTPUT_TYPES.has('mark_as_processed')).to.equal(true);
    });

    it('does not include PR-action types', () => {
      expect(IGNORED_OUTPUT_TYPES.has('create_pull_request')).to.equal(false);
    });
  });

  describe('touchesManifestFile / MANIFEST_FILENAMES', () => {
    it('returns true when a manifest file is present', () => {
      const files = [{ name: 'package.json' }, { name: 'package-lock.json' }];
      expect(touchesManifestFile(files)).to.equal(true);
    });

    it('returns false when only lockfiles are present (transitive-only update)', () => {
      const files = [{ name: 'package-lock.json' }];
      expect(touchesManifestFile(files)).to.equal(false);
    });

    it('returns false for an empty file list', () => {
      expect(touchesManifestFile([])).to.equal(false);
    });

    it('recognises manifests for non-npm ecosystems', () => {
      expect(MANIFEST_FILENAMES.has('Gemfile')).to.equal(true);
      expect(MANIFEST_FILENAMES.has('go.mod')).to.equal(true);
      expect(MANIFEST_FILENAMES.has('Cargo.toml')).to.equal(true);
    });
  });
});
