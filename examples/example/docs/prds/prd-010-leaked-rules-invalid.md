---
template: templates/prd-template.md
document_type: prd
title: PRD with leaked validation_rules block
owner: '@alice'
status: draft
created: '2026-05-01'
prd_type: enhancement
validation_rules:
  required_fields: [hijacked]
---

# PRD with leaked validation_rules block

Isolates the template-only-field-leak detector — `validation_rules:` is a
template-only key. When it appears in an instance, the validator emits a
WARNING ("Template-only field leaked into instance from template scaffold").
