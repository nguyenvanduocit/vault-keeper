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

A Product Requirements Document. Demonstrates the composable field schema
and body section-rules the plugin enforces.

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
