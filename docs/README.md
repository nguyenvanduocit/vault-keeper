# Documentation

`claude-code-vault-keeper` is a template-driven markdown validation engine.
Documents declare which template they conform to; templates declare their
own validation rules; the engine enforces them generically.

## Quick links

### Setup

- [Getting started](getting-started.md) — install Bun, install the plugin,
  initialize a vault, validate your first document, open it in an editor.
- [Vault config](vault-config.md) — `.claude/vault-keeper.json` atoms
  (`vaultRoot`, `vaultFolders`, `excludePatterns`, `namingPatterns`).

### Authoring templates

- [Templates overview](templates/README.md) — anatomy of a template +
  index of every rule field the engine recognises.
- [Frontmatter rules](templates/frontmatter-rules.md) — `required_fields`,
  `optional_fields`, `conditional_required_fields` (with DSL),
  `field_rules` (regex / values / type / min), `state_machine`.
- [Folder & filename rules](templates/folder-and-naming.md) —
  `allowed_folders`, naming conventions, slug rules.
- [Body rules](templates/body-rules.md) — `sections[]`, body section-rules
  code fences (`required: true`, format hints), `body_section_formats`.
- [Full example](templates/full-example.md) — end-to-end template + a
  conforming instance + the diagnostics that would fire on a broken
  instance.

### Running the validator

- [CLI validator](cli-validator.md) — `bun cli/validate-documents.js` /
  `vault-keeper-validate` flags, exit codes, JSON output shape, examples.
- [LSP features](lsp-features.md) — per-operation behavior (diagnostics,
  hover, code-lens, inlay-hint, completion, code-action, rename, format).
- [CI/CD integration](ci-cd-integration.md) — GitHub Actions, GitLab CI,
  generic Bash runners, pre-commit hook, the `jq` artifact pattern.

### Reference

- [Canonical formatter](canonical-formatter.md) — what the formatter
  rewrites (frontmatter key ordering, section reordering, AC heading
  normalization, relationship bullet shape, whitespace).
- [Body parser](body-parser.md) — which body sections the parser
  understands, what it extracts, which warnings it emits.
- [Naming conventions](naming-conventions.md) — slug rule for folders +
  filenames, the namingPatterns map, exempt basenames.
- [Architecture](architecture.md) — module map, data flow, extension
  points.
- [Troubleshooting](troubleshooting.md) — common errors with concrete
  fixes.

## Mental model in one paragraph

A **vault** is a collection of markdown files under a configured
`vaultRoot`. Each file's frontmatter has a `template:` field pointing to a
template under `templates/`. The template's own frontmatter contains a
`validation_rules:` block. The engine loads that block at runtime and
enforces what it finds — required fields, regex, enums, state machine,
allowed folders, body-section structure, etc. The plugin code knows
nothing about your domain words; it only knows how to read template rules
and apply them.

When you want to enforce a new constraint, add a field to a template's
`validation_rules` block, not a code branch. The plugin enforces whatever
the template declares.
