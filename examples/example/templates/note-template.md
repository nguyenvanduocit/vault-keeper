---
template_path: templates/note-template.md
document_type: note
tier: KNOWLEDGE
fields:
  $path:
    pattern: "^docs/notes/note-\\d{3}-[a-z0-9-]+\\.md$"
  template:
    required: true
  document_type:
    required: true
  title:
    required: true
  owner:
    required: true
---

# Note template

The simplest possible vault artifact: identity + a body. No state machine, no
conditional rules, no body section requirements. Use this template for
free-form knowledge captures.

## Relationships

```yaml section-rules
required: false
```
