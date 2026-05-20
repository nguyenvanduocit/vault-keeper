# LSP features

The LSP server (`server/main.bundled.cjs`) ships as a self-contained Node
bundle and is wired into Claude Code via `.lsp.json`. It activates for
every `.md` file under your configured `vaultFolders`.

This page covers each LSP operation the server implements, what it does,
and what the user-facing behavior looks like.

## How the LSP is gated

A markdown file gets LSP attention only when **all** of:

1. Its absolute path resolves under the resolved `projectRoot`.
2. The repo-relative path matches at least one entry in `vaultFolders`
   (a `vaultFolder` of `"."` matches every path).
3. Its basename is **not** `CLAUDE.md` / `CLAUDE.local.md` (those are
   Claude Code agent prompts, not vault artifacts — silently ignored).
4. The root contains either a `templates/` directory or a
   `.claude/vault-keeper.json` file (the LSP's root-detector accepts
   either marker).

Files that don't qualify get an empty diagnostics array (clearing any
stale state) and are otherwise ignored.

## Operation catalog

| Operation | Trigger | What it does |
|---|---|---|
| **diagnostics** | `didOpen`, `didChange` (250 ms debounce), `didSave` | Runs the per-doc subset of the CLI validator. |
| **documentSymbol** | Editor request | Returns a hierarchical tree: frontmatter object + markdown headings. |
| **workspaceSymbol** | Editor request | Vault-wide search by id (`<prefix>-NNN`), title, or filename. |
| **hover** | Cursor hover | Frontmatter key -> applicable field schema. Markdown link -> target title/status/owner. Id literal -> target title. |
| **definition** | Cursor on link / id | Navigate to the linked file. |
| **references** | Editor request | Incoming markdown-link references (backlinks). |
| **implementation** | Editor request | Delegates to `definition`. |
| **completion** | `(`, `:`, `#`, `/`, `*` triggers | Link-target completions, heading-anchor completions, template-path completions, frontmatter enum completions (driven by template `fields:` schema). |
| **codeAction** | Diagnostic quick-fix prompt | Auto-fixes for template-only field leaks, missing required fields, filename rename, relative-path correction. |
| **codeLens** | Editor request | Action line above `template:` showing backlink count + last-updated age. |
| **rename** | Editor rename request / file move | Atomically renames a file and updates every markdown link pointing at it. |
| **documentFormatting** | Format-on-save / explicit format | Applies the canonical formatter to the buffer. |

## Diagnostics

The per-doc pipeline mirrors the CLI's per-doc subset (no full-vault
scan, so no orphan detection or cross-doc graph rules). Everything
that doesn't need to read the whole vault runs on every keystroke
(debounced 250 ms).

What runs:

- `validateTemplateField` — `template:` field shape (present, starts with
  `templates/`, ends with `.md`).
- `validateTemplateMetaLeak` — flags `template_path` / `template_id` /
  `template_version` keys that leaked from a template into an instance.
- `validateSlug` — every folder segment + filename must be
  lowercase-kebab-case (see [naming-conventions](naming-conventions.md)).
- `validatePaths` — relative paths (`./foo.md`, `../bar.md`) in
  frontmatter relationships or body trigger warnings (code blocks are
  stripped first).
- `validateSectionRulesLeak` — a `` ```yaml section-rules `` code fence
  is a template-authoring construct; finding one in a document is an
  error (see [body-rules](templates/body-rules.md)). Templates are
  exempt.
- `applyFieldSchema` — composable field primitives: required (with
  `when` conditions), type, enum, pattern, min/max, uniqueItems,
  exists, `$path` synthetic field, strict mode undeclared-field check.
- `applyBodySchema` — body section-rules: required sections, heading
  pattern/enum matching, table column validation, list item pattern
  matching, code fence requirements, formula evaluation, repeatable
  heading cardinality.

What does NOT run (CLI-only):

- Cross-document orphan / link-graph rules.
- Asset slug pass (non-markdown files).
- Bundle README re-include scan.

### Diagnostic shape

Each diagnostic is converted from a validator `Issue` to an LSP
`Diagnostic`:

| Issue field | LSP field |
|---|---|
| `level` (`error` / `warning`) | `severity` (Error / Warning) |
| `message` + `fix` | `message` (the `fix:` line is appended) |
| `field` (dot-path like `rice.reach` or heading path like `## Problem`) | `code` |
| derived line number | `range.start.line` |

`source` is always `"vault-keeper"`.

## documentSymbol

Returns the symbol tree as a nested array. Top level:

1. **frontmatter** — `SymbolKind.Object` with one child per frontmatter
   key.
