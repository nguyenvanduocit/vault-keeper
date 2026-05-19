---
template_path: templates/note-template.md
document_type: note
validation_rules:
  tier: KNOWLEDGE
  required_fields:
    - template
    - document_type
    - title
    - owner
  path_regex: "^docs/notes/note-\\d{3}-[a-z0-9-]+\\.md$"
---

# Note template

The simplest possible vault artifact: identity + a body. No state machine, no
conditional rules, no body section requirements. Use this template for
free-form knowledge captures.

```yaml section-rules
relationships:
  required: false
```

## Relationships
