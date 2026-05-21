---
template_path: templates/spec-template.md
document_type: spec
tier: ENGINEERING
sections:
  - diagram
  - behavior
  - "*"
fields:
  $path:
    pattern: "^docs/specs/spec-\\d{3}-[a-z0-9-]+\\.md$"
  template:
    required: true
  document_type:
    required: true
  title:
    required: true
  owner:
    required: true
---

# Spec template

A small technical spec that demonstrates parser-backed fenced-code validators.

## Diagram

```yaml section-rules
required: true
mermaid:
  min: 1
```

## Behavior

```yaml section-rules
required: true
gherkin:
  min: 1
```
