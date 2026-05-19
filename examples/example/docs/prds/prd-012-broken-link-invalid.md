---
template: templates/prd-template.md
document_type: prd
title: PRD with broken frontmatter relationship
owner: '@alice'
status: draft
created: '2026-05-01'
prd_type: enhancement
relationships:
  implements_bet:
    - path: 'docs/strategy/this-doc-does-not-exist.md'
      title: 'Ghost DIBB'
---

# PRD with broken frontmatter relationship

Isolates `validateLinkExistence` — the legacy `frontmatter.relationships`
surface points at a file that does not exist on disk. The validator emits a
broken-link error per dangling edge.
