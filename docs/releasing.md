# Releasing

`vault-keeper` ships to npm via GitHub Actions. The release
flow is **tag-driven**: pushing a semver tag (`vX.Y.Z`) triggers
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
verifies the tag matches `package.json`, runs the full test + smoke
gauntlet, publishes to npm with OIDC-signed provenance, and cuts a GitHub
Release whose body is auto-extracted from `CHANGELOG.md`.

## One-time setup

The workflow needs ONE of the two npm authentication paths below. Pick
whichever is easier — provenance (OIDC) is the modern default, NPM token
is the universal fallback.

### Option A — OIDC Trusted Publisher (recommended)

No long-lived secret on GitHub. Setup:

1. Sign in at <https://www.npmjs.com>.
2. Go to the package page →
   [npmjs.com/package/vault-keeper/access](https://www.npmjs.com/package/vault-keeper/access).
3. **Trusted publishers** → **Add trusted publisher** → GitHub Actions.
4. Fields:
   - Organization or user: `nguyenvanduocit`
   - Repository: `vault-keeper`
   - Workflow filename: `release.yml`
   - Environment: *(leave blank)*
5. Save. From now on, the workflow's `id-token: write` permission +
   `npm publish --provenance` is sufficient.

The published package gets a verified provenance badge — consumers can
verify the tarball was built from the exact commit in this repo.

### Option B — Classic NPM_TOKEN

Quicker to set up but rotates manually.

1. <https://www.npmjs.com/settings/{your-user}/tokens> → **Generate New
   Token** → **Automation**.
2. Copy the token (`npm_…`).
3. GitHub → repo Settings → Secrets and variables → Actions → **New
   repository secret**:
   - Name: `NPM_TOKEN`
   - Value: paste the npm token.

The release workflow reads `NPM_TOKEN` from `secrets.NPM_TOKEN` and uses
it as `NODE_AUTH_TOKEN` for `npm publish`.

## Cutting a release

Run the following from `main`. Everything is reversible up to the
`git push --tags` step; the npm publish itself is **immutable** (you can
deprecate a version but not delete it after 72 h).

1. **Update CHANGELOG.md** — add a `## [X.Y.Z] — YYYY-MM-DD` section at
   the top with the deltas (Added / Changed / Removed / Fixed /
   Internal). The release workflow extracts this section verbatim as the
   GitHub Release body.

2. **Bump versions in sync** — `package.json` AND
   `.claude-plugin/plugin.json` MUST agree (the release workflow
   asserts `package.json` matches the tag; the plugin manifest is for
   Claude Code marketplace consumers and should track it).

   ```bash
   # Example: 0.6.0 → 0.6.1
   npm version --no-git-tag-version 0.6.1
   # then hand-edit .claude-plugin/plugin.json to 0.6.1
   ```

3. **Commit + push to `main`** — let CI run green.

   ```bash
   git add CHANGELOG.md package.json .claude-plugin/plugin.json
   git commit -m "chore(release): 0.6.1"
   git push
   ```

4. **Tag + push the tag**. This is the actual release trigger:

   ```bash
   git tag -a v0.6.1 -m "v0.6.1 — <one-line summary>"
   git push --tags
   ```

5. **Watch the release workflow run** —
   <https://github.com/nguyenvanduocit/claude-code-vault-keeper/actions/workflows/release.yml>.
   It re-runs tests, asserts the tag-vs-package version, publishes to
   npm, then opens a GitHub Release.

6. **Verify** —
   - `npm view vault-keeper version` → matches the tag.
   - `bunx vault-keeper@X.Y.Z --version` → matches.
   - <https://github.com/nguyenvanduocit/claude-code-vault-keeper/releases/tag/vX.Y.Z>
     has the CHANGELOG content as its body.

## Manual override

The same workflow accepts `workflow_dispatch` with a `tag` input — useful
if a tag was already pushed but the workflow needs a rerun (e.g. after
fixing a Trusted Publisher misconfig). Trigger from the Actions tab → run
workflow → enter `v0.6.1`.

## What CI runs on every push / PR

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

- `bun test` — full unit + integration + cli-main suite.
- `bun run smoke` — server LSP smoke + example LSP smoke.
- `npm pack --dry-run` — catches `files` allowlist regressions before
  release.
- Node 18 / 20 / 22 compat job — installs runtime deps via `npm` (no
  bun), then exercises `vault-keeper --version`, `doctor`, `validate
  --root examples/example`, and an `init + validate` round-trip. Catches
  Node-version-specific breakage early.

Concurrency is set so a new push to the same branch cancels the previous
in-flight run.
