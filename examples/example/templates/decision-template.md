---
template_path: templates/decision-template.md
document_type: decision
validation_rules:
  tier: STRATEGY
  required_fields:
    - template
    - document_type
    - title
    - owner
    - status
    - decision_type
  conditional_required_fields:
    # Compound AND — both clauses must match
    - condition: "status in ['ratified'] and decision_type in ['architecture']"
      field: adr_link
      required: true
    # min_count — `approvers` must be an array with ≥2 entries when ratified
    - condition: "status in ['ratified']"
      field: approvers
      min_count: 2
    # severity: warning — recommended-not-required when status is draft
    - condition: "status in ['draft']"
      field: due_date
      required: true
      severity: warning
    # `not in` DSL — fires for every non-draft status
    - condition: "status not in ['draft']"
      field: decision_summary
      required: true
  field_rules:
    - field: decision_type
      values: [architecture, product, ops]
    - field: status
      values: [draft, review, ratified, superseded, rescinded]
  state_machine:
    draft: [review, rescinded]
    review: [ratified, draft, rescinded]
    ratified: [superseded]
    superseded: []
    rescinded: []
  path_regex: "^docs/decisions/d-\\d{3}-[a-z0-9-]+\\.md$"
  sections:
    - context
    - decision
    - consequences
    - "*"
    - relationships
---

# Decision template

A decision record. Exercises four `conditional_required_fields` shapes the
PRD template does not: **compound DSL with `and`**, **`not in` DSL**,
**`min_count`**, and **`severity: warning`**.

## Context

```yaml section-rules
required: true
example: "What forces are at play? Why is this decision being made now?"
```

## Decision

```yaml section-rules
required: true
example: "The chosen option, stated affirmatively."
```

## Consequences

```yaml section-rules
required: false
```

## Relationships
