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
| **hover** | Cursor hover | Frontmatter key → applicable validation rule. Markdown link → target title/status/owner. Id literal → target title. |
| **definition** | Cursor on link / id | Navigate to the linked file. |
| **references** | Editor request | Incoming markdown-link references (backlinks). |
| **implementation** | Editor request | Delegates to `definition`. |
| **completion** | `@`, `(`, `:` triggers | `@handle` people completions, link-target completions, frontmatter enum completions. |
| **codeAction** | Diagnostic quick-fix prompt | Auto-fixes for `templateOnlyFields` leaks, missing required fields, filename rename, relative-path → absolute. |
| **codeLens** | Editor request | Action lines above `template:`, `## Acceptance Criteria`, `## Ship Timeline`, `## Decision Log`. |
| **inlayHint** | Editor request | Ghost-text after `## Relationships` (outgoing/incoming counts), AC headings (implementations / verifiers), relationship bullets (target status/phase), `status:` frontmatter (days-in-phase/status). |
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
- `validateTemplateMetaLeak` — flags `validation_rules` / `template_id` /
  `template_version` keys that leaked from a template into an instance.
- `validateNaming` — folder-level naming pattern (from
  `.claude/vault-keeper.json` `namingPatterns`).
- `validateSlug` — every folder segment + filename must be
  lowercase-kebab-case (see [naming-conventions](naming-conventions.md)).
- `validatePaths` — relative paths (`./foo.md`, `../bar.md`) in
  frontmatter relationships or body trigger warnings (code blocks are
  stripped first).
- `applyRules(template.validation_rules, ...)` — required fields,
  conditional required fields, field regex/enum/type/min, state machine.
- Body parser warnings — section-format hints from
  `validation_rules.body_section_formats` drive per-section format
  messages (e.g. "Relationship bullet does not match expected format").

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
| `field` (dot-path like `relationships.derived_from`) | `code` |
| derived line number | `range.start.line` |

`source` is always `"vault-keeper"`.

## documentSymbol

Returns the symbol tree as a nested array. Top level:

1. **frontmatter** — `SymbolKind.Object` with one child per frontmatter
   key.
2. **# H1 / ## H2 / ### H3 …** — each heading becomes a
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

- **A frontmatter key** → shows the matching `validation_rules` entry
  (e.g. "Required" / "Allowed values: …" / "Regex: …").
- **A markdown link to a vault file** → shows the target's title +
  status + owner (from the cached frontmatter).
- **An id literal in body text** (e.g. `prd-001`) → resolves the id via
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

Three context-sensitive completion sources:

1. **`@handle` completions** — typing `@` followed by partial text shows
   matching people from `product-data/people/<handle>.md` (or whatever
   directory your vault uses). Sorted with same-tier-folder docs first
   for proximity.
2. **Link-target completions** — typing `](` shows a list of vault
   documents to link to, sorted by proximity to the current file.
3. **Frontmatter enum completions** — typing a value for a field with a
   `values: [...]` rule in the template shows the allowed enum members.

## codeAction

Quick-fix dispatch matches on the diagnostic's `code` (the offending
field path) and optionally the message regex.

Fixers shipped:

- **`code ∈ templateOnlyFields`** — diagnostic for a leaked
  `validation_rules` / `template_id` / `template_version` key offers a
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
| Above `template:` frontmatter line | `↗ N backlinks · ⬆ M acceptance criteria · ⏱ updated Xd ago` | `vault-keeper.openBacklinkList` |
| Above `## Acceptance Criteria` | `▶ Run test cases for all ACs` | `vault-keeper.runTestsForDoc` |
| Above `## Ship Timeline` | `🔒 Lock target date` / `🔓 Unlock target` (toggle) | `vault-keeper.toggleShipTimelineLock` |
| Above `## Decision Log` | `+ Add decision entry` | `vault-keeper.addDecision` |

Counts (backlinks, ACs, days-since-update) come from the vault index +
body parser at request time.

## inlayHint

Ghost-text rendered inline after specific positions. Useful for at-a-
glance counts without opening the linked docs.

| Anchor | Hint |
|---|---|
| `## Relationships` heading | ` (N outgoing, M incoming)` |
| `### AC<n> — title` heading | ` (implementing: X, verified by: Y)` |
| Relationship bullet `- [title](path.md)` | ` (status: <status>, phase: <phase>)` |
| `status:` frontmatter line | ` (in this phase: Xd, total in this status: Yd)` |

Days are derived from the body parser's `phaseHistory` /
`statusHistory` tables.

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
- AC heading normalization (`### AC1 — Title`).
- Relationship bullet normalization
  (`- **predicate** [title](path) — reason`).
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
- [Body parser](body-parser.md) — what the parser extracts +
  warnings.
