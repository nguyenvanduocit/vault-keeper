---
template: templates/decision-template.md
document_type: decision
title: Split monolith into checkout + catalog services
owner: '@alice'
status: ratified
decision_type: architecture
adr_link: 'https://example.com/adr/0001-checkout-split'
approvers:
  - '@alice'
  - '@bob'
  - '@carol'
decision_summary: >
  Two services with separate write paths, shared read replica for analytics.
---

# Split monolith into checkout + catalog services

A fully valid decision — exercises every conditional in the decision
template at once: compound `and` (status=ratified + decision_type=architecture
→ `adr_link` required), `min_count: 2` on `approvers`, `not in ['draft']` →
`decision_summary` required.

## Context

The monolith's deploy cadence is bottlenecked by checkout's release gate.

## Decision

Split into two services with their own deploy pipelines.

## Consequences

Cross-service contract testing becomes mandatory.
