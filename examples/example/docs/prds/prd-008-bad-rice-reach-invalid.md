---
template: templates/prd-template.md
document_type: prd
title: PRD with sub-minimum rice reach
owner: '@alice'
status: draft
created: '2026-05-01'
prd_type: feature
rice:
  reach: 0
  impact: 2
  confidence: 70
  effort: 3
---

# PRD with sub-minimum rice reach

Isolates `field_rules.min` enforcement — the template declares
`rice.reach: type: integer, min: 1`. This doc sets `rice.reach: 0`.
