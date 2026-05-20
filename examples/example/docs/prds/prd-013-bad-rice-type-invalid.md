---
template: templates/prd-template.md
document_type: prd
title: PRD with non-integer rice reach
owner: '@alice'
status: draft
created: '2026-05-01'
prd_type: feature
rice:
  reach: fifty
  impact: 3
  confidence: 80
  effort: 4
---

# PRD with non-integer rice reach

Isolates `type: integer` enforcement — the template declares
`rice.reach: type: integer`. This doc supplies the string `'fifty'`. The
validator emits a "Expected integer" error, separate from the `min` check
exercised by `prd-008-bad-rice-reach-invalid.md`.

## Problem

Placeholder for required section.

## Goals

Placeholder for required section.

## Acceptance Criteria

Placeholder for required section.
