# claude-code-vault-keeper

**Template-driven validation for any markdown knowledge-vault.** A
[Claude Code](https://github.com/anthropics/claude-code) plugin that ships:

- **LSP server** — per-keystroke diagnostics, navigation, hover, completion,
  code-action, code-lens, inlay-hint, rename, document-formatting.
- **CLI validator** (`vault-keeper-validate`) — full-vault validation with
  exit codes suitable for CI / pre-commit gating.
- **Shared parsing lib** — markdown body parser, template rules loader,
  conditional-eval DSL, canonical formatter, vault-config.

Editor and CLI parse bodies with the SAME parser and apply the SAME
validation rules. One implementation, two entry points.

The plugin owns **no per-doc-type knowledge** — every rule comes from a
template's `validation_rules` block. Drop in your own `templates/*.md` and
the validator picks them up at runtime.

## Quick start

```bash
# 1. Install the plugin into a Claude Code marketplace
claude marketplace add <this-repo-url-or-path>
claude plugin install claude-code-vault-keeper@vault-keeper

# 2. (For CLI use only) install runtime deps once
bun install

# 3. Validate the bundled example vault
bun cli/validate-documents.js --root examples/example --json
```

## Documentation

Full documentation lives in [`docs/`](docs/README.md). Recommended reading
order:

1. [Getting started](docs/getting-started.md) — install + first vault
   walkthrough.
2. [Vault config](docs/vault-config.md) — `.claude/vault-keeper.json`
   reference.
3. [Templates](docs/templates/README.md) — how to author templates that
   declare validation rules.
4. [CLI validator](docs/cli-validator.md) — flags, exit codes, JSON output.
5. [LSP features](docs/lsp-features.md) — what shows up in the editor.
6. [CI/CD integration](docs/ci-cd-integration.md) — GitHub Actions /
   GitLab CI / generic Bash patterns.
7. [Troubleshooting](docs/troubleshooting.md) — common errors and fixes.

Reference:

- [Canonical formatter](docs/canonical-formatter.md)
- [Body parser](docs/body-parser.md)
- [Naming conventions](docs/naming-conventions.md)
- [Architecture](docs/architecture.md)

## License

UNLICENSED — see `.claude-plugin/plugin.json`.
