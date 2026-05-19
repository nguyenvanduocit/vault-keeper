# claude-code-vault-keeper — Plugin authoring principle

## Generic plugin, template-driven validation

> **This plugin is generic infrastructure, not a vault-specific implementation.**
> The goal: any team can drop `claude-code-vault-keeper` into their own knowledge vault and have it work — without forking the plugin or patching its JS. Vault-shaped settings (content root, scanned folders, exclude globs, filename patterns) come from `.claude/vault-keeper.json`; with no config file the built-in defaults apply (whole repo is the vault).

To preserve that property, two rules are non-negotiable:

### Rule 1 — Logic in the plugin, configuration in the template

- **Plugin (JS source under this directory) MUST stay vault-agnostic.** The CLI validator (`cli/validate-documents.js`), LSP server (`server/*.js`), and shared parsers (`lib/*.js`) must never hardcode:
  - Specific folder paths (e.g. `<some-vault>/<section>/<sub-section>/...`)
  - Specific filename prefixes (e.g. `<x>-NNN`)
  - Specific role names, tier names, status enums, phase enums, lifecycle states
  - Any list of allowed/required fields (every required-field list MUST come from a template's `validation_rules`)
- **All vault-specific configuration MUST live in template markdown frontmatter** under `validation_rules`. Templates are read at runtime; the plugin enforces whatever they declare.
- The validator's job is to LOAD `validation_rules` from the template referenced by each document and ENFORCE it. The validator should never know what the vault's domain words mean — only what the template says about its own constraints.

### Rule 2 — When in doubt, add a template field, not a code branch

If you find yourself adding a new code path that does `if (someVaultSpecificCondition) { ... }` in plugin JS, stop. Instead:

1. Define the constraint as a declarative field in the relevant template's `validation_rules` block.
2. Extend the validator to read that field generically and enforce the constraint based on the field's value.
3. The new field belongs to TEMPLATES; the new ENFORCEMENT belongs to the plugin.

This keeps the plugin reusable: any vault adopting `claude-code-vault-keeper` just authors its own templates with its own `validation_rules`, and the plugin enforces them without modification.

## Concrete examples of template-driven fields the plugin already honors

These fields are declared per-template under `validation_rules:` and enforced generically by `cli/validate-documents.js` + `lib/template-rules.js`:

- `allowed_folders` — regex matched against document path
- `sections[]` — body markdown section ordering vocabulary
- `required_fields[]`, `optional_fields[]`, `conditional_required_fields[]` — frontmatter schema
- `field_rules[]` — per-field regex/enum/type/numeric-bound rules
- `state_machine` — status transition graph
- `required_body_sections[]` — H2 headings that must appear in the body
- `body_section_formats` — format hints for the body parser

## Counter-example — what NOT to do

```js
// ❌ DO NOT: hardcoded vault knowledge in the plugin
if (filepath.includes("/some-section/tasks/")) {
  if (!filename.match(/^t-\d{3}-/)) {
    error("Tasks must start with t-NNN");
  }
}
```

```yaml
# ✅ DO: declarative rule in the template
# templates/task-template.md
validation_rules:
  allowed_folders: "^some-section/tasks/t-\\d{3}-[a-z0-9-]+\\.md$"
```

The plugin JS already knows how to compile and test the regex. It doesn't know — and shouldn't know — what `t-` means.

## Adding a new vault-specific rule — the checklist

1. Identify which template the rule belongs to (the template that authors the documents the rule applies to).
2. Add the new field to that template's `validation_rules` block.
3. If the field shape is brand new (not just a new value for an existing field), extend `lib/template-rules.js:normalizeRules()` to pass it through, and extend `cli/validate-documents.js` to enforce it — generically. The enforcement logic should read the field name dynamically; do not hardcode the field semantics.
4. Document the new field in `templates/README.md` (or equivalent) under the validation-rules reference.
5. Write at least one test in `tests/` that uses the field in a fixture template, proves the validator enforces it, and proves a violation produces the expected error.

## When generic doesn't fit

A small set of plugin features are intentionally generic-only because no template-level constraint can express them: recursive folder walks, regex compilation, gray-matter parsing, frontmatter line mapping, etc. These are pure infrastructure — they don't know what a domain word means — so they live in the plugin. Any feature that DOES require vault-specific knowledge belongs in templates.
