---
template: templates/prd-template.md
document_type: prd
title: PRD with unknown status
owner: '@alice'
status: shippping
created: '2026-05-01'
prd_type: enhancement
---

# PRD with unknown status

Isolates `state_machine` enforcement — `shippping` (typo) is not a declared
node in the template's state graph. The validator emits a WARNING (not an
error) because state-machine drift is recoverable.
