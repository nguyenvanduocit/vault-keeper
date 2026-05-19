---
template: templates/this-template-does-not-exist.md
document_type: prd
title: PRD pointing at a nonexistent template
owner: '@alice'
status: draft
created: '2026-05-01'
prd_type: enhancement
---

# PRD pointing at a nonexistent template

Isolates the template-resolution failure path — `template:` resolves to a
file that doesn't exist. `loadTemplateRules` returns `null`; the validator
synthesizes a "Cannot load validation_rules from template '<path>'…" error
so the author sees the problem instead of silent schema-less validation.
