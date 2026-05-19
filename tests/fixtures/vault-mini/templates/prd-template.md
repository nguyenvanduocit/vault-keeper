---
template_path: templates/prd-template.md
document_type: prd
validation_rules:
  required_fields: [template, document_type, status, owner]
  field_rules:
    - field: created
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: status
      values: [draft, review, approved, shipped, deprecated]
  allowed_folders: "^product-knowledge/02-product/prds/(?:\\d{4}-\\d{2}-\\d{2}-)?prd-\\d{3}-[a-z0-9-]+\\.md$"
  conditional_required_fields:
    - condition: "prd_type in ['feature', 'enhancement']"
      field: "body_section:## Ship Timeline"
      required: true
---

# PRD Template

A minimal fixture template — declares enough `validation_rules` for the smoke
test to exercise field-regex enforcement (`created` must be `YYYY-MM-DD`) and
conditional-required body sections (`## Ship Timeline` when prd_type is a
feature or enhancement).

```yaml section-rules
relationships:
  required: false
```

## Relationships
