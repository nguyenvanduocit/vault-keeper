---
name: vault.new
description: "Scaffold a new vault document from a template — read the template's `validation_rules` via the public API (`loadTemplateRules`), generate frontmatter placeholders for every `required_field`, derive the target path from the template's `path_regex`, write the file, then validate it. Generic across vault shapes; reads everything from the template at runtime. Use when the user says 'new task', 'new doc', 'tạo doc mới', 'scaffold doc', 'thêm task', 'create from template', '/vault.new <type> [slug]'."
---

# vault.new — scaffold a doc from a template

This skill creates a new document conforming to a template's `validation_rules`. It reads the template at runtime via the public API — no field name, no path prefix, no status value is hardcoded.

## Inputs

The user invokes `/vault.new <type> [slug]`. Examples:
- `/vault.new task fix-login`
- `/vault.new prd checkout-redesign`
- `/vault.new note` (slug derived from current date)

## Pre-flight (silent unless blocked)

1. Resolve project root: `${CLAUDE_PROJECT_DIR:-$PWD}`.
2. Resolve template path: `templates/<type>-template.md`. If absent, list `ls templates/` and abort with: *"Template `templates/<type>-template.md` not found. Available: <list>."*

## Step 1 — load template rules via public API

Use `Bash` to invoke the public API:

```bash
node -e "
import('claude-code-vault-keeper').then(async ({ loadTemplateRules }) => {
  const rules = await loadTemplateRules('templates/<type>-template.md');
  console.log(JSON.stringify(rules));
});
"
```

Parse the JSON. Extract:
- `required_fields` — array of field names
- `optional_fields` — array
- `field_rules` — array of per-field constraints (`field`, `values`/`regex`/`type`/`min`)
- `path_regex` — the path pattern the new doc must match
- `state_machine` — keys are valid `status` values (used to pick a starting state)

## Step 2 — derive the target file path

Parse `path_regex` to find the literal prefix (everything before the first regex meta character `\d`, `[`, `(`, `*`, `+`, `?`). Example: `^docs/tasks/t-\\d{3}-[a-z0-9-]+\\.md$` → literal prefix `docs/tasks/t-`, numeric pattern `\d{3}`, slug placeholder.

Algorithm:
1. Extract literal prefix.
2. If regex has a numeric segment (`\d{N}`), `ls <prefix-dir>/` and find max existing `<prefix><number>-*` → increment. Pad to N digits.
3. Append `<slug>.md` (or current date if no slug provided).
4. If the derived path already exists, abort with: *"Target `<path>` already exists. Pick a different slug."*

If `path_regex` is missing or has no literal prefix, ask the user via `AskUserQuestion` for the target path.

## Step 3 — generate frontmatter placeholders

For each field in `required_fields`, pick a value:

| Field shape | Placeholder |
|---|---|
| `template` (always required) | `templates/<type>-template.md` |
| `field_rules` with `values: [...]` | first value in the list |
| `field_rules` with `type: integer, min: M` | `M` |
| `field_rules` with `regex: ...` | `'@TODO'` (literal placeholder for the user to fill in) |
| `field` matching `created` / `updated` / `*_date` | today in `YYYY-MM-DD` |
| `field` matching `owner` | `'@TODO'` |
| `title` | slug humanized (replace hyphens with spaces, title-case) |
| anything else | `'@TODO'` |

Order keys priority-first: `template`, `title`, `status`, `phase`, `owner`, `created`, `updated`, then the rest alphabetically. Match the canonical formatter's expected order.

## Step 4 — write the file

Use the `Write` tool. The body section can include just the H2 headings the template declares under `required_body_sections` (read those from the same `loadTemplateRules` call). Leave each section empty for the user to fill.

## Step 5 — validate

Run:

```bash
node cli/main.js validate --path <newfile> --root "${CLAUDE_PROJECT_DIR:-$PWD}"
```

(Use `vault-keeper validate ...` if on PATH; otherwise the local node invocation above.)

If exit 0 → success.
If exit 1 → the validator's report tells the user exactly which placeholders to replace. Surface the diagnostic verbatim plus: *"Edit `<newfile>` to replace the `'@TODO'` placeholders, then re-validate."*

## Output contract

```
vault.new — created <type> document

  path:      <newfile>
  template:  templates/<type>-template.md
  validate:  ✅ green (or: ⚠️ N placeholders to fill)

Next: edit the file, replace placeholders, then `/vault.health` or `/vault.fix` as needed.
```

## Refusal contract

Refuse if:
- Template does not exist.
- Template's `validation_rules` is missing or unparseable.
- Target path already exists (do not clobber).
- `path_regex` has no derivable literal prefix and the user declines to provide a path.

## Composition

- Pairs with `/vault.setup` — setup creates templates, new creates docs from them.
- Pairs with `/vault.fix` — fix can canonicalize the new doc after manual edits.
- Pairs with `/vault.health` — health verifies the whole vault after multiple new docs.
- Does NOT auto-commit. Commit is the user's call (or `/vault.sync`).
