# Getting started

End-to-end walkthrough: install the plugin, set up a minimal vault, write a
template, validate a conforming document.

## Prerequisites

- [Bun](https://bun.sh) — the validator's runtime (the CLI shebang is
  `#!/usr/bin/env bun`).
- [Claude Code](https://github.com/anthropics/claude-code) — required if
  you want editor-side diagnostics. Skip if you only need the CLI
  validator.

## Install

The plugin is distributed via the Claude Code plugin system. Two paths:

### A. Install from a marketplace

```bash
claude marketplace add <this-repo-url-or-path>
claude plugin install claude-code-vault-keeper@vault-keeper
```

`.claude-plugin/marketplace.json` exposes a single plugin with
`source: "."`. The LSP server (`server/main.bundled.cjs`) ships pre-built
and self-contained — editor diagnostics need no `bun install`.

### B. Clone for CLI use only

```bash
git clone <this-repo-url> claude-code-vault-keeper
cd claude-code-vault-keeper
bun install         # populates runtime deps for the CLI validator
```

## Verify the install

The bundled example vault under `examples/minimal-vault/` is a runnable
reference. From this plugin's root:

```bash
bun cli/validate-documents.js --root examples/minimal-vault --json
```

Expected output: a single JSON document, `summary.invalid === 0`, exit
code `0`.

## Set up your own vault

A vault needs three things:

1. **Templates** — at least one markdown file in `templates/` whose
   frontmatter contains a `validation_rules:` block.
2. **Documents** — markdown files under the configured `vaultRoot` whose
   own frontmatter declares `template: templates/<your-template>.md`.
3. **(Optional) config** — `.claude/vault-keeper.json` if your folder
   layout differs from the defaults (whole repo as vault).

### Step 1 — create the layout

```bash
mkdir -p my-vault/.claude my-vault/templates my-vault/notes
cd my-vault
```

### Step 2 — declare vault config (optional)

If you want the validator to scan only `notes/` instead of the whole
repo:

```bash
cat > .claude/vault-keeper.json <<'EOF'
{
  "vaultRoot": "notes",
  "vaultFolders": ["notes"]
}
EOF
```

With no config file, the whole repo IS the vault and only generic patterns
are excluded (`node_modules`, `.vitepress`, `README.md`, `CLAUDE.md`,
`CLAUDE.local.md`). See [vault-config](vault-config.md) for every atom.

### Step 3 — write a template

```bash
cat > templates/note-template.md <<'EOF'
---
template_path: templates/note-template.md
document_type: note
validation_rules:
  required_fields: [template, document_type, title, owner]
  optional_fields: [tags]
  field_rules:
    - field: status
      values: [draft, review, approved]
  allowed_folders: "^notes/"
---

# Note template

Body sections this template expects.

## Relationships

```yaml section-rules
relationships:
  required: false
```
EOF
```

See [templates/frontmatter-rules](templates/frontmatter-rules.md) for the
full validation_rules vocabulary.

### Step 4 — write a conforming document

```bash
cat > notes/hello.md <<'EOF'
---
template: templates/note-template.md
document_type: note
title: Hello vault
owner: '@alice'
status: draft
---

# Hello

This is my first note.

## Relationships
EOF
```

### Step 5 — validate

```bash
# From the plugin directory, point --root at your vault
bun /path/to/claude-code-vault-keeper/cli/validate-documents.js \
  --root /path/to/my-vault
```

You should see `Valid: 1/1` and exit code `0`. Try removing the `owner:`
line — the validator will exit `1` and tell you which field is missing
and how to fix it.

### Step 6 — open in an editor with the LSP

If you installed via the Claude Code marketplace path (option A above),
the LSP is already wired up. Open any `.md` file in your vault and you'll
see diagnostics inline as you type.

The LSP recognizes a directory as a vault root when it contains either a
`templates/` directory or a `.claude/vault-keeper.json` file. Both are
present in your setup.

For a deeper editor walkthrough see [lsp-features](lsp-features.md).

## What to read next

- Your templates are the configuration surface — read
  [templates/README](templates/README.md) for the full vocabulary.
- For CI gating see [ci-cd-integration](ci-cd-integration.md).
- Stuck on an error? Check [troubleshooting](troubleshooting.md).
