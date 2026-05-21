---
name: vault.help
description: "Read-only overview of claude-code-vault-keeper — lists every `/vault.*` skill with its one-line purpose, the `vault-keeper` CLI entrypoints, and deep links to the GitHub documentation. Never runs the validator, never touches files. Use when the user asks 'help', 'vault keeper help', 'what can vault keeper do', 'list vault commands', 'các lệnh vault', 'trợ giúp', 'hướng dẫn', '/vault.help'."
---

# vault.help — what claude-code-vault-keeper can do

This skill prints a help overview. It runs nothing and edits nothing — it
only renders the block below and, if asked, points the user at the right
doc.

## Step 1 — confirm the skill list is current (silent)

Run `ls "${CLAUDE_PLUGIN_ROOT:-.}/skills"` (or `ls skills` from the plugin
root). If the directory listing differs from the table below — a skill was
added or removed since this file was last edited — render the live listing
instead and mention the help table is stale so it gets fixed.

## Step 2 — render the help

Present this block to the user. Keep the GitHub links intact; they are how
the user reaches the full docs.

---

**claude-code-vault-keeper** — template-driven markdown validation for a
knowledge vault. Documents point at a template; templates declare their own
schema (`fields:` + body `section-rules`); the engine enforces whatever it
finds. The plugin knows nothing about your domain words.

**Skills — type any of these in a Claude session:**

| Command | What it does |
|---|---|
| `/vault.setup` | Interview-driven onboarding — scaffolds `.claude/vault-keeper.json` + per-type templates, then validates. |
| `/vault.new <type> [slug]` | Scaffolds a new document from `templates/<type>-template.md` with frontmatter placeholders from the `fields:` schema. |
| `/vault.health` | Read-only digest of `vault-keeper doctor` + `vault-keeper validate`. Groups violations by template, folder, rule kind. |
| `/vault.fix` | Deterministic auto-format — frontmatter key order, section order, whitespace. Never invents values. |
| `/vault.changelog` | Read-only remote changelog — ahead/behind summary, what's new on `origin/<branch>`, recent activity. Never merges. |
| `/vault.sync` | Validate-then-push — refuses to push if validate fails; otherwise stash → pull --rebase → restore → commit → push. |
| `/vault.monitor-git-sync` | Passive background watcher — auto-fast-forwards `origin/<branch>`, notifies only on conflict. |
| `/vault.help` | This overview. |

**CLI — run from the project root:**

- `vault-keeper validate` — validate every document against its template (`--json` for structured output; exit code is non-zero on errors).
- `vault-keeper doctor` — check environment + config state (`--json` supported).

**Documentation — full guides on GitHub:**

Repository: <https://github.com/nguyenvanduocit/claude-code-vault-keeper>

Setup
- [Getting started](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/getting-started.md)
- [Vault config](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/vault-config.md) — `.claude/vault-keeper.json`

Authoring templates
- [Templates overview](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/templates/README.md)
- [Frontmatter rules](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/templates/frontmatter-rules.md)
- [Folder & filename rules](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/templates/folder-and-naming.md)
- [Body rules](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/templates/body-rules.md)
- [Full example](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/templates/full-example.md)

Running the validator
- [CLI validator](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/cli-validator.md)
- [LSP features](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/lsp-features.md)
- [Programmatic usage](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/programmatic-usage.md)
- [CI/CD integration](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/ci-cd-integration.md)

Reference
- [Canonical formatter](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/canonical-formatter.md)
- [Naming conventions](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/naming-conventions.md)
- [Architecture](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/architecture.md)
- [Troubleshooting](https://github.com/nguyenvanduocit/claude-code-vault-keeper/blob/main/docs/troubleshooting.md)

---

## Step 3 — answer the follow-up

If the user named a topic (e.g. "how do I write a template", "fix is
failing"), point them at the single most relevant doc link above and offer
the matching skill — don't paste the doc contents.
