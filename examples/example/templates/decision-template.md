---
template_path: templates/decision-template.md
document_type: decision
tier: STRATEGY
sections:
  - context
  - decision
  - consequences
  - "*"
  - relationships
fields:
  $path:
    pattern: "^docs/decisions/d-\\d{3}-[a-z0-9-]+\\.md$"
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
    enum: [draft, review, ratified, superseded, rescinded]
  decision_type:
    type: string
    required: true
    enum: [architecture, product, ops]
  adr_link:
    required: { when: "status in ['ratified'] and decision_type in ['architecture']" }
  approvers:
    type: array
    min: { value: 2, when: "status in ['ratified']" }
  due_date:
    required: { value: true, when: "status in ['draft']", severity: warning }
  decision_summary:
    required: { when: "status not in ['draft']" }
---

# Decision template

A decision record. Exercises four conditional-required shapes the PRD template
does not: **compound DSL with `and`**, **`not in` DSL**, **`min` on array**,
and **`severity: warning`**.

## Context

```yaml section-rules
required: true
```

## Decision

```yaml section-rules
required: true
```

## Consequences

```yaml section-rules
required: false
```

## Relationships
