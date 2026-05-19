---
template_path: templates/prd-template.md
document_type: prd
validation_rules:
  tier: PRODUCT
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
    - condition: "status in ['approved', 'shipped']"
      field: "body_section:## Ship Timeline"
      required: true
  field_rules:
    - field: created
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: shipped_date
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: prd_type
      values: [feature, enhancement, fix]
    - field: priority
      values: [must, should, nice]
    - field: rice.reach
      type: integer
      min: 1
    - field: rice.confidence
      type: integer
      min: 1
  state_machine:
    draft: [review, dropped]
    review: [approved, draft]
    approved: [shipped, draft]
    shipped: []
    dropped: []
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

A Product Requirements Document. Demonstrates every `validation_rules` field
the plugin enforces:

- `required_fields` (frontmatter shape)
- `optional_fields` (informational only)
- `conditional_required_fields` (frontmatter + `body_section:` variants)
- `field_rules` (`regex`, `values`, `type: integer`, `min`)
- `state_machine` (warns on unknown status)
- `path_regex` (file location enforcement)
- `sections[]` (canonical body ordering for the formatter)

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
example: "- [t-001-impl](../tasks/t-001-impl.md) — *implements AC1*"
```
