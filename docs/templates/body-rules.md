# Body rules

The rules that govern what appears **inside the body** of an instance.
Two surfaces interact:

- [`sections`](#sections) — canonical H2 ordering for the formatter.
- [Body section-rules code fences](#body-section-rules-code-fences) —
  per-section requirements declared inside the template's body via
  `yaml section-rules` fenced code blocks.

---

## `sections`

A list of section slugs declaring the canonical body ordering. Used by
the canonical formatter to reorder H2 sections deterministically.
Declared at the top level of a template's frontmatter (not inside
`fields:`):

```yaml
sections:
  - problem
  - goals
  - acceptance-criteria
  - "*"
  - relationships
```

### Slug format

The slug is the H2 heading text **lowercased, with spaces replaced by
hyphens**. `## Acceptance Criteria` -> `acceptance-criteria`.

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

---

## Body section-rules code fences

Each heading in a template body may carry a fenced `yaml section-rules`
code block declaring per-section requirements:

````markdown
## Problem

```yaml section-rules
required: true
```

(template body content for this section continues here)
````

The fence is **regular YAML inside a `yaml` code block whose `meta`
attribute is exactly `section-rules`**. The template parser walks the
heading tree, finds each heading, looks for the first `yaml
section-rules` code block in that heading's content, parses it as YAML,
and stores the result as the heading's `sectionRules`.

### Templates only — a document carrying one is flagged

The `yaml section-rules` fence is a **template-authoring construct**. A
`yaml section-rules` block found in an authored document is almost
always a template fragment that was copy-pasted in by mistake — so both
the CLI and the LSP carry a built-in rule that flags it as an error
(`error_type: section-rules-leak`):

> A `` ```yaml section-rules `` code block belongs to templates only and
> must not appear in a document

Templates under `templates/` are exempt — that is where the fence
belongs. To *document* the construct inside an authored document (as
this page does), wrap it in an outer fence; the parser then sees the
inner fence as plain text, not a real `section-rules` block.

### Section-rules keys

The engine recognizes a closed set of 11 keys in a section-rules block.
Unknown keys produce a `template-schema-invalid` error during
meta-validation.

| Key | Type | Effect |
|---|---|---|
| `required` | boolean or `{ when: "..." }` | `true` -> this heading must exist in instances. Supports the `when` DSL for conditional requirements. |
| `repeatable` | boolean | `true` -> this heading is a pattern-placeholder that claims all unclaimed doc headings at the same depth. |
| `heading` | `{ pattern?, enum? }` | Constrain the heading text of matched sections. `pattern` is a regex; `enum` is a list of allowed values (case-insensitive match). |
| `table` | `{ columns?, rows?, strict? }` | Require a GFM table. `columns:` is either `[string]` (shorthand: required headers) or `[{name, required?, values?}]` (per-column rules — see below). `rows: {min?,max?}` for row cardinality; `strict: true` rejects undeclared columns. |
| `list` | `{ items?, min?, max?, unique? }` | Require a list. `items: {required?, pattern?, enum?}` apply per-item; `min`/`max`/`unique` are list-level. |
| `code` | `{ lang?, min?, max?, content? }` | Require fenced code blocks. `lang` filters by language; `min`/`max` bound fence count (default `min: 1`); `content: {pattern}` matches each fence's body. |
| `formula` | string (expression) | Arithmetic / comparison expression evaluated against frontmatter values. See [formula primitive](#formula-primitive). |
| `min` | number | Minimum cardinality for repeatable headings. |
| `max` | number | Maximum cardinality for repeatable headings. |
| `severity` | `"error"` or `"warning"` | Override the default severity for all issues from this section. |
| `message` | string | Override the default error message for all issues from this section. |

Unknown nested keys (e.g. `table.coluns`, `list.item`, `code.contnt`)
produce a `template-schema-invalid` error with a "did you mean …?"
suggestion drawn from the closed inner-key set of each compound
primitive.

### Heading matching

Non-repeatable schema headings are matched against document headings
by **normalized text** (lowercased, trimmed) at the same depth. A
`## Problem` schema node matches a `## problem` or `## Problem`
document heading.

Repeatable schema headings claim **all unclaimed** document headings at
the same depth. Use the `heading` key to constrain which headings are
valid matches.

### Nesting

Section-rules support hierarchical nesting. A template heading at depth
3 (`### <item>`) nested under a depth 2 heading (`## Acceptance
Criteria`) validates against the corresponding nested structure in the
document:

````markdown
## Acceptance Criteria

```yaml section-rules
required: true
```

### <item>
```yaml section-rules
repeatable: true
heading:
  pattern: "^AC\\d+ — .+ — `(must|should|nice)` · `(draft|in_progress|verified|descoped)`$"
```
````

---

## Repeatable headings

When `repeatable: true` is set, the schema heading acts as a
**pattern-placeholder** that claims all unclaimed document headings at
the same depth under the same parent.

### Cardinality

- `min` — minimum number of matching headings (default: `1` if
  `required: true`, else `0`).
- `max` — maximum number of matching headings (default: unlimited).

```yaml section-rules
repeatable: true
min: 1
max: 10
heading:
  pattern: "^AC\\d+ — "
```

Error type: `cardinality`.

### Heading validation

Each claimed heading's text is validated against the `heading` key
(if present). For example, a heading `### AC1 — bad format` that
doesn't match the declared `heading.pattern` produces a
`heading-mismatch` error.

---

## Content validation primitives

Beyond heading matching, section-rules can validate the **content**
within a section.

### `table`

Validates a GFM table within the section's content nodes. Three layers
of constraint, each scoped to a different target:

| Layer | Where it lives | What it constrains |
|---|---|---|
| Table-level | `rows: {min,max}`, `strict: true` | The table as a whole — row count, undeclared headers |
| Column-level | `columns: [{name, required?}]` | Whether a header must appear |
| Cell-value-level | `columns: [{name, values: {...}}]` | Every cell in that column, row-by-row |

**Shorthand — required column headers only:**

```yaml section-rules
table:
  columns: [metric, target, actual]
```

Each string becomes `{name: <x>, required: true}`. Use this when the
only contract is "these headers exist."

**Expanded — per-column-cell rules:**

```yaml section-rules
table:
  columns:
    - name: title
      required: true            # header must exist (default true)
      values:                   # cell-value-level — applied to every row
        required: true          # cells non-empty
        pattern: "^[A-Z]"
        enum: [todo, doing, done]
        unique: true
        type: string
        min: 1                  # length min when type=string
        max: 100
    - name: priority
      values:
        enum: [must, should, nice]
  rows:
    min: 1                      # row-count cardinality
    max: 50
  strict: true                  # reject undeclared columns
```

Per-cell constraints run in a fixed order: presence → type → required
(non-empty) → enum → pattern → min/max → unique. Mixed `columns:`
arrays (a string and an object side-by-side) are rejected at template
load time.

Error types: `table-shape` (header / row-count / strict-mode),
`table-cell` (per-cell constraint).

### `list`

Validates a list within the section's content nodes. Like `table`, the
constraints split into list-level vs per-item:

```yaml section-rules
list:
  items:                      # per-item rules
    required: true            # item text non-empty
    pattern: "^\\*\\*[a-z_]+\\*\\* \\[.+\\]\\(.+\\)( — .+)?$"
    enum: [draft, in_progress, done]
  min: 1                      # list-level cardinality
  max: 10
  unique: true                # item-text uniqueness
```

Each violation is anchored at the offending item's own line — not the
list head — so editor squiggles land on the exact item.

Error types: `list-item`, `unique-violation`.

> **Migration from < 0.10.0** — the previous `list: { item: { pattern } }`
> form (no `s`) now produces a `template-schema-invalid` error with a
> `Did you mean 'items'?` suggestion. Rename `item:` to `items:`.

### `code`

Requires fenced code blocks within the section's content.

```yaml section-rules
code:
  lang: gherkin               # filter by language (case-insensitive)
  min: 1                      # default: at least one matching fence
  max: 3                      # default: no cap
  content:
    pattern: "^Scenario:"     # regex applied to each matching fence
```

- `lang` — when set, every constraint targets fences with this language
  tag. Without it, all fences are considered.
- `min` defaults to 1 (preserves the pre-0.10 "at least one fence
  required" behaviour). Set `min: 0` to make the fence optional.
- `content.pattern` produces one `code-content-mismatch` issue per
  failing fence, each anchored at its own fence line.

Error types: `code-missing` (cardinality), `code-content-mismatch`
(content.pattern).

### Formula primitive

An arithmetic / comparison expression evaluated against the document's
**frontmatter values**. Reference frontmatter field names directly in
the expression.

```yaml
# frontmatter
---
rice_reach: 8
rice_impact: 3
rice_confidence: 1
rice_effort: 4
---
```

```yaml section-rules
formula: "rice_reach * rice_impact * rice_confidence / rice_effort >= 5"
```

The expression language supports:

- Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`, `+`, `-`, `*`, `/`
- Parenthesized sub-expressions
- Unary minus
- Identifiers resolve from frontmatter (verbatim — no key
  normalisation)
- Equality (`==`, `!=`) uses epsilon `1e-9` for floating-point
  comparison

> **Migration from < 0.10.0** — formula previously consumed a key-value
> map extracted from a section's table via `table.key_column` /
> `table.value_column`. Those keys were removed; lift the dimensions
> into frontmatter and reference them directly.

A non-numeric or missing frontmatter value referenced in the
expression produces a `formula-violation` (the evaluator throws and
the primitive surfaces the throw verbatim).

Error type: `formula-violation`.

---

## Error types emitted by body validation

| Error type | Trigger |
|---|---|
| `required-missing` | A section with `required: true` (or conditional `required`) is missing from the document body |
| `heading-mismatch` | A heading's text doesn't match the declared `heading.pattern` or `heading.enum` |
| `table-shape` | A required table is missing, a required column header is missing, the row count falls outside `rows.min` / `rows.max`, or `strict: true` rejected an undeclared column |
| `table-cell` | A per-cell `values:` constraint (`required` / `pattern` / `enum` / `unique` / `type` / `min` / `max`) failed on at least one row |
| `list-item` | A required list is missing, or a list-level / per-item constraint failed (`items.pattern`, `items.enum`, `items.required`, `min`, `max`) |
| `unique-violation` | A list with `unique: true` (or a table column with `values.unique: true`) contains duplicates |
| `code-missing` | A required code fence is missing, no fence matches the required `lang`, or the fence count falls outside `min` / `max` |
| `code-content-mismatch` | A code fence's body does not match `content.pattern` |
| `formula-violation` | A formula expression evaluated to `false`, or evaluation threw because a referenced frontmatter value is missing / non-numeric |
| `cardinality` | A repeatable heading's match count is below `min` or above `max` |
| `template-schema-invalid` | The template's section-rules block itself is malformed (unknown key, bad regex, etc.). Carries a "Did you mean …?" suggestion when a known key is one or two edits away. |

---

## A complete example

````markdown
---
template_path: templates/prd-template.md
document_type: prd
tier: PRODUCT
sections:
  - problem
  - goals
  - acceptance-criteria
  - ship-timeline
  - outcome
  - "*"
  - relationships
fields:
  $path:
    pattern: "^docs/prds/prd-\\d{3}-[a-z0-9-]+\\.md$"
  template:
    required: true
  title:
    required: true
  status:
    type: string
    required: true
    enum: [draft, review, approved, shipped, dropped]
---

# PRD template

## Problem

```yaml section-rules
required: true
```

## Goals

```yaml section-rules
required: true
```

## Acceptance Criteria

```yaml section-rules
required: true
```

### <item>
```yaml section-rules
repeatable: true
heading:
  pattern: "^AC\\d+ — .+ — `(must|should|nice)` · `(draft|in_progress|verified|descoped)`$"
```

## Ship Timeline

```yaml section-rules
required: { when: "status in ['approved', 'shipped']" }
```

## Outcome

```yaml section-rules
required: false
```

## Relationships

```yaml section-rules
required: false
list:
  item:
    pattern: "^\\*\\*[a-z_]+\\*\\* \\[.+\\]\\(.+\\)( — .+)?$"
```
````

An instance that omits `## Problem` triggers a `required-missing`
error. An instance whose `## Acceptance Criteria` contains an H3 that
doesn't match the `heading.pattern` triggers a `heading-mismatch` error
at that heading's line.

## See also

- [Frontmatter rules](frontmatter-rules.md) — composable field
  primitives.
- [Folder & filename rules](folder-and-naming.md) — `$path` synthetic
  field, slug rules.
- [Full example](full-example.md) — end-to-end template + instance.
- [Canonical formatter](../canonical-formatter.md) — how `sections[]`
  drives reordering.
