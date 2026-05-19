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
validation_rules:
  required_fields:
    - template
    - document_type
    - title
    - owner
    - status
    - created
  optional_fields:
    - tags
    - design_link
  conditional_required_fields:
    - condition: "status in ['approved', 'shipped']"
      field: shipped_date
      required: true
    - condition: "prd_type in ['feature']"
      field: rice
      required: true
    - condition: "status in ['shipped']"
      field: "body_section:## Outcome"
      required: true
  field_rules:
    - field: created
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: shipped_date
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: status
      values: [draft, review, approved, shipped, dropped]
    - field: prd_type
      values: [feature, enhancement, fix]
    - field: rice.reach
      type: integer
      min: 1
    - field: rice.confidence
      type: integer
      min: 1
  state_machine:
    draft:    [review, dropped]
    review:   [approved, draft]
    approved: [shipped, draft]
    shipped:  []
    dropped:  []
  path_regex: "^docs/prds/prd-\\d{3}-[a-z0-9-]+\\.md$"
  sections:
    - problem
    - goals
    - acceptance-criteria
    - ship-timeline
    - outcome
    - "*"
    - relationships
---

# PRD template

## Problem

```yaml section-rules
required: true
example: "Describe the user problem in 2-3 sentences."
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

## Outcome

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

This template declares **all five** rule kinds (required, conditional,
field, state machine, path_regex) plus body section-rules + an
explicit `sections[]` ordering.

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

Reduce checkout taps to ≤2 without losing payment-method coverage.

## Acceptance Criteria

### AC1 — User completes checkout in ≤2 taps — `must` · `verified`

(verification artifact link goes here)

### AC2 — All existing payment methods still work — `must` · `verified`

## Ship Timeline

| target_ship_date | locked_at  | locked_by |
|------------------|------------|-----------|
| 2026-06-01       | 2026-05-15 | @alice    |

## Outcome

Tap count median dropped from 4 → 2. Conversion +3.1%.

## Relationships

- [DIBB-005 — Growth bets](../strategy/dibbs/dibb-005.md) — *implements bet 2*
````

This passes every rule:

| Rule | Status |
|---|---|
| `required_fields` (6 keys) | ✅ all present |
| `conditional_required_fields` (`status: approved` → `shipped_date`) | ✅ present |
| `conditional_required_fields` (`prd_type: feature` → `rice`) | ✅ present |
| `field_rules.regex` (`created`) | ✅ matches `YYYY-MM-DD` |
| `field_rules.values` (`status`) | ✅ `approved` is permitted |
| `field_rules.type integer` + `min` (`rice.reach`, `rice.confidence`) | ✅ both ≥ 1 |
| `state_machine` (`approved`) | ✅ declared node |
| `path_regex` | ✅ matches `prd-001-checkout-redesign.md` |
| Body section-rules (`required: true` on `## Problem`, `## Goals`, `## Acceptance Criteria`) | ✅ all H2s present |

Expected validator output:

```bash
$ bun cli/validate-documents.js --root . --json | jq '.summary'
{
  "total": 1,
  "skipped": 0,
  "valid": 1,
  "invalid": 0,
  "errorCount": 0,
  "warningCount": 0,
  ...
}
```

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
validation_rules:
  required_fields: [hijacked]
---

# Broken example

## Acceptance Criteria

### AC1 - missing dashes
````

Diagnostics this would generate (against the template above):

```
[ERR ]  field=created
        Value 'not-a-date' fails regex ^\d{4}-\d{2}-\d{2}$
        fix: Field created must match ^\d{4}-\d{2}-\d{2}$

[WARN]  field=status
        Status 'shippping' is not declared in template state_machine
        fix: Use one of: draft, review, approved, shipped, dropped

[ERR ]  field=rice
        Required when prd_type in ['feature']
        fix: Add rice to frontmatter

[WARN]  field=validation_rules
        Template-only field "validation_rules" leaked into instance from
        template scaffold
        fix: Remove "validation_rules:" from frontmatter — it belongs to
        templates/ only

[WARN]  field=body
        AC heading does not match expected format:
        `### AC<n>[.<m>] — <text> — \`<priority>\` · \`<status>\` [(flag)]`
        fix: Fix the format to match the expected pattern shown in the message
```

(`## Problem` and `## Goals` are required body sections per the
section-rules — the validator's body-section enforcement runs only when
they're declared via a `body_section:` conditional. For a hard "this
section MUST appear" check at the body-rules level, use the conditional
`body_section:` prefix in `conditional_required_fields` — see
[frontmatter-rules](frontmatter-rules.md#body_section-prefix-conditional-body-sections).)

## What the LSP sees

Open `prd-002-broken-example.md` in an editor with the LSP:

- A red squiggle under `created: not-a-date` (the regex error).
- A yellow squiggle under `status: shippping` (state-machine warning).
- A red squiggle on the `validation_rules:` line (template-only leak).
- The `## Acceptance Criteria` H2 carries an inlay hint:
  `(implementing: 0, verified by: 0)`.
- The `template:` line carries a code-lens action: `↗ 0 backlinks · ⬆ 1
  acceptance criteria · ⏱ updated 0d ago`.

A code-action quick-fix for the `validation_rules:` warning offers
"Delete from frontmatter". A code-action for a "Missing required field"
diagnostic on `rice` offers "Insert placeholder".

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
