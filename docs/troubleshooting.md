# Troubleshooting

Common error messages, what they mean, and how to fix them.

For each entry: the diagnostic's `level` + `field` + `message` excerpt,
followed by **What** (interpretation) and **Fix** (concrete steps).

## Frontmatter / template resolution

### `[ERR] field=template — Missing required template field`

**What:** Your document's frontmatter has no `template:` key. Without
it the validator can't pick a schema to enforce.

**Fix:** Add the `template:` field. Path is relative to the project
root, must start with `templates/`, must end with `.md`:

```yaml
---
template: templates/note-template.md
title: My note
---
```

---

### `[ERR] field=template — Invalid template path: <value>`

**What:** Your `template:` field doesn't start with `templates/` or
doesn't end with `.md`.

**Fix:** Templates must live under `<projectRoot>/templates/`. Common
mistakes:

```yaml
template: prd-template.md                 # ❌ missing templates/ prefix
template: ./templates/prd-template.md     # ❌ relative path
template: /templates/prd-template.md      # ❌ absolute path
template: templates/prd-template          # ❌ missing .md extension
template: templates/prd-template.md       # ✅
```

---

### `[ERR] field=template — Cannot load validation_rules from template '<path>' …`

**What:** The validator found the `template:` field but could not load
the file, or the file has no `validation_rules:` block in its
frontmatter, or its frontmatter is malformed YAML.

**Fix:** Three checks, in order:

1. **File exists.** `ls <projectRoot>/<template-path>` — does the
   file exist at exactly that path?
2. **Frontmatter parses.** Open the template, check the YAML between
   `---` fences. A common gotcha: a value contains `:` and isn't
   quoted (`description: line: 1` is invalid YAML).
3. **`validation_rules:` block present.** The template's frontmatter
   must contain a top-level `validation_rules:` key, even if it's
   empty:

   ```yaml
   ---
   template_path: templates/note-template.md
   validation_rules: {}
   ---
   ```

---

### `[WARN] field=<field> — Template-only field "<field>" leaked into instance from template scaffold`

**What:** Your instance frontmatter contains a key that belongs only
to templates: `validation_rules`, `template_version`, or `template_id`.
These typically leak via copy-paste from a template scaffold.

**Fix:** Remove the key from your instance's frontmatter:

```yaml
---
template: templates/note-template.md
title: My note
# validation_rules: ...     ← delete this whole block
---
```

The LSP's code-action quick-fix offers an automated "Delete from
frontmatter" for this warning.

## Required fields + field rules

### `[ERR] field=<field> — Missing required field: <field>`

**What:** A field listed in the template's `required_fields` is
absent, `null`, or an empty string.

**Fix:** Add the field with a non-empty value:

```yaml
required_fields: [template, title, owner]
```

```yaml
---
template: templates/note-template.md
title: My note
owner: '@alice'         ← was missing
---
```

The LSP code-action quick-fix offers an "Insert placeholder" — handy
for getting a syntactically-valid placeholder in place quickly.

---

### `[ERR] field=<field> — Required when <condition>`

**What:** A `conditional_required_fields` entry's DSL condition
matched, so the field becomes required. The message includes the
condition verbatim.

**Fix:** Either:

1. **Add the required field** with a real value.
2. **Change the trigger field** so the condition no longer matches.
   E.g. if the rule is `condition: "status in ['shipped']"
   field: shipped_date`, set `status: approved` (the condition won't
   match) — but only if the doc genuinely isn't shipped yet.

---

### `[ERR] field=<field> — Need at least <N> entries when <condition>`

**What:** A `conditional_required_fields` entry uses `min_count: N`
and the field is an array shorter than `N`.

**Fix:** Either add more entries to the array, or change the trigger
field so the condition no longer matches.

---

### `[ERR] field=<field> — Value '<value>' fails regex <regex>`

**What:** A `field_rules` entry's `regex` didn't match the field's
value.

**Fix:** Edit the value to match the regex. Common patterns:

```yaml
field: created
regex: "^\\d{4}-\\d{2}-\\d{2}$"      # YYYY-MM-DD

field: ticket_id
regex: "^[A-Z]+-\\d+$"               # PROJ-123 shape

field: version
regex: "^\\d+\\.\\d+\\.\\d+$"        # SemVer
```

