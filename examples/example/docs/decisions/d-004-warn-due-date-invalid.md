---
template: templates/decision-template.md
document_type: decision
title: Draft decision with no due_date
owner: '@alice'
status: draft
decision_type: product
---

# Draft decision with no due_date

Isolates conditional `when` gate with `severity: warning` — the template
recommends `due_date` for draft decisions but does NOT make it a hard
error. The validator emits a WARNING (not an error), so this doc still
counts as `valid: true` in `summary.valid` but contributes 1 to
`warningCount`.

## Context

Placeholder for required section.

## Decision

Placeholder for required section.
