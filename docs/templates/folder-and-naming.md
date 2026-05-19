# Folder & filename rules

This page covers the rules that govern **where a document lives** and
**what it's named**:

- [`allowed_folders`](#allowed_folders) — template-declared path regex.
- [Bundle README pattern](#bundle-readme-pattern) — when a folder's
  `README.md` is the canonical document for that folder.
- [Slug rule](#slug-rule) — every folder segment + filename must be
  lowercase-kebab-case.
- [`namingPatterns`](#namingpatterns-from-vault-config) — vault-level
  folder→regex map for cross-cutting filename conventions.

---

## `allowed_folders`

Each template self-declares the path regex that an instance must match.
Declared inside the template's `validation_rules` block.

```yaml
validation_rules:
  allowed_folders: "^docs/notes/note-\\d{3}-[a-z0-9-]+\\.md$"
```

The validator compiles the source string with `new RegExp()` and tests
it against the document's **repo-relative path** (normalized to forward
slashes regardless of platform separator).

### Anchoring

Anchor with `^` and `$` to pin both ends; the regex must match the
**entire** repo-relative path. Otherwise instances at any depth will
satisfy it.

### Multiple permitted shapes

Use regex alternation. Common pattern: support both flat files and
bundle README form:

```yaml
allowed_folders: >-
  ^docs/notes/note-\\d{3}-[a-z0-9-]+\\.md$|
  ^docs/notes/note-\\d{3}-[a-z0-9-]+/README\\.md$
```

YAML's `>-` folded scalar strips newlines so the regex stays single-
line. The alternative `|` lives inside the regex — don't introduce
whitespace inside the regex source.

### What fires on mismatch

```
[ERR ] field=location  error_type=folder-placement
       Document path "docs/random/note-001-foo.md" does not match
       template's allowed_folders regex.
       fix: Move the file to a folder matching: ^docs/notes/note-\d{3}-...
```

A `null` / absent `allowed_folders` skips the check — useful for
templates whose instances may live anywhere (e.g. a generic note that
spans multiple sections).

### Bad regex → actionable error

If the regex source doesn't compile, the validator emits one error
pointing at the template (not the instance):

```
[ERR ] field=template  error_type=allowed-folders-bad-regex
       Template's allowed_folders is not a valid regex: <RegExp error>
       fix: Fix the regex in the template's validation_rules.allowed_folders.
```

---

## Bundle README pattern

A common vault convention: a single document is implemented as a
**folder containing `README.md` plus supporting files**. Diagrams,
attachments, and sub-docs live next to the README. The README itself
carries the document's frontmatter and is the canonical artifact.

### Why this is non-trivial

`README.md` is globally excluded as folder-meta (the
`**/README.md` entry in default `excludePatterns`). A bundle README
needs to be re-included by the scanner.

### How the validator detects bundle READMEs

The CLI orchestrator runs an extra glob pass that re-includes every
`README.md` whose own `template:` field is something **other than**
`templates/folder-readme-template.md`. The decision is template-driven —
no hardcoded path lists.

If a `README.md` sits at a path that some content template's
`allowed_folders` regex matches as a bundle root, but the doc's own
`template:` field is missing or set to `folder-readme-template.md`, the
validator synthesises a specific error:

```
[ERR ] field=template  error_type=bundle-readme-template-mismatch
       Bundle README has wrong template "<actual>". This path matches a
       content template's bundle pattern. Expected one of:
       templates/<a>.md, templates/<b>.md.
       fix: Set frontmatter "template:" to one of: …
```

This prevents silent skips on bundle conversions (e.g.
`git mv foo.md foo/README.md` without updating `template:`).

### Authoring a bundle-capable template

Author the `allowed_folders` regex with a `/README\.md$` alternative
that participates in the bundle scan:

```yaml
validation_rules:
  allowed_folders: >-
    ^docs/prds/prd-\\d{3}-[a-z0-9-]+\\.md$|
    ^docs/prds/prd-\\d{3}-[a-z0-9-]+/README\\.md$
```

A template that opts into the bundle scan must include `/README\.md`
literally in its regex source — the bundle detector matches on that
substring.

---

## Slug rule

Independent of templates: every folder segment AND every file basename
in the vault must conform to a slug rule. Enforced uniformly across
all `.md` and asset files.

### The rule

Each path segment (folder or file basename) must match:

```
[a-z0-9]+(-[a-z0-9]+)*
```

- Lowercase ASCII letters + digits + hyphen only.
- No leading or trailing hyphen.
- No consecutive hyphens.
- No spaces, no underscores, no uppercase.

Filenames split on the **first** dot — the name portion follows slug
rules, and each dot-separated extension segment also follows slug rules:

| Basename | Name part | Extension chain | OK? |
|---|---|---|---|
| `note.md` | `note` | `md` | ✅ |
| `tailwind.config.js` | `tailwind` | `config.js` | ✅ |
| `Note.md` | `Note` (uppercase) | — | ❌ |
| `note 1.md` | `note 1` (space) | — | ❌ |
| `note_one.md` | `note_one` (underscore) | — | ❌ |

### Task-ID exception

Filenames whose name portion matches the task-id shape
`^[a-z]+-\d+-[a-z0-9]+(-[a-z0-9]+)*$` are accepted unconditionally —
e.g. `t-001-cleanup.md`, `prd-013-feature.md`. The hyphen between
digits and slug is part of the contract.

### Exempt basenames

Well-known files that bypass the slug rule entirely:

```
README.md  BOARD.md  CLAUDE.md  MEMORY.md  LICENSE  LICENSE.md
CHANGELOG.md  CONTRIBUTING.md  DESIGN.md  AGENTS.md
```

These names are widely-used conventions (open-source norms, Google
Labs `DESIGN.md`, agent-context conventions). Renaming them would
break muscle memory + external integrations.

### Hidden files / folders

Path segments starting with `.` (`.git`, `.omc`, `.claude`, `.gitkeep`)
are tooling artifacts and skipped silently.

### Error shape

```
[ERR ] field=folder   Folder 'Bad Folder' violates slug convention …
       fix: Rename folder to 'bad-folder/'
[ERR ] field=filename Filename 'My Note.md' violates slug convention …
       fix: Rename to 'my-note.md' …
```

The validator suggests a kebab-cased rewrite via `suggestSlug()` —
camelCase → camel-Case, underscores → hyphens, strip non-`[a-z0-9-]`
characters, collapse `--`.

---

## `namingPatterns` (from vault config)

Cross-cutting filename rules per folder, declared in
`.claude/vault-keeper.json`:

```json
{
  "namingPatterns": {
    "docs/decisions": "^\\d{4}-\\d{2}-\\d{2}-adr-\\d{3}-[a-z0-9-]+\\.md$",
    "docs/notes":     "^note-\\d{3}-[a-z0-9-]+\\.md$"
  }
}
```

The key is a folder substring; the value is a regex source string
(compiled to a `RegExp` at config load time).

### How matching works

For each entry the validator checks if the document's path **contains**
the folder key. If yes, the regex is tested against the basename.

- Files **nested deeper than the folder root** (i.e. with intermediate
  path segments between the folder and the file) are **exempted**.
  Rationale: those files live inside a bundle (or a bundle's discipline
  sub-folder) and follow the template's own `allowed_folders` regex,
  not the parent folder's flat-file prefix pattern.
- `README.md` is always exempt (it's the universal folder-meta name; a
  bundle README's naming comes from its parent folder's slug + template
  regex).

### When to use namingPatterns vs template `allowed_folders`

| Concern | Where to declare |
|---|---|
| **One template's filename shape** | Template `validation_rules.allowed_folders` |
| **A folder hosting one type of doc with one filename convention** | Either — both work |
| **A folder hosting several templates, all sharing one filename prefix** | Vault `namingPatterns` |

In a vault where one folder hosts only one template type, prefer the
template's `allowed_folders` — it keeps the rule co-located with the
template that requires it. Use `namingPatterns` for cross-cutting rules
that span multiple templates in the same folder (e.g. "everything under
`decisions/` is dated, regardless of template").

---

## A complete example

Template:

```yaml
---
template_path: templates/note-template.md
document_type: note
validation_rules:
  required_fields: [template, document_type, title, owner]
  allowed_folders: "^docs/notes/note-\\d{3}-[a-z0-9-]+\\.md$"
---
```

Vault config:

```json
{
  "vaultRoot": "docs",
  "vaultFolders": ["docs"],
  "namingPatterns": {
    "docs/decisions": "^\\d{4}-\\d{2}-\\d{2}-adr-\\d{3}-[a-z0-9-]+\\.md$"
  }
}
```

| Path | Result |
|---|---|
| `docs/notes/note-001-foo.md` | ✅ matches both template + slug rule |
| `docs/notes/foo.md` | ❌ `allowed_folders` fails (no `note-NNN-` prefix) |
| `docs/notes/Note-001.md` | ❌ slug rule fails (uppercase) |
| `docs/decisions/random-thought.md` | ❌ `namingPatterns` fails (no date prefix) |
| `docs/decisions/2026-05-12-adr-007-foo.md` | ✅ |

## See also

- [Frontmatter rules](frontmatter-rules.md) — required fields, regex,
  state machine.
- [Body rules](body-rules.md) — body section-rules, section ordering.
- [Naming conventions](../naming-conventions.md) — the slug rule in
  isolation, with exempt-basename rationale.
- [Vault config](../vault-config.md) — `namingPatterns` syntax.
