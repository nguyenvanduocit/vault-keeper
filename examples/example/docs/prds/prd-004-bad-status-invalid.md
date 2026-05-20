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

Isolates `enum` enforcement — `shippping` (typo) is not a declared
value in the template's `status` field schema. The validator emits a WARNING
(not an error) because enum drift is recoverable.

## Problem

Placeholder for required section.

## Goals

Placeholder for required section.

## Acceptance Criteria

Placeholder for required section.
