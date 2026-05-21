# Releasing

`claude-code-vault-keeper` ships to npm through
[semantic-release](https://semantic-release.gitbook.io/semantic-release/)
on every push to `main`. There is no manual version bump, changelog edit,
or hand-pushed release tag in the normal flow.

## Source of truth

Release behavior is split across three files:

| File | Owns |
|---|---|
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | When release runs, CI gates before publish, GitHub/npm permissions |
| [`.releaserc.json`](../.releaserc.json) | Version calculation, changelog generation, npm publish, GitHub Release |
| [`package.json`](../package.json) | Package name, current checked-in version, publish files, semantic-release dependencies |

The version in `package.json` is maintained by semantic-release. Human
release work should happen through commit messages and pull requests, not by
editing version files.

## Release workflow

The release job runs only for pushes to `main`. It does not run for pull
requests, feature branches, or manual dispatch.

1. Check out full git history so semantic-release can read existing tags.
2. Set up Node 24 and Bun.
3. Install dependencies from `bun.lock`.
4. Build the bundled LSP server.
5. Run the Bun test suite and smoke tests.
6. Run `semantic-release`.

`semantic-release` analyzes Conventional Commits since the last release
tag, computes the next version, updates `CHANGELOG.md` and `package.json`,
commits those files back to `main` with `[skip ci]`, creates the git tag
and GitHub Release, then publishes to npm.

The workflow uses its own concurrency group (`release`) with
`cancel-in-progress: false`. A newer push must not cancel a release that may
already be publishing to npm.

## Required setup

The workflow publishes to npm through OIDC Trusted Publishing. No
`NPM_TOKEN` secret is expected.

Set this up once on npm:

1. Sign in at <https://www.npmjs.com>.
2. Go to the package access page:
   <https://www.npmjs.com/package/claude-code-vault-keeper/access>.
3. Open **Trusted publishers** -> **Add trusted publisher** -> GitHub
   Actions.
4. Use these fields:
   - Organization or user: `nguyenvanduocit`
   - Repository: `claude-code-vault-keeper`
   - Workflow filename: `release.yml`
   - Environment: leave blank
5. Save.

The workflow grants `id-token: write` and sets `NPM_CONFIG_PROVENANCE=true`,
so npm can verify the package was built by this repository's GitHub
Actions run.

## Release permissions

The release workflow requests only the permissions needed by semantic-release:

| Permission | Why it is needed |
|---|---|
| `contents: write` | Push the release commit, create the git tag, create the GitHub Release |
| `id-token: write` | Mint the OIDC token npm uses for Trusted Publishing |
| `issues: write` | Let semantic-release comment on resolved issues |
| `pull-requests: write` | Let semantic-release comment on merged PRs |

Do not add `NPM_TOKEN` unless the publishing model intentionally changes away
from Trusted Publishing.

## Commit messages

Releases are driven by Conventional Commits:

| Commit type | Release result |
|---|---|
| `fix: ...` | Patch release |
| `feat: ...` | Minor release |
| `feat!: ...` or `BREAKING CHANGE:` footer | Major release |
| `chore:`, `ci:`, `docs:`, `refactor:`, `test:` | No release by default |

A push containing only non-releasing commit types exits successfully with
"no release"; that is expected.

Examples:

```text
fix: preserve bodyLine on code content mismatches
feat: expose vault config loader as a public subpath
feat!: remove legacy validation_rules template support
```

For breaking changes, prefer an explicit footer when the subject line would
otherwise be awkward:

```text
feat: simplify schema-engine public exports

BREAKING CHANGE: claude-code-vault-keeper/lib/* deep imports are no longer exported.
```

## Cutting a release

1. Merge the intended commits to `main`.
2. Let the release workflow run:
   <https://github.com/nguyenvanduocit/claude-code-vault-keeper/actions/workflows/release.yml>.
3. Verify the result:
   - `npm view claude-code-vault-keeper version`
   - `bunx claude-code-vault-keeper@latest --version`
   - GitHub Releases:
     <https://github.com/nguyenvanduocit/claude-code-vault-keeper/releases>

Do not run `npm version`, hand-edit `CHANGELOG.md` for the next release, or
push a `vX.Y.Z` tag manually unless you are deliberately repairing a failed
release with full knowledge of semantic-release state.

## Pre-merge checklist

Before merging a PR that should publish a release:

1. Confirm at least one commit has a release-triggering Conventional Commit
   type (`fix`, `feat`, or a breaking-change marker).
2. Confirm the LSP bundle was rebuilt if source under `server/` changed:
   `bun run build`.
3. Run the same local gates as CI:

   ```bash
   bun install --frozen-lockfile
   bun test ./tests
   bun run smoke
   npm pack --dry-run
   ```

4. Inspect `npm pack --dry-run` output when package boundaries changed. The
   `files` allowlist in `package.json` controls what users receive.

## What gets committed during release

[`.releaserc.json`](../.releaserc.json) configures the release plugins:

- `@semantic-release/commit-analyzer`
- `@semantic-release/release-notes-generator`
- `@semantic-release/changelog`
- `@semantic-release/npm`
- `@semantic-release/git`
- `@semantic-release/github`

The release commit includes only:

- `CHANGELOG.md`
- `package.json`

The npm package version is therefore the source of truth for published
releases. The generated release tag points at the semantic-release commit.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Release job says "no release" | Only non-releasing commit types were merged | Merge a `fix:`, `feat:`, or breaking-change commit if a release is intended |
| npm publish fails with auth/OIDC errors | Trusted Publisher config does not match repo/workflow | Re-check npm package access settings: owner, repo, `release.yml`, blank environment |
| semantic-release cannot determine previous release | Tags were not fetched or release history was rewritten | Ensure `actions/checkout` keeps `fetch-depth: 0`; avoid rewriting release tags |
| Package publishes but CLI/LSP is stale | Source changed without rebuilding `server/main.bundled.cjs` before release | Run `bun run build`, commit the bundle if it changed, and let release rerun from `main` |
| `npm pack --dry-run` misses files | `package.json#files` does not include the new path | Update `files` and rerun the dry-run pack check |

If a release partially succeeds, verify npm first. npm versions are
effectively immutable after publish; do not delete/recreate tags until you
know whether the version exists on npm.

## What CI runs on every push / PR

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

- `bun test ./tests` — unit, integration, provider, and CLI tests.
- `bun run smoke` — bundled server smoke + example LSP smoke.
- `npm pack --dry-run` — catches package `files` allowlist regressions.
- Node 18 / 20 / 22 compatibility jobs — install via npm, build the LSP
  bundle, run CLI sanity checks, validate the bundled example vault, and
  exercise `init + validate`.

The CI workflow uses `actions/checkout@v6` and `actions/setup-node@v6`.
Concurrency is enabled so a newer push to the same ref cancels older CI
runs. The release workflow has separate concurrency and does not cancel an
in-flight publish.

## Manual repair policy

Manual tag manipulation is a last resort. If semantic-release fails before
publishing to npm, fix the workflow/config problem and push another commit to
`main`. If npm already has the version, publish a new patch instead of trying
to reuse the failed version.
