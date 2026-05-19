# Vault config

`.claude/vault-keeper.json` is the per-vault configuration file. It is
**optional**: with no file the engine treats the whole repository as the
vault and excludes only generic patterns.

## File location

The validator looks for the config file at:

```
<projectRoot>/.claude/vault-keeper.json
```

`projectRoot` is resolved in this priority order:

1. The CLI `--root <path>` flag.
2. `CLAUDE_PROJECT_DIR` environment variable.
3. Walk up from the current working directory for a `.git/` directory,
   then `.claude/`, then `CLAUDE.md`.
4. `process.cwd()`.

You can override the config path entirely with the
`VAULT_KEEPER_CONFIG` environment variable — it accepts an absolute path
and bypasses the `<projectRoot>/.claude/vault-keeper.json` lookup.

## Atoms

The file is a JSON object with up to four atoms. Unspecified atoms fall
back to the built-in defaults.

### `vaultRoot` (string)

The content root folder, relative to `projectRoot`. Used by the LSP for
proximity-sort during completion + by the CLI as the default scan path
when no folder is configured.

- **Default:** `"."` — the whole repository is the vault.

### `vaultFolders` (string[])

Folders the LSP + the CLI scan for vault documents. The LSP treats any
markdown file in one of these folders as a "vault file" (eligible for
diagnostics on `didOpen` / `didChange` / `didSave`); files outside the
list are silently ignored.

- **Default:** `["."]` — the whole repository.
- A vaultFolder entry of `"."` is recognized as the wildcard
  "everything" sentinel — every repo-relative path matches.

### `excludePatterns` (string[])

Glob patterns the CLI scan skips. Replaces the default list wholesale
when present (no merge).

- **Default:**
  ```
  [
    "**/README.md",
    "**/CLAUDE.md",
    "**/CLAUDE.local.md",
    "**/.vitepress/**",
    "**/node_modules/**"
  ]
  ```

`README.md` is excluded as folder-meta. A README.md that IS a canonical
vault document (folder-as-page pattern) is re-included by the orchestrator
based on the document's own `template:` field — see
[templates/folder-and-naming](templates/folder-and-naming.md) for the
bundle README mechanism.

### `namingPatterns` (object — `string → regex source string`)

Cross-cutting filename rules per folder. The key is a folder substring,
the value is a regex source string (compiled to a `RegExp` at load time).
Filenames in those folders must match the regex.

- **Default:** `{}` (no folder-level naming rules; templates may still
  declare their own `allowed_folders` regex via `validation_rules`).
- A vault opts in by declaring the map explicitly.

Example:

```json
{
  "namingPatterns": {
    "docs/decisions": "^\\d{4}-\\d{2}-\\d{2}-adr-\\d{3}-[a-z0-9-]+\\.md$",
    "docs/notes":     "^note-\\d{3}-[a-z0-9-]+\\.md$"
  }
}
```

A file under `docs/decisions/random-thought.md` would emit a `filename`
error. A file under `docs/notes/note-001-hello.md` would pass.

JSON has no regex literal — the values are strings. They're compiled once
when the config is loaded; backslashes need JSON-escaping (`\\d` not
`\d`).

## Caching

`loadVaultConfig()` is cached per-process keyed by the resolved config
path. After the first read the same frozen object is returned on every
subsequent call. Tests reset the cache via the test-only export
`_resetVaultConfigCache()`.

The returned object and its array members are deeply frozen — consumers
can't accidentally mutate shared state.

## Examples

### Minimal vault — single template, no config file

If your vault has one template and you're fine with the whole repo as
the vault, you don't need a config file at all. The defaults work.

### Docs vault under `docs/`

```json
{
  "vaultRoot": "docs",
  "vaultFolders": ["docs"]
}
```

This is what [`examples/minimal-vault/`](../examples/minimal-vault) ships.

### Multi-section vault with naming rules

```json
{
  "vaultRoot": "knowledge",
  "vaultFolders": ["knowledge", "spec/specs"],
  "excludePatterns": [
    "**/README.md",
    "**/CLAUDE.md",
    "**/node_modules/**",
    "**/_drafts/**"
  ],
  "namingPatterns": {
    "knowledge/decisions": "^\\d{4}-\\d{2}-\\d{2}-adr-\\d{3}-[a-z0-9-]+\\.md$",
    "knowledge/runbooks":  "^runbook-\\d{3}-[a-z0-9-]+\\.md$"
  }
}
```

### Vault rooted at the repo root (default)

```json
{
  "vaultRoot": ".",
  "vaultFolders": ["."]
}
```

Equivalent to omitting the file entirely — included here so the explicit
intent shows up in the repo.

## See also

- [Naming conventions](naming-conventions.md) — slug rules that apply on
  top of `namingPatterns`.
- [CLI validator](cli-validator.md) — `--root`, `--path` semantics.
- [LSP features](lsp-features.md) — how `vaultFolders` gates the LSP.
