---
template_path: templates/note-template.md
document_type: note
validation_rules:
  tier: KNOWLEDGE
  required_fields: [template, document_type, title, owner]
  allowed_folders: "^docs/notes/"
---

# Note Template

A note is the simplest possible vault artifact: it just needs an identity
(`template`, `document_type`, `title`, `owner`) and a `## Relationships`
section. This single template is the entire per-vault contract for the
`examples/minimal-vault` adoption reference — claude-code-vault-keeper ships
NO templates of its own; every consuming vault supplies its own `templates/`
with `validation_rules`.

```yaml section-rules
relationships:
  required: false
```

## Relationships
