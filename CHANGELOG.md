## [0.12.1](https://github.com/nguyenvanduocit/claude-code-vault-keeper/compare/v0.12.0...v0.12.1) (2026-05-21)


### Bug Fixes

* sync Claude plugin version during release ([b2bcf9b](https://github.com/nguyenvanduocit/claude-code-vault-keeper/commit/b2bcf9b1d9cfb7ce411bf3c7b2704fdb2f26e477))

# [0.12.0](https://github.com/nguyenvanduocit/claude-code-vault-keeper/compare/v0.11.0...v0.12.0) (2026-05-21)


### Features

* validate mermaid and gherkin fences ([0fa0650](https://github.com/nguyenvanduocit/claude-code-vault-keeper/commit/0fa06500004bd29f0888e9b9b29ef273484318ff))

# [0.11.0](https://github.com/nguyenvanduocit/claude-code-vault-keeper/compare/v0.10.0...v0.11.0) (2026-05-21)


### Features

* add vault help skill ([22aa7af](https://github.com/nguyenvanduocit/claude-code-vault-keeper/commit/22aa7af15242a9009e04de71602424158096f310))

# Changelog

All notable changes to `claude-code-vault-keeper` are tracked here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/).

## [0.10.0] — 2026-05-21

### Added — richer primitive registry

- **`type: time`** — 24-hour `HH:MM` or `HH:MM:SS` (no timezone).
- **`type: datetime`** — ISO 8601 / RFC 3339 string or `Date` instance.
  Bare `YYYY-MM-DD` (no time part) is rejected — use `type: date`.
- **`before` / `after`** — chronological bounds usable on any of
  `date` / `datetime` / `time`. Template meta-validation rejects them
  when applied to a non-chronological type or with a bound that does
  not parse under the declared type.
- **`list` primitive** — list-level `min` / `max` / `unique` plus
  per-item `required` / `pattern` / `enum`. Per-item diagnostics are
  anchored at the offending item's own line, not the list head.
- **`code` primitive** — `min` / `max` fence counts and a `content.pattern`
  applied per matching fence (one issue per failing fence, each anchored
  at its own fence line). `lang` filter retained.
- **`table` primitive** — `columns:` now accepts either the shorthand
  `[string]` form (each entry = required header) or an expanded
  `[{ name, required?, values? }]` form. A `values:` namespace
  carries per-cell constraints (`required` / `pattern` / `enum` /
  `unique` / `type` / `min` / `max`) applied in a documented order:
  presence → type → required → enum → pattern → min/max → unique.
  Plus table-level `rows: { min?, max? }` cardinality and a
  `strict: true` policy that rejects undeclared columns.
- **Fuzzy "did you mean?"** — every unknown-key diagnostic now carries a
  Levenshtein-based suggestion when one falls within a length-scaled
  cutoff. Covers section-rules keys, primitive names, modifier keys,
  the `type:` value, undeclared frontmatter fields, and every nested
  inner-key inside `table:` / `list:` / `code:` (e.g. `coluns` →
  `columns`, `patern` → `pattern`, `mn` → `min`, `tiem` → `time`).
- **Universal `bodyLine`** on body diagnostics — code-fence cardinality,
  standalone formula, cardinality on repeatable sections, and every
  per-cell / per-item issue now expose a body-relative line number. The
  CLI renders these as `body (line N)` and the LSP wrapper translates
  them into editor squiggles at exactly the offending construct.

### Changed — clearer error messages

- The `section-rules-leak` diagnostic is now action-first
  (`Delete this …` instead of `A code block belongs to …`) and the
  fix names the exact span the author must remove (opening fence
  through closing ```` ``` ````).

### Removed — table-formula coupling (BREAKING)

- `table.key_column` and `table.value_column` are GONE, along with the
  formula-on-table extraction they powered. The `formula` primitive
  still exists but now evaluates against **frontmatter** values
  directly — references inside the expression map to frontmatter
  field names. Vaults that used RICE-style scoring tables should lift
  the dimensions into frontmatter:

  ```yaml
  # before
  table:
    key_column: Dimension
    value_column: Value
  formula: "reach * impact / effort >= 5"

  # after
  ---
  reach: 8
  impact: 3
  effort: 4
  ---
  formula: "reach * impact / effort >= 5"
  ```

### Changed — `list.item` → `list.items` (BREAKING)

- The list primitive's per-item rules now live under `items:` (plural)
  to keep the API consistent with the new `code.content:` and
  `table.columns[].values:` namespaces. The legacy `item:` key triggers
  the fuzzy-suggestion path (`Did you mean 'items'?`) so authors get a
  clear migration prompt the first time they validate.

### Migration

Two breaking changes to be aware of:

1. **`list.item` → `list.items`** — rename `item:` to `items:` in every
   template's `yaml section-rules` fence.
2. **`table.key_column` / `table.value_column` removed** — lift the
   keyed dimensions into frontmatter and reference them directly in
   the `formula:` expression.

Anywhere else, templates load unchanged; the new constraints
(`type: time` / `datetime`, `before` / `after`, expanded `columns:`,
`rows`, `strict`, `code.content.pattern`, list `min` / `max` /
`unique` / `items.enum`) are all opt-in.

## [0.9.0] — 2026-05-20

### Changed — composable schema validation redesign

The ad-hoc `validation_rules` frontmatter block and the hardcoded body-parser section logic are replaced by a single composable, template-driven schema system driven by a closed registry of rule primitives.

#### Frontmatter: `validation_rules` → `fields:` schema

`validation_rules` (with its sub-blocks `required_fields`, `field_rules`, `conditional_required_fields`, `state_machine`, `path_regex`, `optional_fields`, `body_section_formats`, `required_body_sections`, `allowed_roles`, `required_gherkin_section`) is replaced by a flat `fields:` block keyed by field name. Primitives are declared directly on each field entry:

- `required: true` replaces `required_fields` membership.
- `enum`, `pattern`, `type`, `min`, `max` replace `field_rules` entries.
- `required: { when: "<DSL>" }` replaces `conditional_required_fields`.
- `$path: { pattern: "..." }` (synthetic field) replaces `path_regex`.
- `strict: true` (top-level) opts in to undeclared-key errors.
- `state_machine` is dropped — use `enum` on the status field.
- `optional_fields` is dropped — fields without `required: true` are optional.

Expanded form `{ value, when, severity, message }` is available on any constraint for conditional gating and severity override.

#### Body validation: hardcoded handlers → generic `section-rules` primitives

`lib/body-parser.js`'s 12 hardcoded `SECTION_HANDLERS` and 23 hardcoded warning types are replaced by generic shape parsers (`table`/`list`/`heading-tree`/`code-fence` from `lib/body-shapes.js`) driven by template `section-rules` blocks. The template body mirrors the document shape; each heading section carries a `yaml section-rules` fence with composable primitives: `required`, `repeatable`, `heading` (with `pattern`/`enum`), `table` (with `columns`/`key_column`/`value_column`), `list` (with `item.pattern`), `code` (with `lang`), `formula`, `min`/`max` cardinality.

#### Template meta-validation

Templates are now validated when loaded. Malformed `fields:` entries or `section-rules` blocks yield structured `template-schema-invalid` errors attributed to the template — the engine never throws mid-document.

### Added

- **New modules:** `lib/schema-engine.js` (primitive registry, `applyFieldSchema`, `applyBodySchema`, `validateTemplateSchema`, `validateBodyTemplateSchema`), `lib/expression-eval.js` (arithmetic/comparison evaluator for `formula`), `lib/body-shapes.js` (generic shape parsers).
- **New public API:** `loadTemplateRules` returns `{ fields, strict, sections, tier, bodySchema, templateErrors }`. Exports: `PRIMITIVES`, `SYNTHETIC_RESOLVERS`, `applyFieldSchema`, `applyBodySchema`, `validateTemplateSchema`, `validateBodyTemplateSchema`.
- **Synthetic fields:** `$path` resolves to the document's repo-relative POSIX path; constrained via `pattern`/`enum`.
- **Built-in rule — `section-rules` fence leak.** A `yaml section-rules` code fence is a template-authoring construct (templates declare per-section requirements with it). The CLI validator and the LSP now flag a `section-rules` fence found in an authored document as an error (`error_type: section-rules-leak`) — the message reads *"A '```yaml section-rules' code block belongs to templates only and must not appear in a document"*. Templates under `templates/` are exempt. The rule is generic infrastructure — it keys off the plugin's own DSL construct, not vault vocabulary — so it needs no template configuration.
  - New public API: `findSectionRuleBlocks` (from `./template-section-rules`) locates every `section-rules` fence in a markdown body; `validateSectionRulesLeak` (from `./validators`) returns the leak issues. Both re-exported from the barrel.
  - Detection is AST-based, so a `section-rules` fence shown *inside* an outer code fence (documentation) is correctly treated as plain text, not a leak.

### Removed

- `applyRules` from `lib/validators.js`; old `normalizeRules` shape from `lib/template-rules.js`; `validatePathRegex` from `cli/validate-documents.js` (folded into `$path` synthetic field).
- `body_section_formats`, `required_body_sections`, `allowed_roles`, `required_gherkin_section` template keys (superseded by body `section-rules` primitives).
- 12 `SECTION_HANDLERS` and 23 hardcoded warning types from `lib/body-parser.js`.

## [0.8.0] — 2026-05-19

Ships the **Claude Code skill suite** that turns the plugin from "LSP + CLI" into six verbs the user types inside a Claude session. All skills are vault-agnostic — they read template schemas at runtime via the v0.7.0 public API, hardcode nothing.

### Added

- **Five Claude Code skills committed for the first time:**
  - `/vault.setup` — interview-driven onboarding; scaffolds via `vault-keeper init`, then extends templates per the user's answers.
  - `/vault.new <type> [slug]` — scaffolds a new document from `templates/<type>-template.md`. Reads the `fields` schema and `bodySchema` via `loadTemplateRules`; generates frontmatter placeholders per field primitives; derives the target path from the `$path` pattern's literal prefix; validates after write.
  - `/vault.health` — digests `vault-keeper doctor --json` + `vault-keeper validate --json` into a report grouped by template, folder, and rule kind.
  - `/vault.fix` — applies `formatVaultDocument` deterministically (frontmatter key order, body section order, AC/relationship normalization, whitespace), re-validates, reports residuals that need human judgment.
  - `/vault.sync` — validate-then-push pipeline; refuses to push if validate fails; manages stash, rebase, restore, commit, push as a single gated chain.
- **`skills/README.md`** — catalog index for the six skills (`vault.monitor-git-sync` was already shipped).
- **`tests/skills-lint.test.js`** — guards skill frontmatter shape and cross-references between skills. Asserts the six v0.8.0 skills are present, each has a valid `name:` + `description:` frontmatter, and every `/vault.<x>` cross-reference resolves to an actual skill directory.

### Changed

- `README.md` — `What's in the box` mentions the six-skill catalog.
- `docs/getting-started.md` — post-install section lists the six verbs the user can type after `claude plugin install`.

### Compatibility

- No JS source changes. Public API surface from v0.7.0 is unchanged. CLI surface from v0.6.0 is unchanged. Existing scripts continue to work.
- Skills are auto-discovered by Claude Code from the `skills/` directory; no plugin manifest changes were required.

## [0.7.0] — 2026-05-19

Promotes the plugin's internal modules to a first-class **public
programmatic API**. Until now, importing `parseBody`, `validateDocument`,
`loadTemplateRules`, the canonical formatter, etc. required reaching
into deep file paths — and even those were unreliable because the
package had no `exports` map. This release publishes a single
documented import surface so external scripts (custom dashboards, CI
gates, editor integrations, bulk-rewrite tools) can build on the same
primitives the CLI and LSP use.

### Added

- **Barrel `lib/index.js`** re-exports the full public API. `import { … }
  from 'claude-code-vault-keeper'` now resolves and gives you parsers
  (`parseBody`, `parseDocument`, `parseSectionRules`), validators
  (`applyRules`, `validateDocument`, `validateBuffer`,
  `validateSlug`, …), the canonical formatter
  (`formatVaultDocument` + async variant), the conditional-rule DSL
  (`evaluateCondition`, `getField`), config helpers
  (`resolveProjectRoot`, `loadVaultConfig`), high-level orchestrators
  (`findDocuments`, `findAllFiles`), and a `VERSION` constant.
- **`exports` map** in `package.json` declares named subpaths for each
  module (`./parser`, `./validators`, `./formatter`, `./template-rules`,
  `./vault-config`, `./orchestrator`, `./lsp-validator`, …). Original
  deep paths (`claude-code-vault-keeper/lib/<x>.js`,
  `claude-code-vault-keeper/cli/<x>.js`,
  `claude-code-vault-keeper/server/<x>.js`) still resolve via wildcard
  entries for backwards compatibility.
- **`docs/programmatic-usage.md`** rewritten: full module map, copy-paste
  examples for single-file / whole-vault validation, building a custom
  reporter, building a vault dashboard, pre-commit hooks, and JSON-CLI
  invocation. The barrel is the recommended surface; subpaths are the
  smaller alternative.
- **`tests/public-api.test.js`** asserts that every advertised export
  resolves from the package's `exports` map — both the barrel and each
  named subpath — and that the orchestrator side-effect guard does NOT
  fire on import (so `import { validateDocument } from
  'claude-code-vault-keeper'` doesn't chdir or exit the host process).

### Changed

- `package.json#main` now points at `lib/index.js` (the barrel) instead
  of the LSP bundle. The LSP bundle remains accessible via the
  `./lsp-bundle` subpath and via the `vault-keeper-validate` /
  `vault-keeper` bins; the change only affects the default resolution
  of `import x from 'claude-code-vault-keeper'`.
- `formatVaultDocumentAsync` docs updated: it takes `{ projectRoot }`
  and reads `template:` from the document's own frontmatter — the
  previous doc claim of a separate `templatePath` option was wrong.

### Compatibility

- No behavior change for the CLI (`vault-keeper`, `vault-keeper-validate`)
  or the LSP. All bins continue to dispatch through the same entry
  points.
- Adding the `exports` map narrows what's importable to the listed
  paths — but every path the previous docs referenced is preserved via
  wildcard back-compat entries, so existing scripts continue to work.

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
  - `install-claude-code-plugin` — wraps `claude plugin marketplace add` +
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
