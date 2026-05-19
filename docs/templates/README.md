# Templates

Templates are the **single configuration surface** for vault-specific
validation. The plugin ships zero domain knowledge — every required
field, allowed enum, state transition, and folder regex comes from a
template's `validation_rules` block.

## Anatomy

A template is a regular markdown file under `templates/` with three
ingredients:

```markdown
---
template_path: templates/note-template.md          # 1. self-reference
document_type: note                                # 2. doc-type tag
validation_rules:                                  # 3. the rule block
  required_fields: [template, document_type, title, owner]
  field_rules:
    - field: status
      values: [draft, review, approved]
  allowed_folders: "^docs/notes/"
  sections: [problem, solution, "*"]
  state_machine:
    draft: [review]
    review: [approved, draft]
    approved: []
---

# Note Template — body content goes here

Body sections, format hints, and section-rules code fences live here.

```yaml section-rules
relationships:
  required: false
```

## Relationships
```

The validator only reads the frontmatter's `validation_rules` block plus
the body's `yaml section-rules` code fences. The rest of the body is
free-form documentation for the human / agent authoring instances.

### How instances reference templates

Every vault document declares the template it conforms to via the
`template:` frontmatter field:

```yaml
---
template: templates/note-template.md
title: My note
owner: '@alice'
---
```

The validator resolves the template path relative to the project root,
loads its `validation_rules`, and enforces them against the instance.
A doc whose `template:` can't be resolved fails with one canonical
error — `Cannot load validation_rules from template '<path>' …`.

## What goes inside `validation_rules:`

| Field | Type | Effect | Reference |
|---|---|---|---|
| `required_fields` | `string[]` | Frontmatter keys that must be present + non-empty | [frontmatter-rules](frontmatter-rules.md) |
| `optional_fields` | `string[]` | Permitted but not required (informational) | [frontmatter-rules](frontmatter-rules.md) |
| `conditional_required_fields` | `object[]` | Required only when a DSL condition matches | [frontmatter-rules](frontmatter-rules.md) |
| `field_rules` | `object[]` | Per-field `regex` / `values` / `type` / `min` | [frontmatter-rules](frontmatter-rules.md) |
| `state_machine` | `object` | `state: [allowed-next-states]` graph; warns on unknown status | [frontmatter-rules](frontmatter-rules.md) |
| `allowed_folders` | `string` (regex) | Document path must match this regex | [folder-and-naming](folder-and-naming.md) |
| `sections` | `string[]` | Body H2 section ordering (used by the canonical formatter) | [body-rules](body-rules.md) |
| `body_section_formats` | `object` | Per-section format hints fed to the body parser | [body-rules](body-rules.md) |
| `tier` | `string` | Optional grouping label — read by LSP completion for proximity sort | — |

Inside the body, fenced `yaml section-rules` code blocks declare
per-section requirements:

```yaml section-rules
required: true                       # this H2 section must exist in instances
heading_format: "..."                # documentation only
example: "..."                       # documentation only
```

See [body-rules](body-rules.md) for the full section-rules vocabulary.

## Design principles

### 1. Logic in the plugin, configuration in the template

The validator's job is to LOAD `validation_rules` from the template and
ENFORCE them. The validator should never know what your domain words
mean — only what the template says about its own constraints.

### 2. When in doubt, add a template field — not a code branch

If you find yourself wanting `if (filepath.includes("/some-section/")) { … }`
in plugin code, stop. Express the constraint as a declarative rule in the
relevant template's `validation_rules` block. The plugin enforces what
the template declares.

### 3. Templates are markdown — readable as both spec and example

A template body is **content** that documents how an instance should look.
The format hints + section-rules code fences double as documentation for
the agent / human authoring the instance.

## Where to read next

1. [Frontmatter rules](frontmatter-rules.md) — required fields, regex,
   enums, conditional rules with DSL, state machine.
2. [Folder & filename rules](folder-and-naming.md) — `allowed_folders`,
   bundle README detection, naming conventions.
3. [Body rules](body-rules.md) — `sections[]`, section-rules code
   fences, format hints for the body parser.
4. [Full example](full-example.md) — a complete PRD-style template + a
   conforming instance + the diagnostics that would fire on broken
   variants.
