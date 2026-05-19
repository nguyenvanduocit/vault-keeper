---
template: templates/prd-template.md
document_type: prd
status: ready_to_ship
owner: test@example.com
created: '2026-01-01T00:00:00+07:00'
updated: '2026-01-15T00:00:00+07:00'
---

# PRD: Test Feature (Ship Ready)

## Problem

Test problem description.

## Relationships

- **implements_bet** → [DIBB-001: Test DIBB](../../01-strategy/dibbs/dibb-001-test.md) — *bets on growth*

## Acceptance Criteria

### AC1 — Login must work — `must` · `verified`

> **Sign-off**: @qa-person · **Measurable**: yes

**Implemented by**:

- [t-001-impl](../../../03-engineering/tasks/t-001-impl.md) — coverage: full

**Verified by**:

- [t-002-test](../../../03-engineering/tasks/t-002-test.md) — verified 2026-01-10 by [@qa-person](../../../../product-data/people/qa-person.md) — method: manual

### AC2 — Dashboard loads — `must` · `verified`

> **Sign-off**: @qa-person · **Measurable**: yes

**Implemented by**:

- [t-001-impl](../../../03-engineering/tasks/t-001-impl.md) — coverage: full

**Verified by**:

- [t-002-test](../../../03-engineering/tasks/t-002-test.md) — verified 2026-01-11 by [@qa-person](../../../../product-data/people/qa-person.md) — method: automated

### AC3 — Nice to have feature — `should` · `verified`

**Implemented by**:

- [t-001-impl](../../../03-engineering/tasks/t-001-impl.md) — coverage: partial

## Contributions

- **qa** · @qa-person · 2026-01-10T08:00:00Z · sections: `acceptance criteria` · effort: `medium` · decision: `sign-off`

## Success Metric Verdict

### Primary

- **Metric**: Revenue match rate
- **Baseline**: 95%
- **Target**: 99%
- **Actual**: 99.2%
- **Verdict**: met
- **Decided by**: @pm
- **Decided at**: 2026-01-12T00:00:00Z

## Ship Timeline

**Target ship date**: 2026-01-20 · Locked at: 2026-01-15T10:00:00Z · Locked by: @owner
