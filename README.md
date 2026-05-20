# vault-keeper

[![CI](https://github.com/nguyenvanduocit/claude-code-vault-keeper/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nguyenvanduocit/claude-code-vault-keeper/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/claude-code-vault-keeper.svg)](https://www.npmjs.com/package/claude-code-vault-keeper)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Published on npm as **`claude-code-vault-keeper`** — the `vault-keeper`
binary is what you'll actually type.*

> Your vault has 1,247 notes. How many use `status: done` vs `status: completed`?
> How many tag with `#book` vs `#books`? How many books are missing a `rating:` field?
>
> You don't know. Neither does Dataview. That's why your queries quietly lie.

---

## Every markdown vault rots the same way

1. You start with 50 notes and a tidy convention.
2. You copy a template once, tweak it, lose track of which copy is the real one.
3. AI tools (Claude, ChatGPT, Cursor) generate notes with slightly different
   frontmatter than yours.
4. Six months later: `tag` vs `tags`, `status: WIP` vs `status: in-progress`,
   half your book notes have `author:`, the other half have `by:`.
5. Your Dataview queries quietly miss half your data. You stop trusting them.
6. You promise yourself a "cleanup pass." It never happens.

**`vault-keeper` makes your vault enforce its own conventions.** Write the rules
once, in a template you control. Get a red squiggle the moment a note breaks
them — in your editor, in CI, in the loop where your AI assistant writes new
notes.

It works with any markdown folder: an Obsidian vault, a Logseq graph, a Foam
workspace, a repo full of ADRs and RFCs, a personal Zettelkasten. The plugin
contains **zero domain knowledge** about your notes. Your templates decide
everything.

> **Adopting an existing vault?** Don't try to convert 500 notes overnight.
> Set `vaultFolders` in `.claude/vault-keeper.json` to one subfolder (e.g.
> `["books"]`), author one template, point that folder's notes at it,
> watch it go green. Folders outside `vaultFolders` are silently ignored,
> so the rollout is incremental — add a folder when you're ready to enforce
> it. See [`docs/vault-config.md`](docs/vault-config.md) for the config
> reference and [`examples/example/`](examples/example/) for a working
> single-folder setup to copy from.

---

## What you actually see

Two notes that drifted from your book-note template — one set `status: wip`
where the template allows only `[reading, done, abandoned]`, the other is
missing the `created:` field your queries depend on:

```
📄 library/books/2024-shogun.md
   🚨 status: Invalid status: 'wip'
      💡 Fix: Use one of: reading, done, abandoned
   🚨 created: Missing required field: created
      💡 Fix: Add created to frontmatter

📄 library/books/atomic-habits.md
   🚨 rating: Value 0 below minimum 1 for rating
      💡 Fix: Set rating ≥ 1

📊 SUMMARY
Total Documents: 487
✅ Valid: 484/487
🚨 Errors: 3

exit 1
```

That same diagnostic appears **inline as you type** if you install the Claude
Code plugin — no save, no run, no context switch.

CI fails on the first error. Reviewers stop nitpicking format and start
reviewing content.

---

## How the rules work

Rules live **in your templates**, not buried in the tool. A book-note template
might look like this:

```markdown
---
template_path: templates/book.md
document_type: book
fields:
  $path:
    pattern: "^library/books/"
  template:
    required: true
  title:
    required: true
  author:
    required: true
  created:
    required: true
    type: string
    pattern: "^\\d{4}-\\d{2}-\\d{2}$"
  status:
    required: true
    type: string
    enum: [reading, done, abandoned]
  rating:
    type: integer
    min: 1
  tags:
    type: array
  finished:
    type: string
---

# Book template

Body sections this template expects.

## Takeaways

## Quotes
```

Edit the template. Every note that declares `template: templates/book.md`
revalidates against the new rules — no rebuild, no code change. The
[full rule vocabulary](docs/templates/frontmatter-rules.md) covers composable
field primitives (type, enum, pattern, required, min/max, uniqueItems, exists),
conditional requirements via a small DSL (`and`, `or`, `in`, `not in`), body
section-rules (heading patterns, table/list/code validation, repeatable
headings, formula expressions), and strict mode for undeclared-field detection.

---

## Try it in 30 seconds

```bash
# 1. Scaffold a sample vault (no install)
bunx -p claude-code-vault-keeper vault-keeper init my-vault
cd my-vault

# 2. Look at templates/note-template.md — those are the rules
# 3. Validate
bunx -p claude-code-vault-keeper vault-keeper validate
# → Valid: 1/1, exit 0

# 4. Break notes/note-001-hello.md (e.g. delete `owner:`)
bunx -p claude-code-vault-keeper vault-keeper validate
# → exit 1, explains exactly what broke and how to fix it
```

For per-keystroke diagnostics in your editor, install the Claude Code plugin.
The `vault-keeper` CLI ships a one-liner wrapper:

```bash
vault-keeper install-claude-code-plugin
```

Or, if you don't have the CLI on `$PATH` (or just prefer to see what's
happening), run the two `claude` commands yourself:

```bash
claude plugin marketplace add https://github.com/nguyenvanduocit/claude-code-vault-keeper.git
claude plugin install claude-code-vault-keeper@vault-keeper
```

That's it. Open any `.md` in your vault and the LSP highlights problems live.

---

## Who this is for

- **Obsidian / Logseq / Foam users** with vaults large enough that you can't
  manually keep them consistent. You have templates but no way to make notes
  *honor* them. You'd love to know which 12 notes are missing a `created:`
  field without writing your own script.
- **Note-takers using AI assistants.** Claude, ChatGPT, Cursor, Copilot
  cheerfully generate notes that drift from your conventions. Wire
  `vault-keeper validate` into the AI's loop (or its post-write hook) and
  it self-corrects from the same diagnostics you'd read — instead of
  silently drifting your vault.
- **Teams maintaining ADRs / RFCs / PRDs in markdown.** Reviews waste time on
  "where's the `decision:` field" comments. CI doesn't gate format.
  `vault-keeper` exit codes plug into any CI runner.
- **Anyone whose markdown collection has crossed the threshold from "I know
  what's in here" to "I hope it's in here somewhere."**

---

## Install

| Path | When | Command |
|---|---|---|
| **One-shot** | Trying it out, one-off CI check. | `bunx -p claude-code-vault-keeper vault-keeper <cmd>` |
| **Global** | Many vaults; want `vault-keeper` on `$PATH`. | `bun add -g claude-code-vault-keeper` |
| **Project dev-dep** | Vault lives inside a JS/TS repo. | `bun add -D claude-code-vault-keeper` |
| **Claude Code plugin** | Inline LSP diagnostics in your editor. | `vault-keeper install-claude-code-plugin` |

`npm` / `npx` work everywhere `bun` / `bunx` do — no bun runtime required.
Node ≥ 18.

---

## What's in the box

- **CLI** (`vault-keeper`) — `validate`, `doctor`, `init`,
  `install-claude-code-plugin`. Exit codes wired for CI.
- **LSP server** — diagnostics, hover, completion, code-action, code-lens,
  rename, document formatting. Pre-built bundle, no install step
  for editor diagnostics.
- **Composable schema engine** — the same validation primitives drive editor
  and CI. What passes locally passes in CI; no "works on my machine."
- **Public programmatic API** — `import { applyFieldSchema, applyBodySchema,
  validateDocument, loadTemplateRules, formatVaultDocument, … } from
  'claude-code-vault-keeper'`. Reuse the same primitives the CLI and LSP
  build on to write custom reporters, dashboards, CI gates, pre-commit hooks,
  or editor integrations. See [`docs/programmatic-usage.md`](docs/programmatic-usage.md).
- **No domain knowledge.** Every rule comes from a template you wrote. Drop
  `vault-keeper` into any markdown folder and it adapts.
- **Six Claude Code skills** — verbs you type in a Claude session:
  `/vault.setup` (onboarding), `/vault.new <type>` (scaffold doc),
  `/vault.health` (read-only report), `/vault.fix` (auto-format),
  `/vault.sync` (validate-then-push), `/vault.monitor-git-sync`
  (passive watcher). See [`skills/README.md`](skills/README.md).

---

## Documentation

- [Getting started](docs/getting-started.md) — install + first vault, 5 min.
- [Templates](docs/templates/README.md) — author rules your vault enforces.
- [CLI reference](docs/cli-validator.md) — every flag, every exit code.
- [LSP features](docs/lsp-features.md) — what each editor surface does.
- [Programmatic usage](docs/programmatic-usage.md) — `import { applyFieldSchema,
  validateDocument, … } from 'claude-code-vault-keeper'` for custom
  scripts, dashboards, CI gates, and editor integrations.
- [CI/CD integration](docs/ci-cd-integration.md) — GitHub Actions / GitLab /
  generic Bash.
- [Vault config](docs/vault-config.md) — `.claude/vault-keeper.json` reference.
- [Troubleshooting](docs/troubleshooting.md) — concrete fixes for common errors.

A self-contained reference vault that exercises every rule kind lives at
[`examples/example/`](examples/example/README.md) — copy-paste from it.

---

## Repo

Source: <https://github.com/nguyenvanduocit/claude-code-vault-keeper>
Issues: <https://github.com/nguyenvanduocit/claude-code-vault-keeper/issues>
Releasing: see [`docs/releasing.md`](docs/releasing.md).

Cloning is for contributors. End users install via `bunx` / `npx` / `bun add` /
`npm i`.

## License

MIT — see [`LICENSE`](LICENSE).
