// Pure, provider-agnostic helpers. No network calls, no process.env reads -
// kept this way deliberately so they're trivial to unit test.

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function branchNameFor(packageManager, dependencies) {
  const depSlug = dependencies.map((d) => slugify(d.name ?? d['dependency-name'])).join('-and-');
  return `dependabot/${slugify(packageManager)}/${depSlug}`;
}

export function defaultTitle(dependencies) {
  if (dependencies.length === 1) {
    const d = dependencies[0];
    return `Bump ${d.name} from ${d['previous-version']} to ${d.version}`;
  }
  return `Bump ${dependencies.map((d) => d.name).join(', ')}`;
}

export function defaultBody(dependencies) {
  const lines = dependencies.map(
    (d) => `- \`${d.name}\`: ${d['previous-version'] ?? '?'} -> ${d.version ?? '?'}`
  );
  return `Dependency updates produced by dependabot CLI:\n\n${lines.join('\n')}`;
}

// pr-body from dependabot-core can be very large (release notes + changelog +
// full commit list per dependency, sometimes tens of KB for monorepo
// packages like @aws-sdk/*). Bitbucket Cloud rejects PR descriptions above
// ~32KB and GitLab has its own (larger, but still finite) limit, so truncate
// defensively rather than let a provider API call fail outright.
export const MAX_PR_BODY_LENGTH = 30000;
export function truncateBody(body) {
  if (!body || body.length <= MAX_PR_BODY_LENGTH) return body;
  return `${body.slice(0, MAX_PR_BODY_LENGTH)}\n\n... (truncated, see the original dependency's release notes for the full changelog)`;
}

// The real dependabot CLI output shape nests the payload under `expect.data`, e.g.:
//   - type: create_pull_request
//     expect:
//       data:
//         dependencies: [...]
//         updated-dependency-files: [...]
// Fall back to a top-level `data` key too, in case that ever changes.
export function getData(entry) {
  return entry?.expect?.data ?? entry?.data ?? {};
}

// Output types the CLI emits that don't correspond to a PR action - safe to
// skip quietly rather than logging them as "unhandled".
export const IGNORED_OUTPUT_TYPES = new Set(['update_dependency_list', 'mark_as_processed']);

// Filenames that count as "the manifest" per ecosystem - an update whose
// updated-dependency-files ONLY touches lockfiles (e.g. package-lock.json,
// yarn.lock) and never one of these was a transitive/indirect dependency
// bump, not something listed directly in package.json. Left unfiltered,
// npm_and_yarn in particular can produce a separate create_pull_request for
// every transitive package in the lockfile - easily 100+ PRs for a small
// project.
export const MANIFEST_FILENAMES = new Set([
  'package.json',
  'Gemfile',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'composer.json',
]);

export function touchesManifestFile(files) {
  return files.some((f) => MANIFEST_FILENAMES.has(f.name));
}
