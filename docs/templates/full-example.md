# Full template + instance example

End-to-end walkthrough: a PRD-style template, a conforming instance, and
a broken instance with the diagnostics the validator emits.

This walkthrough mirrors the bundled [`examples/example/`](../../examples/example)
vault, which exercises every rule kind so you can see how they compose. The
example also doubles as the plugin's test dataset — see
`tests/example-vault.expectations.json` for the per-doc diagnostic
expectations.

## Layout

```
my-vault/
├── .claude/
│   └── vault-keeper.json
├── templates/
│   └── prd-template.md
└── docs/
    └── prds/
        ├── prd-001-checkout-redesign.md           # conforming
        └── prd-002-broken-example.md              # broken (used below)
```

## `vault-keeper.json`

```json
{
  "vaultRoot": "docs",
  "vaultFolders": ["docs"]
}
```

## `templates/prd-template.md`

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
  document_type:
    required: true
  title:
    required: true
  owner:
    required: true
  status:
    type: string
    required: true
    enum: [draft, review, approved, shipped, dropped]
  created:
    type: string
    required: true
    pattern: "^\\d{4}-\\d{2}-\\d{2}$"
  tags:
    type: array
  design_link:
    type: string
  shipped_date:
    type: string
    required: { when: "status in ['approved', 'shipped']" }
    pattern: "^\\d{4}-\\d{2}-\\d{2}$"
  prd_type:
    type: string
    enum: [feature, enhancement, fix]
  priority:
    type: string
    enum: [must, should, nice]
  rice:
    required: { when: "prd_type in ['feature']" }
  rice.reach:
    type: integer
    min: 1
  rice.confidence:
    type: integer
    min: 1
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
  items:
    pattern: "^\\*\\*[a-z_]+\\*\\* \\[.+\\]\\(.+\\)( — .+)?$"
```
````

This template declares composable field primitives (`type`, `enum`,
`pattern`, `required` with `when`, `min`) on frontmatter fields, a
`$path` synthetic field for filesystem placement, and body section-rules
with a repeatable AC heading pattern, a conditional body section, and
a relationship list format constraint.

## A conforming instance

`docs/prds/prd-001-checkout-redesign.md`:

````markdown
---
template: templates/prd-template.md
document_type: prd
title: Checkout redesign
owner: '@alice'
status: approved
created: 2026-05-01
prd_type: feature
rice:
  reach: 50
  impact: 3
  confidence: 80
  effort: 5
shipped_date: 2026-06-01
---

## Problem

Today's checkout takes 4 taps; users abandon after 2.

## Goals

Reduce checkout taps to <=2 without losing payment-method coverage.

## Acceptance Criteria

### AC1 — User completes checkout in <=2 taps — `must` · `verified`

(verification artifact link goes here)

### AC2 — All existing payment methods still work — `must` · `verified`

## Ship Timeline

| target_ship_date | locked_at  | locked_by |
|------------------|------------|-----------|
| 2026-06-01       | 2026-05-15 | @alice    |

## Outcome

Tap count median dropped from 4 to 2. Conversion +3.1%.

## Relationships

- **implements** [DIBB-005 — Growth bets](../strategy/dibbs/dibb-005.md) — *implements bet 2*
````

This passes every rule:

| Rule | Status |
|---|---|
| `fields.template` (required) | present |
| `fields.status` (required + enum) | `approved` is permitted |
| `fields.created` (required + pattern) | matches `YYYY-MM-DD` |
| `fields.shipped_date` (conditional required, `when: status in [approved, shipped]`) | present |
| `fields.rice` (conditional required, `when: prd_type in [feature]`) | present |
| `fields.rice.reach` (type integer + min 1) | `50` >= 1 |
| `fields.$path` (pattern) | matches `prd-001-checkout-redesign.md` |
| Body `## Problem` (required: true) | present |
| Body `## Goals` (required: true) | present |
| Body `## Acceptance Criteria` (required: true) | present |
| Body AC headings (repeatable, heading.pattern) | both match |
| Body `## Relationships` list (item.pattern) | all items match |

## A broken instance

`docs/prds/prd-002-broken-example.md`:

````markdown
---
template: templates/prd-template.md
document_type: prd
title: Broken example
owner: '@alice'
status: shippping
created: not-a-date
prd_type: feature
---

# Broken example

## Acceptance Criteria

### AC1 - missing dashes
````

Diagnostics this would generate:

```
[ERR ]  field=created         error_type=pattern-mismatch
        Value 'not-a-date' does not match pattern '^\d{4}-\d{2}-\d{2}$'
        fix: Must match: ^\d{4}-\d{2}-\d{2}$

[ERR ]  field=status          error_type=enum-violation
        Value 'shippping' is not in allowed values: [draft, review, approved, shipped, dropped]
        fix: Use one of: draft, review, approved, shipped, dropped

[ERR ]  field=rice            error_type=required-missing
        Required field 'rice' is missing
        fix: Add 'rice' to frontmatter

[ERR ]  field=## Problem      error_type=required-missing
        Required section '## Problem' is missing

[ERR ]  field=## Goals        error_type=required-missing
        Required section '## Goals' is missing

[ERR ]  field=### <item>      error_type=heading-mismatch
        Heading 'AC1 - missing dashes' does not match pattern
        '^AC\d+ — .+ — `(must|should|nice)` · `(draft|in_progress|verified|descoped)`$'
```

## What the LSP sees

Open `prd-002-broken-example.md` in an editor with the LSP:

- A red squiggle under `created: not-a-date` (the pattern-mismatch).
- A red squiggle under `status: shippping` (the enum-violation).
- A red squiggle on missing `rice` field (required-missing).
- The `template:` line carries a code-lens action:
  `↗ 0 backlinks · ⏱ updated Xd ago`.

A code-action quick-fix for a "Missing required field" diagnostic
offers "Insert placeholder".

## What this example does NOT cover

- **Cross-document orphan detection** — the CLI builds an incoming-link
  graph and warns on documents with neither incoming nor outgoing
  links. To exercise it you'd need at least two interlinked docs.
- **Bundle README form** — see
  [folder-and-naming](folder-and-naming.md#bundle-readme-pattern) for
  the `<id>/README.md` pattern.
- **Asset slug pass** — the CLI also slug-checks non-markdown files
  (PNG, JSON, etc.). The walkthrough above is all `.md`.
- **LSP rename / format-on-save** — covered in
  [lsp-features](../lsp-features.md).

## See also

- [Frontmatter rules](frontmatter-rules.md)
- [Folder & filename rules](folder-and-naming.md)
- [Body rules](body-rules.md)
- [CLI validator](../cli-validator.md)
- [LSP features](../lsp-features.md)