YAML backslash escaping: write `\\d` (double-backslash) so the
resulting JS string is `\d`.

---

### `[ERR] field=<field> — Invalid <field>: '<value>'`

**What:** A `field_rules` entry's `values:` enum doesn't include the
value you supplied.

**Fix:** Use one of the permitted values listed in the error message.

---

### `[ERR] field=<field> — Expected integer for <field>, got <type>: <value>`

**What:** A `field_rules` entry sets `type: integer` but the value
isn't an integer. Strings of digits fail (they're not numbers).

**Fix:** Use an unquoted integer:

```yaml
# ❌
rice:
  reach: "50"

# ✅
rice:
  reach: 50
```

---

### `[ERR] field=<field> — Value <N> below minimum <M> for <field>`

**What:** A `field_rules` entry has `min: M` and the value is below
that.

**Fix:** Use a value ≥ `M`.

---

### `[WARN] field=status — Status '<value>' is not declared in template state_machine`

**What:** The `status` value doesn't match any declared key in the
template's `state_machine`.

**Fix:** Either use one of the declared states (listed in the error
message), or extend the template's state machine to include the new
state. The latter is appropriate when you're legitimately adding a new
lifecycle state to the document type.

## Folder / filename / slug

### `[ERR] field=location — Document path "<path>" does not match template's path_regex`

**What:** The document's repo-relative path doesn't match the
template's `path_regex`.

**Fix:** Either:

1. **Move/rename the file** to a path that matches the regex (the fix
   line includes the regex pattern).
2. **Change the `template:` field** to a different template whose
   `path_regex` accepts this path.
3. **Loosen the template's regex** if your folder taxonomy genuinely
   evolved.

---

### `[ERR] field=template — Template's path_regex is not a valid regex`

**What:** The `path_regex` string in your template doesn't compile to
a valid `RegExp`.

**Fix:** Inspect the regex source in the template's
`validation_rules.path_regex`. Common gotchas:

- Unescaped special characters: `(`, `)`, `[`, `]`, `+`, `*` need `\\`
  in YAML.
- Unclosed groups / character classes.

Test the regex in isolation:

```js
new RegExp("^docs/notes/note-\\d{3}-[a-z0-9-]+\\.md$")
// throws if malformed
```

---

### `[ERR] field=folder — Folder '<name>' violates slug convention …`

**What:** A folder segment in the path contains uppercase, spaces,
underscores, or other non-slug characters.

**Fix:** Rename the folder. The error includes a kebab-case suggestion.

---

### `[ERR] field=filename — Filename '<name>' violates slug convention …`

**What:** The filename (or one of its dot-separated extension
segments) violates the slug rule.

**Fix:** Rename the file. The error includes a suggestion. Note the
exempt basenames (`README.md`, `CLAUDE.md`, `LICENSE`, etc.) that
bypass this rule — see [naming-conventions](naming-conventions.md).

The LSP code-action quick-fix offers an automated rename via
`WorkspaceEdit`.

---

## Bundle README

### `[ERR] field=template — Bundle README has wrong template "<actual>". This path matches a content template's bundle pattern.`

**What:** A `<id>/README.md` sits at a path that some template's
`path_regex` matches as a bundle root, but the README's own
`template:` field is missing or set to `folder-readme-template.md`.
The validator caught the mismatch.

**Fix:** Set the README's `template:` field to one of the candidate
content templates listed in the error message. Bundle-root READMEs
declare the actual content template, NOT
`folder-readme-template.md`.

```yaml
# docs/prds/prd-005-foo/README.md
---
template: templates/prd-template.md          ← was "folder-readme-template.md" or missing
title: Foo PRD
---
```

## Body parser warnings

### `[WARN] code=body — Relationship bullet does not match expected format …`

**What:** A bullet line under `## Relationships` doesn't match the
canonical shape. The expected format string is included in the message.

**Fix:** Rewrite the bullet to match. Canonical shape:

```markdown
- **<predicate>** [<title>](<path>) [— *<reason>*]
```

The canonical formatter (LSP format-on-save) auto-normalises many
common deviations: `- predicate: [title](path)`,
`- predicate [title](path)`, etc.

