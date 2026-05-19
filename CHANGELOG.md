# Changelog

All notable changes are tracked here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
adheres to [Semantic Versioning](https://semver.org/).

> **Note:** versions ≤ 0.6.1 were published on npm under the name
> `claude-code-vault-keeper`. The package was renamed to **`vault-keeper`**
> in v0.7.0 to match the binary name. The legacy npm name is deprecated
> with a redirect notice; install paths and historical CHANGELOG entries
> still reference it for accuracy.

## [0.7.0] — 2026-05-19

Renamed the npm package + Claude Code plugin manifest from
`claude-code-vault-keeper` to **`vault-keeper`** so the package, the
binary, and the plugin all share one name. Install command becomes
`npm i vault-keeper` (was `npm i claude-code-vault-keeper`); the
`vault-keeper` binary on `$PATH` is unchanged. Claude Code plugin install
becomes `claude plugin install vault-keeper@vault-keeper` (was
`claude plugin install claude-code-vault-keeper@vault-keeper`).

The GitHub repo URL — `github.com/nguyenvanduocit/claude-code-vault-keeper`
— is **unchanged**; only the npm name and the Claude Code plugin
manifest name moved.

### Why

Two names (package vs. binary) created discoverability friction:
`npm search vault-keeper` missed the package, blog posts that wrote
`vault-keeper` couldn't be copy-pasted into `npm install`, and a future
squatter could have shipped malware under the unclaimed `vault-keeper`
name. With the rename, the brand is one word everywhere.

### Migration

Existing users on the old name:

```bash
npm uninstall claude-code-vault-keeper && npm i vault-keeper
# or:
bun remove claude-code-vault-keeper && bun add vault-keeper
```

Existing Claude Code plugin users:

```bash
claude plugin uninstall claude-code-vault-keeper@vault-keeper
claude plugin install vault-keeper@vault-keeper
```

The CLI surface, flag set, exit codes, LSP behavior, config file, and
template-rule vocabulary are **unchanged** from 0.6.1.

### Changed

- `package.json`: `name` → `vault-keeper`, version bumped to 0.7.0.
- `.claude-plugin/plugin.json`: `name` → `vault-keeper`, version bumped
  to 0.7.0.
- `.claude-plugin/marketplace.json`: `plugins[0].name` → `vault-keeper`.
- README, docs/*, examples/*, CLAUDE.md, server logs (`server/main.js`
  `serverInfo.name` + console banner), `cli/main.js` (`PLUGIN_NAME`,
  install messaging), `tests/cli-main.test.js`: every non-URL mention of
  the old package name is now `vault-keeper`. GitHub URLs preserved.
- LSP bundle (`server/main.bundled.cjs`) rebuilt from updated source.

## [0.6.1] — 2026-05-19

Hotfix for v0.6.0. The published bins were silently no-ops when invoked
through the `node_modules/.bin/` symlink that npm/bun creates on install
— both `vault-keeper` and `vault-keeper-validate` would exit 0 with no
output. Running the scripts directly under `node …` worked because the
bug was in the entry guard, not the dispatch.

### Fixed

- **Entry guards** in `cli/main.js` and `cli/validate-documents.js` now
  resolve `process.argv[1]` with `realpathSync` before comparing to
  `import.meta.url`. Under symlink invocation `argv[1]` is the symlink
  path while `import.meta.url` is always the realpath of the module —
  the unresolved comparison diverged and `main()` was skipped silently.
  `vault-keeper --version` (and every subcommand) now prints again.

### Tests

- `tests/cli-main.test.js` adds a regression test that creates a
  symlink to each bin in a tmpdir and asserts the invocation through
  the symlink produces output. Catches any future regression of the
  entry-guard logic.

## [0.6.0] — 2026-05-19

Adds a multi-command CLI surface — `vault-keeper <subcommand>` — without
breaking the existing `vault-keeper-validate` bin. The new dispatcher is
the primary install path going forward; the validate-only bin is kept as
an alias for backwards compatibility.

### Added

- **New bin `vault-keeper`** (entry: `cli/main.js`). Subcommands:
  - `validate [--root … --path … --strict --json]` — delegates to the
    existing validator without spawning a subprocess (in-process import).
  - `doctor [--json]` — health-check: Node version, bun runtime, claude
    CLI, LSP bundle, cwd vault config, cwd `templates/` dir. Returns a
    structured report or human-readable checklist. Exit 1 on any error.
  - `install-claude-code-plugin` — wraps `claude marketplace add` +
    `claude plugin install`. Prints manual steps when `claude` is absent
    rather than failing silently.
  - `init [<dir>] [--force]` — scaffolds a minimal vault skeleton
    (`.claude/vault-keeper.json`, `templates/note-template.md`,
    `notes/note-001-hello.md`). Refuses to clobber a non-empty target
    without `--force`. Sample doc validates clean immediately.
  - `help [<command>]`, `--version` / `-v`, `--help` / `-h`.
- **`tests/cli-main.test.js`** — 10 end-to-end tests for the new CLI
  (help/version, doctor JSON, init scaffolding, init + validate round
  trip, validate sub matches direct-invocation output, unknown command
  exits 1).

### Changed

- **`cli/validate-documents.js`**: `main` now accepts an optional `argv`
  parameter (default `process.argv.slice(2)`) so the multi-tool can
  dispatch into it. `main` is now exported. Entry guard replaced with a
  portable `import.meta.url === pathToFileURL(process.argv[1]).href`
  check so direct invocation works under any ESM runtime.
- **`package.json`**: `bin` now declares both `vault-keeper` and
  `vault-keeper-validate`; description updated to mention subcommands;
  version bumped 0.5.0 → 0.6.0.
- **`.claude-plugin/plugin.json`**: version bumped to 0.6.0.
- **README + `docs/getting-started.md`** rewritten around the multi-tool
  surface. Subcommand table, `install-claude-code-plugin` and `doctor`
  walkthroughs, and the `init` + `validate` round-trip replace the old
  "verify the install" recipe.

### Internal

- `cli/main.js` is chmod +x and ESM-only. No new runtime dependencies —
  uses only `node:fs`, `node:path`, `node:child_process`, `node:url`.

## [0.5.0] — 2026-05-19

First version published to the npm registry. Aimed at making the tool
installable without cloning the repo, and at consolidating the example
vault as both authoring reference and test dataset.

### Added

- **Bundled example vault** at `examples/example/` doubles as the
  canonical test dataset (`tests/example-vault.test.js` +
  `tests/example-vault.expectations.json`). 25 fixtures (6 valid, 19
  invalid `-invalid.md`) cover 16 distinct validator diagnostic kinds.
  A coverage assertion in the test suite fails if a new diagnostic kind
  ships without a fixture.
- **`templates/decision-template.md`** — fourth template demonstrating
  advanced rule recipes the PRD template does not exercise: compound
  DSL with `and`, DSL `not in`, conditional `min_count`, conditional
  `severity: warning`.
- **`examples/example/README.md`** — fixture map: every fixture filename
  → diagnostic kind it demonstrates, plus add-a-fixture workflow.
- **`LICENSE`** — MIT (was `UNLICENSED`).
- **`CHANGELOG.md`** — this file.
- **`smoke:server` / `smoke:example`** npm scripts. Default `smoke` now
  runs both server LSP smoke and example LSP smoke sequentially.

### Changed

- **Distribution: npm-first.** Removed `"private": true`; added
  `repository`, `homepage`, `bugs`, `keywords`, `engines (>=18)`,
  `files` allowlist. Recommended install path is now `bunx` / `npx` /
  `bun add` / `npm i` — `git clone` is reserved for contributors.
- **CLI shebang** of `cli/validate-documents.js` changed from
  `#!/usr/bin/env bun` to `#!/usr/bin/env node`. `bunx` still works
  (bun is node-compatible) and `npx` now works without a bun runtime
  on `$PATH`. The CLI itself uses no bun-specific APIs.
- **`validate*` npm scripts** now invoke `node` directly instead of
  `bun`, so contributors without bun can still drive them from a
  cloned checkout. (`test` still uses `bun test` since it depends on
  bun's test runner.)
- **`server/smoke.js`** now targets `examples/example/` instead of the
  removed `tests/fixtures/vault-mini/`. Hover-line offset bumped from
  4 → 5 to track the new broken-PRD's added `title:` line.
- **`docs/getting-started.md`** rewritten around the new install paths
  (bunx / global / project dev-dep / Claude Code marketplace). Drops
  the previous "clone then run from plugin directory" instructions.
- **`README.md`** Quick start rewritten to mirror getting-started.

### Removed

- **`examples/minimal-vault/`** — superseded by `examples/example/`.
- **`tests/fixtures/vault-mini/`** — superseded by `examples/example/`.
  No backwards-compatibility shim (greenfield project).

### Internal

- LSP bundle (`server/main.bundled.cjs`) rebuilt from `server/main.js`
  via `esbuild` (no source changes; the bundle just gets re-emitted on
  every release via the `prepublishOnly` script).
- `prepublishOnly` runs `npm run build && bun test ./tests` so the
  bundle published to npm is always fresh and the test suite is green.

## [0.4.0] — pre-npm

Last version distributed solely as a Claude Code plugin source tree.
Collapsed the legacy `namingPatterns` config into per-template
`path_regex`.

## [0.1.0–0.3.0] — pre-npm

Initial LSP server, CLI validator, and template-rules engine. Not
distributed via npm.
