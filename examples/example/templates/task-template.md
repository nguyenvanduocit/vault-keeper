---
template_path: templates/task-template.md
document_type: task
tier: ENGINEERING
sections:
  - intent
  - acceptance
  - "*"
  - relationships
fields:
  $path:
    pattern: "^docs/tasks/t-\\d{3}-[a-z0-9-]+\\.md$"
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
    enum: [todo, in_progress, blocked, done]
  estimate_hours:
    type: integer
    min: 1
---

# Task template

An implementation task tracked against one or more PRDs.

## Intent

```yaml section-rules
required: true
```

## Acceptance

```yaml section-rules
required: false
```

## Relationships

```yaml section-rules
required: false
```