---

### `[WARN] code=body — AC heading does not match expected format …`

**What:** An H3 under `## Acceptance Criteria` doesn't match the
canonical shape.

**Fix:** Canonical form: `### AC<n> — <title> — \`<priority>\` ·
\`<status>\``. The formatter auto-normalises some variants (`AC1:` →
`AC1 —`).

---

### `[WARN] code=body — Found N relative path(s) in document body`

**What:** Your body contains markdown links written with relative
paths (`./foo.md`, `../bar.md`) outside of fenced code blocks. The
validator treats those as authoring smells — vault relative paths
break when files move; absolute paths from the project root are more
robust.

**Fix:** Replace relative paths with absolute (from project root) or
move the link inside a fenced code block if it's actually code/
example markup.

The LSP code-action quick-fix offers a "Replace with absolute path"
action for this warning.

## CLI / runtime

### `bun: command not found`

**What:** Bun isn't installed on your machine (or runner).

**Fix:** `curl -fsSL https://bun.sh/install | bash`, then ensure
`~/.bun/bin` is on `PATH`. The validator's shebang is
`#!/usr/bin/env bun`.

---

### CLI exits 1 with no error message

**What:** Sometimes happens if the project root resolution falls
through to a directory that has no documents. Or your `--root` points
somewhere that doesn't exist.

**Fix:** Pass `--root` explicitly and inspect the resolved path:

```bash
bun cli/validate-documents.js --root "$PWD"
```

Or run with `--json` and inspect the output:

```bash
bun cli/validate-documents.js --root "$PWD" --json | jq '.summary'
```

If `summary.total === 0`, your scan found no documents — check
`vaultFolders` in `.claude/vault-keeper.json`.

---

### Validator says all docs are valid, but the LSP shows diagnostics

**What:** The LSP runs the per-doc subset of rules + body-parser
shape warnings. The CLI in non-strict mode reports only errors.

**Fix:** Run the CLI with `--strict` to see the warnings the LSP is
flagging:

```bash
bun cli/validate-documents.js --root "$PWD" --strict
```

---

### LSP isn't showing diagnostics in the editor

**What:** The LSP only attends to files under your configured
`vaultFolders`. Plus it needs to recognise the directory as a vault
root.

**Fix checklist:**

1. The file's parent directory chain contains either `templates/` or
   `.claude/vault-keeper.json`. (LSP root detector.)
2. The file's repo-relative path is under one of `vaultFolders` (or
   `vaultFolders` is `["."]` which matches everything).
3. The file's basename is NOT `CLAUDE.md` / `CLAUDE.local.md` (those
   are silently ignored as agent-context prompts).
4. The LSP bundle is present at `server/main.bundled.cjs`. If not,
   `bun run build`.
5. `.lsp.json` exists and points at the bundle.

The Claude Code LSP console (visible inside the editor) prints
`vault-keeper: projectRoot=…` on initialize. If that
line shows `(unresolved)` the LSP couldn't find a vault root — add a
`.claude/vault-keeper.json` file or a `templates/` directory.

## Performance / scale

### CLI feels slow on a huge vault

**What:** First-run cost is dominated by reading every file + parsing
every body. Typical: ~500 files in <1s on warm Bun; larger vaults
scale linearly.

**Fix options:**

- Run `--path` instead of full-vault when you only care about a
  subtree.
- For CI: rely on PR-level glob filters to scope the validator to
  only-changed files via a `find $CHANGED_FILES` loop.
- Move heavy `regex` patterns to template-local scope (so they only
  fire on matching documents) rather than as global `field_rules`.

## Where to file a bug

If you hit a diagnostic whose `fix` line doesn't actually fix it, or
the validator crashes with a stack trace, that's a bug. File a GitHub
issue with:

1. The smallest reproducer template + instance.
2. The exact command you ran.
3. The full output (including the stack if any).
4. Your `.claude/vault-keeper.json` (if any).

## See also

- [CLI validator](cli-validator.md) — flag reference + JSON shape.
- [LSP features](lsp-features.md) — what the editor shows.
- [Templates](templates/README.md) — rule vocabulary.
- [Naming conventions](naming-conventions.md) — slug rule details.
