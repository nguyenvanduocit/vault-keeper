---
template: templates/note-template.md
document_type: note
title: Hello Generic Vault
owner: '@alice'
---

# Hello Generic Vault

A conforming note that proves claude-code-vault-keeper scans a configured
`vaultRoot` of `docs` (not the built-in default `.`), and validates this doc
against THIS vault's own `templates/note-template.md`.

Run the validator from anywhere:

```bash
bun cli/validate-documents.js --root examples/minimal-vault --json
```

It resolves the project root to `examples/minimal-vault`, reads
`.claude/vault-keeper.json` (`vaultRoot: "docs"`), scans `docs/`, and reports
this file as valid (`valid: 1, errorCount: 0`). Two warnings are expected and
benign for a single-doc example: an orphan warning (empty `## Relationships`)
and a person-not-found warning (`@alice` — this example ships no
`product-data/people/` directory).

## Relationships
