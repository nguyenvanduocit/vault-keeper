# Body rules

The rules that govern what appears **inside the body** of an instance.
Three surfaces interact:

- [`sections`](#sections) — canonical H2 ordering for the formatter.
- [Body section-rules code fences](#body-section-rules-code-fences) —
  per-section requirements declared inside the template's body.
- [`body_section_formats`](#body_section_formats) — format hints fed
  to the body parser for shape-warnings on specific sections.

For body PARSER details (which sections are recognised, what gets
extracted, what warnings the parser emits independent of templates) see
[body-parser](../body-parser.md).

---

## `sections`

A list of section slugs declaring the canonical body ordering. Used by
the canonical formatter to reorder H2 sections deterministically.

```yaml
validation_rules:
  sections:
    - problem
    - goals
    - acceptance-criteria
    - "*"
    - relationships
```

### Slug format

The slug is the H2 heading text **lowercased, with spaces replaced by
hyphens**. `## Acceptance Criteria` → `acceptance-criteria`.

The mapping is exact — `## Acceptance Criteria` and `## acceptance
criteria` both slugify to `acceptance-criteria` (case-insensitive
heading match).

### Wildcard `"*"`

The `"*"` entry is the **insertion point for unlisted sections** in
their source order:

- If `*` is present at index N, any H2 sections in the source that are
  NOT in the explicit slug list get inserted starting at position N.
- If `*` is absent, unlisted sections go to the end.

### Behavior

The formatter reorders sections deterministically — running it twice
produces the same output. It does NOT delete or rename sections; it
only moves them. Sections without a matching slug entry survive as
"unlisted" and slot in per the wildcard rule.

The CLI validator does **not** flag missing sections from this list —
that's `required: true` in section-rules' job (below). `sections[]` is
purely a sort key.

### Use case

Mechanical ordering for any vault that wants every PRD / spec / note
to look the same on disk regardless of authoring order.

---

## Body section-rules code fences

Each H2 section in a template body may carry a fenced `yaml
section-rules` code block declaring per-section requirements:

````markdown
## Acceptance Criteria

```yaml section-rules
required: true
heading_format: "### AC<n> — <text> — `<priority>` · `<status>`"
example: "### AC1 — User can checkout — `must` · `verified`"
valid_priorities: [must, should, nice]
valid_statuses: [draft, in_progress, verified, descoped]
```

(template body content for this section continues here)
````

The fence is **regular YAML inside a `yaml` code block whose `meta`
attribute is exactly `section-rules`**. The template parser walks the
AST, finds each H2 heading, looks for the first `yaml section-rules`
code block in that section's subtree, parses it as YAML, and stores
the result keyed by the section's snake-cased name.

### Templates only — a document carrying one is flagged

The `yaml section-rules` fence is a **template-authoring construct**. A
`yaml section-rules` block found in an authored document is almost
always a template fragment that was copy-pasted in by mistake — so both
the CLI and the LSP carry a built-in rule that flags it as an error
(`error_type: section-rules-leak`):

> A "\`\`\`yaml section-rules" code block belongs to templates only and
> must not appear in a document

Templates under `templates/` are exempt — that is where the fence
belongs. To *document* the construct inside an authored document (as
this page does), wrap it in an outer fence; the parser then sees the
inner fence as plain text, not a real `section-rules` block.

### Recognised keys

| Key | Type | Effect |
|---|---|---|
| `required` | bool | `true` → this H2 section must exist in instances |
| All other keys | any | Passed through as documentation / format hints (consumed by [body_section_formats](#body_section_formats) — see below) |

### Heading → snake_case

| Heading | Section key |
|---|---|
| `## Relationships` | `relationships` |
| `## Acceptance Criteria` | `acceptance_criteria` |
| `## Ship Timeline` | `ship_timeline` |
| `## Decision Log` | `decision_log` |

Multi-word headings collapse spaces to underscores.

### Documentation as data

Keys beyond `required` are not enforced by the validator — they exist
to be passed to the body parser as `formatHints`. Conventional keys:

- `heading_format` — text describing the expected heading shape.
- `example` — a concrete example the body parser quotes in error
  messages.
- `valid_priorities`, `valid_statuses`, etc. — enum hints the body
  parser surfaces in warnings.

The body parser's warning generator looks for these keys and uses them
to render actionable error messages — see `body_section_formats`
below.

---

## `body_section_formats`

Format hints fed to the body parser to drive shape-warnings on specific
sections. Declared in `validation_rules`, structured the same way as
section-rules code fences:

```yaml
validation_rules:
  body_section_formats:
    relationships:
      format: "- [<title>](<path>) [— *<reason>*]"
      example: "- [Goal Net Profit](../strategy/goal-001.md) — *bets on this*"
    contributions:
      format: "**<role>** · @<handle> · <ISO-ts> · sections: `<list>` · effort: `<level>`"
      example: "**author** · @alice · 2026-01-01T00:00:00Z · sections: `*` · effort: `medium`"
```

### What the parser does with these

When the body parser encounters a bullet line in a recognised section
that doesn't match the canonical regex, it emits a warning:

```
[WARN] code=body  Relationship bullet does not match expected format:
       `- [<title>](<path>) [— *<reason>*]`
       fix: Fix the format to match the expected pattern shown in the message
```

The `format:` string is included verbatim in the warning so the author
sees exactly what's expected.

### Body section-rules ↔ `body_section_formats` precedence

The two surfaces overlap in spirit (both attach metadata to sections).
The engine merges them:

- Body section-rules (code fences in template body) take precedence
  when both define the same section.
- `body_section_formats` is the legacy "frontmatter-only" surface; the
  newer convention is body section-rules.

For a fresh template, declare format hints inside the body via
section-rules code fences — they're co-located with the template's
documentation, not split across frontmatter + body.

---

## Recognised body sections (from the parser)

The body parser understands a fixed set of section headings out-of-the-
box. Even with no template-level format hints, these get parsed into
structured data + emit shape warnings:

| Heading | What the parser extracts |
|---|---|
| `## Relationships` | Typed-link bullet list → `relationships[]` |
| `## Acceptance Criteria` | Per-AC sub-entities w/ implementing / verifying refs → `acceptanceCriteria[]` |
| `## User Stories` | PRD → story refinements → `userStories[]` |
| `## Status History` | Tabular history → `statusHistory[]` |
| `## Phase History` | Tabular history → `phaseHistory[]` |
| `## Blocked History` | Tabular history → `blockedHistory[]` |
| `## RICE Score` | Reach/Impact/Confidence/Effort → `riceScore` |
| `## Ship Timeline` | Target-ship-date table + history → `shipTimeline` |
| `## Contributions` | Bullet list → `contributions[]` |
| `## Success Metric Verdict` | Verdict object → `metricVerdict` |
| `## Data Sources` | Source-type breakdown → `dataSources` |

If your vault doesn't use these conventions, leave them out — the
parser only emits warnings when it tries to parse a malformed bullet/
table inside a recognised section. Sections it doesn't recognise pass
through untouched.

See [body-parser](../body-parser.md) for the full extraction shape and
warning catalogue.

---

## A complete example

````markdown
---
template_path: templates/prd-template.md
document_type: prd
validation_rules:
  required_fields: [template, document_type, title, owner, status]
  sections:
    - problem
    - goals
    - acceptance-criteria
    - ship-timeline
    - "*"
    - relationships
---

# PRD Template

## Problem

```yaml section-rules
required: true
example: "Describe the user problem here in 2-3 sentences."
```

## Goals

```yaml section-rules
required: true
```

## Acceptance Criteria

```yaml section-rules
required: true
heading_format: "### AC<n> — <text> — `<priority>` · `<status>`"
example: "### AC1 — User can checkout — `must` · `verified`"
valid_priorities: [must, should, nice]
valid_statuses: [draft, in_progress, verified, descoped]
```

## Ship Timeline

```yaml section-rules
required: false
```

## Relationships

```yaml section-rules
required: false
format: "- [<title>](<path>) [— *<reason>*]"
example: "- [DIBB-001](../strategy/dibbs/dibb-001.md) — *bets on growth*"
```
````

An instance that omits `## Problem` triggers a missing-required-section
warning. An instance whose `## Acceptance Criteria` contains a bullet
that doesn't match the heading_format triggers a body warning at that
line.

## See also

- [Frontmatter rules](frontmatter-rules.md) — `required_fields`,
  `field_rules`, state machine.
- [Folder & filename rules](folder-and-naming.md) —
  `path_regex`, slug rules.
- [Full example](full-example.md) — end-to-end template + instance.
- [Body parser](../body-parser.md) — what the parser extracts +
  warnings.
- [Canonical formatter](../canonical-formatter.md) — how `sections[]`
  drives reordering.
