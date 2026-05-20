---
document_type: prd
title: PRD with no template field
owner: '@alice'
status: draft
created: '2026-05-01'
prd_type: enhancement
---

# PRD with no template field

Isolates `validateTemplateField` — the doc declares no `template:` key, so
the validator cannot look up any field schema and emits a single error
pointing at the missing identity field.
