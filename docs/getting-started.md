# Getting started

You're 5 minutes from a vault that catches its own mistakes.

What you'll have by the end of this page:

- A markdown vault with a template that declares its own rules.
- A note that validates clean.
- A note you deliberately broke, showing the error you'd see in CI.
- *(Optional)* Inline diagnostics in your editor via the Claude Code plugin.

## Prerequisites

- **Node.js** ≥ 18 — required by the CLI runtime.
- *Optional:* **[Bun](https://bun.sh)** — `bunx` is faster than `npx` and
  avoids touching your npm cache.
- *Optional:* **[Claude Code](https://github.com/anthropics/claude-code)** —
  required only for editor-side LSP diagnostics. The CLI is standalone.

## The 30-second smoke test

Run this anywhere. It scaffolds a tiny vault, validates it green, then breaks
it on purpose so you can see what a real error looks like.

```bash
# 1. Scaffold
bunx -p claude-code-vault-keeper vault-keeper init /tmp/vk-demo
cd /tmp/vk-demo

# 2. Validate — should pass
bunx -p claude-code-vault-keeper vault-keeper validate
# → "Valid: 1/1", exit 0

# 3. Break it — remove the owner: line
sed -i '' '/^owner:/d' notes/note-001-hello.md   # macOS
# or:  sed -i '/^owner:/d' notes/note-001-hello.md   # Linux

# 4. Validate again — should fail with a clear fix
bunx -p claude-code-vault-keeper vault-keeper validate
```

You'll see something like:

```
📄 notes/note-001-hello.md
   🚨 owner: Missing required field: owner
      💡 Fix: Add owner to frontmatter

📊 SUMMARY
⚠️ note: 0/1 (0.0%)
🚨 Errors: 1

exit 1
```

That's it. That diagnostic is the same shape you'll see in CI logs, in your
editor (if you install the plugin), and in JSON output (`--json`).

## Pick a permanent install style

The one-shot `bunx` command above is fine for trying things. For day-to-day
use, pick one:

| Style | Use when | Command |
|---|---|---|
| **One-shot** (no install) | One-off check, CI runner pulls fresh each time. | `bunx -p claude-code-vault-keeper vault-keeper <cmd>` (or `npx -p claude-code-vault-keeper vault-keeper <cmd>`) |
| **Project dev-dep** | Vault lives inside a JS/TS repo that already runs `npm`/`bun`. | `bun add -D claude-code-vault-keeper` (or `npm i -D claude-code-vault-keeper`) |
| **Global** | You author many vaults; want `vault-keeper` in `$PATH`. | `bun add -g claude-code-vault-keeper` (or `npm i -g claude-code-vault-keeper`) |
| **Claude Code plugin** | You want inline LSP diagnostics in your editor. | `vault-keeper install-claude-code-plugin` |

You do **not** need to `git clone` the repo to use `vault-keeper`. Cloning is
for contributing — see [Architecture](architecture.md#repo-layout).

## Subcommands at a glance

After install:

```text
vault-keeper validate [--root <vault>] [--path <file>] [--strict] [--json]
vault-keeper doctor [--json]
vault-keeper install-claude-code-plugin
vault-keeper init [<dir>] [--force]
vault-keeper help [<command>]
vault-keeper --version
```

The legacy bin `vault-keeper-validate` is kept as a validate-only alias for
backwards compatibility — same flags as `vault-keeper validate`.

### `doctor`

```bash
vault-keeper doctor
```

Checklist of Node version, bun availability, the `claude` CLI, the LSP bundle,
the cwd vault config, and the cwd `templates/` directory. Pass `--json` for
CI-friendly output.

### `install-claude-code-plugin`

```bash
vault-keeper install-claude-code-plugin
```

Wraps the two-step manual install:

```bash
claude plugin marketplace add https://github.com/nguyenvanduocit/claude-code-vault-keeper.git
claude plugin install claude-code-vault-keeper@vault-keeper
```

If `claude` isn't on `$PATH`, the command prints the manual steps instead of
failing silently.

## Build a real vault from scratch

The `init` scaffold is good for a quick smoke test. For your own vault, here's
the explicit walkthrough — three concepts, three steps.

A vault needs three things:

1. **Templates** — at least one markdown file under `templates/` whose
   frontmatter declares a `validation_rules:` block.
2. **Documents** — markdown files whose frontmatter declares
   `template: templates/<your-template>.md`.
3. **(Optional) config** — `.claude/vault-keeper.json` if your folder layout
   differs from the defaults.

### Step 1 — create the layout

```bash
mkdir -p my-vault/.claude my-vault/templates my-vault/notes
cd my-vault
```

### Step 2 — declare vault config (optional)

Use this when you want to scan only specific folders (default: the whole
repo):

```bash
cat > .claude/vault-keeper.json <<'EOF'
{
  "vaultRoot": "notes",
  "vaultFolders": ["notes"]
}
EOF
```

Without a config file, the whole repo IS the vault, with generic exclusions
(`node_modules`, `.vitepress`, `README.md`, `CLAUDE.md`, `CLAUDE.local.md`).
See [vault-config](vault-config.md) for the full reference.

### Step 3 — write a template

````bash
cat > templates/note-template.md <<'EOF'
---
template_path: templates/note-template.md
document_type: note
validation_rules:
  required_fields: [template, document_type, title, owner]
  optional_fields: [tags, status]
  field_rules:
    - field: status
      values: [draft, review, approved]
  path_regex: "^notes/"
---

# Note template

Body sections this template expects.

## Relationships

```yaml section-rules
relationships:
  required: false
```
EOF
````

See [templates/frontmatter-rules](templates/frontmatter-rules.md) for the
full `validation_rules` vocabulary.

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

From the vault directory:

```bash
vault-keeper validate
# → "Valid: 1/1", exit 0
```

Try removing the `owner:` line — the validator exits `1` and tells you which
field is missing plus how to fix it.

For JSON output (the form CI consumes):

```bash
vault-keeper validate --json
```

### Step 6 — open in your editor

If you installed via the Claude Code plugin path (the marketplace command
above), the LSP is already wired up. Open any `.md` file in your vault and
diagnostics show inline as you type.

The LSP recognises a directory as a vault root when it contains either a
`templates/` directory or a `.claude/vault-keeper.json` file. Both are present
in your setup.

For a deeper editor walkthrough see [lsp-features](lsp-features.md).

## What to read next

- Your templates ARE the configuration surface — read
  [templates/README](templates/README.md) for the full vocabulary.
- For CI gating see [ci-cd-integration](ci-cd-integration.md).
- Stuck on an error? Check [troubleshooting](troubleshooting.md).
- Browse the bundled `examples/example/` for a working vault that exercises
  every rule kind — both the
  [README map](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/examples/example/README.md)
  and [`tests/example-vault.expectations.json`](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/tests/example-vault.expectations.json)
  enumerate every fixture and the diagnostic it demonstrates.
