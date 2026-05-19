---
template: templates/prd-template.md
document_type: prd
title: Checkout redesign
owner: '@alice'
status: approved
created: '2026-04-01'
prd_type: feature
priority: must
rice:
  reach: 50
  impact: 3
  confidence: 80
  effort: 5
shipped_date: '2026-06-01'
tags: [checkout, conversion]
---

# Checkout redesign

## Problem

Today's checkout takes four taps; the funnel drops 28% between cart and
payment. The 2-tap competitor experience is closing six-figure deals we
otherwise win.

## Goals

Reduce checkout to ≤2 taps without sacrificing payment-method coverage.

## Acceptance Criteria

### AC1 — User completes checkout in ≤2 taps — `must` · `verified`

Cross-browser median tap count ≤2 over the rollout cohort.

### AC2 — All existing payment methods still work — `must` · `verified`

No regression in Apple Pay, Google Pay, card, or BNPL paths.

## Ship Timeline

| target_ship_date | locked_at  | locked_by |
|------------------|------------|-----------|
| 2026-06-01       | 2026-05-15 | @alice    |

## Outcome

Median tap count dropped 4 → 2. Conversion +3.1% over the four-week rollout.

## Relationships

- [t-001-impl-checkout](../tasks/t-001-impl-checkout.md) — *implements AC1 & AC2*
- [t-002-verify-checkout](../tasks/t-002-verify-checkout.md) — *verifies AC1 & AC2*
