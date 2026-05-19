---
template: templates/prd-template.md
document_type: prd
title: Approved PRD missing Ship Timeline body section
owner: '@alice'
status: approved
created: '2026-04-01'
prd_type: enhancement
shipped_date: '2026-06-01'
---

# Approved PRD missing Ship Timeline body section

Isolates `conditional_required_fields` with the `body_section:` prefix —
the template declares `## Ship Timeline` required when
`status in ['approved', 'shipped']`. This doc has the frontmatter half
(`shipped_date`) but omits the body section.
