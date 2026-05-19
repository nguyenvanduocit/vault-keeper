---
template: templates/decision-template.md
document_type: decision
title: Ratified ops decision with only one approver
owner: '@alice'
status: ratified
decision_type: ops
approvers:
  - '@alice'
decision_summary: >
  Move log aggregation from CloudWatch to Loki.
---

# Ratified ops decision with only one approver

Isolates `conditional_required_fields` with `min_count` — the template
requires `approvers` array to have ≥2 entries when `status in ['ratified']`.
This doc has 1.
