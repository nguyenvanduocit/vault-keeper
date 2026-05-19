---
template: templates/task-template.md
document_type: task
title: Implement 2-tap checkout flow
owner: '@carol'
status: done
estimate_hours: 24
---

# Implement 2-tap checkout flow

## Intent

Collapse address + payment-method selection into a single sheet with
sensible defaults.

## Acceptance

- All existing test suites pass.
- New e2e covers Apple Pay, Google Pay, card, BNPL.

## Relationships

- [prd-001-checkout-redesign](../prds/prd-001-checkout-redesign.md) — *implements*