2. **# H1 / ## H2 / ### H3 ...** — each heading becomes a
   `SymbolKind.String` symbol; deeper headings nest under their parent.

Useful for the editor's "outline" panel and "go to symbol in file"
shortcut.

## workspaceSymbol

Vault-wide search across the lazy vault index. The index is built on
first request and incrementally refreshed on `didSave`.

The query matches against:

- The doc's id (extracted from filename — any `<prefix>-<digits>`
  pattern, e.g. `prd-001`, `adr-013`, `t-042`).
- Frontmatter `title`.
- Filename basename.

Capped at 50 results per query.

## hover

Context-aware. Cursor on:

- **A frontmatter key** — shows the matching field schema from the
  template (e.g. "Required" / "Allowed values: ..." / "Pattern: ...").
- **A markdown link to a vault file** — shows the target's title +
  status + owner (from the cached frontmatter).
- **An id literal in body text** (e.g. `prd-001`) — resolves the id via
  the vault index, shows the target's title + status.

## definition / references

- **Definition** on a markdown link or an id literal jumps to the target
  file at line 0.
- **References** on the current file returns every markdown link in the
  vault that points at it (with line numbers in the source files).

The vault index uses a regex (`[a-z]+-\d{3,}`) to extract ids from body
text. Your filename naming convention defines which prefixes are real —
discovery is plugin-side, validation is template-side.

## completion

Four context-sensitive completion sources:

1. **Link-target completions** — typing `](` shows a list of vault
   documents to link to, sorted by proximity to the current file.
   Same-tier-folder entries sort first.
2. **Heading-anchor completions** — typing `](path#` shows heading
   anchors from the target file.
3. **Template-path completions** — typing a value after `template:`
   shows `templates/*-template.md` files.
4. **Frontmatter enum completions** — typing a value for any field
   whose template schema declares `enum` shows the allowed values.
   Handles both shorthand (`enum: [a, b]`) and expanded form
   (`enum: { value: [a, b], severity: "warning" }`).

## codeAction

Quick-fix dispatch matches on the diagnostic's `code` (the offending
field path) and optionally the message regex.

Fixers shipped:

- **`code in templateOnlyFields`** — diagnostic for a leaked
  `template_path` / `template_id` / `template_version` key offers a
  "Delete from frontmatter" action.
- **`code: "filename"`** — invalid filename offers a `WorkspaceEdit`
  rename to a kebab-case suggestion.
- **`code: "<field>"` + `"Missing required field:"`** — offers an "Insert
  placeholder" action that adds `<field>: <placeholder>` to frontmatter.
- **`code: "body"` + relative-path warning** — offers a "Replace with
  absolute path" action.

The set is intentionally narrow — quick-fixes only exist where the
correct edit is unambiguous.

## codeLens

Action lines that appear above specific positions. Each lens is a
client-side stub — the editor's vault-keeper extension (if installed)
handles the click; otherwise they're a no-op.

| Position | Lens title | Command |
|---|---|---|
| Above `template:` frontmatter line | `↗ N backlinks · ⏱ updated Xd ago` | `vault-keeper.openBacklinkList` |

Counts (backlinks, days-since-update) come from the vault index at
request time. The days-since-update is derived from
`frontmatter.updated_at` or `frontmatter.updated`.

## rename

LSP rename + workspace-edit `willRename`. When you rename a vault file:

1. The server returns a `WorkspaceEdit` that includes the file move plus
   every markdown link in the vault that points at the old path,
   rewritten to the new path.
2. The editor applies the edit atomically — the file moves AND all
   incoming links update in one step.

## documentFormatting

Applies the canonical formatter to the entire buffer. See
[canonical-formatter](canonical-formatter.md) for the rules:

- Frontmatter key reordering.
- Body section reordering per template `sections[]` list.
- Trailing whitespace strip + blank-line collapse + final newline.

The formatter is **idempotent** — running it twice produces the same
output as running it once.

## Lifecycle quick reference

| Event | Behavior |
|---|---|
| `didOpen` | Validate immediately (cold start). |
| `didChange` | Validate after 250 ms debounce (avoid per-keystroke load). |
| `didSave` | Validate + refresh vault index entry for the saved file. |
| `didClose` | Publish empty diagnostics array (clear editor's problems panel). |
| Non-vault file events | Silently ignored. |

## See also

- [Vault config](vault-config.md) — what `vaultFolders` gates.
- [CLI validator](cli-validator.md) — the same rules, full-vault.
- [Canonical formatter](canonical-formatter.md) — formatter rules.
