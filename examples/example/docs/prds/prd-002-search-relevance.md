---
template: templates/prd-template.md
document_type: prd
title: Search relevance tuning
owner: '@bob'
status: draft
created: '2026-05-10'
prd_type: enhancement
priority: should
tags: [search]
---

# Search relevance tuning

A draft PRD — exercises the `state_machine` graph at its initial node and
demonstrates that `conditional_required_fields` only fire when their
condition matches (no `shipped_date`, no `rice`, no `## Ship Timeline`
section required while `status: draft`).

## Problem

Top-of-funnel queries return 30% empty results. Users bail before scrolling.

## Goals

Cut empty-result rate to <5% via better tokenization and synonym handling.

## Acceptance Criteria

### AC1 — Empty-result rate <5% — `must` · `draft`

Measured over a 7-day rolling window on the production index.

## Relationships

- [note-001-onboarding](../notes/note-001-onboarding.md) — *related context*
