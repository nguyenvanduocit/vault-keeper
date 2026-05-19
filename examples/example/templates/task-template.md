---
template_path: templates/task-template.md
document_type: task
validation_rules:
  tier: ENGINEERING
  required_fields:
    - template
    - document_type
    - title
    - owner
    - status
  field_rules:
    - field: status
      values: [todo, in_progress, blocked, done]
    - field: estimate_hours
      type: integer
      min: 1
  state_machine:
    todo: [in_progress, blocked]
    in_progress: [blocked, done]
    blocked: [in_progress, done]
    done: []
  path_regex: "^docs/tasks/t-\\d{3}-[a-z0-9-]+\\.md$"
  sections:
    - intent
    - acceptance
    - "*"
    - relationships
---

# Task template

An implementation task tracked against one or more PRDs.

## Intent

```yaml section-rules
required: true
example: "One sentence describing what this task changes."
```

## Acceptance

```yaml section-rules
required: false
```

## Relationships

```yaml section-rules
required: false
```
