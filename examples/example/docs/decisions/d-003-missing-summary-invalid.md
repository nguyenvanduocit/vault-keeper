---
template: templates/decision-template.md
document_type: decision
title: Reviewed decision missing decision_summary
owner: '@alice'
status: review
decision_type: ops
---

# Reviewed decision missing decision_summary

Isolates `conditional_required_fields` with `not in` DSL — the template
declares `decision_summary` required when `status not in ['draft']`. This
doc is in `review` (not `draft`) and omits `decision_summary`.
