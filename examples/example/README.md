# Example vault — fixture map

This directory is a **self-contained reference vault** and the **canonical
test dataset** for `claude-code-vault-keeper`. Every rule kind a template
can declare is exercised by at least one fixture, and a coverage assertion
in `tests/example-vault.test.js` fails if a new validator diagnostic ships
without a matching fixture here.

Conventions:

- Filenames ending in `-invalid.md` are **deliberately broken** and trip
  exactly one diagnostic kind each (a few have two when filename + path
  rules overlap — see `docs/assets/Bad_Asset.json`).
- Filenames without that suffix **must validate clean** — they double as
  authoring examples readers can copy from.
- `tests/example-vault.expectations.json` declares the expected diagnostic
  field-code for every fixture. The test enforces both the per-fixture
  expectation and aggregate summary numbers.

## Templates

| Template | Showcases |
|---|---|
| [`templates/prd-template.md`](templates/prd-template.md) | The full rule catalog: `required_fields`, `optional_fields`, `conditional_required_fields` (frontmatter + `body_section:`), `field_rules` (regex / values / type / min), `state_machine`, `path_regex`, `sections`, body section-rules code fences. |
| [`templates/task-template.md`](templates/task-template.md) | A mid-density template — engineering tasks linked to PRDs. |
| [`templates/note-template.md`](templates/note-template.md) | The minimum viable template — identity-only required fields, one path_regex, no conditional rules. |
| [`templates/decision-template.md`](templates/decision-template.md) | Advanced recipe surface: **compound DSL with `and`**, **DSL `not in`**, **`min_count`** on arrays, **`severity: warning`** override. |

## Fixture map — diagnostics demonstrated

### Valid fixtures (5)

| File | Demonstrates |
|---|---|
| [`docs/prds/prd-001-checkout-redesign.md`](docs/prds/prd-001-checkout-redesign.md) | Approved-feature PRD with every conditional satisfied (rice, shipped_date, `## Ship Timeline`) |
| [`docs/prds/prd-002-search-relevance.md`](docs/prds/prd-002-search-relevance.md) | Draft PRD — conditional rules quietly skip when their condition is false |
| [`docs/tasks/t-001-impl-checkout.md`](docs/tasks/t-001-impl-checkout.md) | Done task linked to PRD-001 |
| [`docs/tasks/t-002-verify-checkout.md`](docs/tasks/t-002-verify-checkout.md) | Done verification task linked to PRD-001 |
| [`docs/notes/note-001-onboarding.md`](docs/notes/note-001-onboarding.md) | Free-form note against the minimal template |
| [`docs/decisions/d-001-microservice-split.md`](docs/decisions/d-001-microservice-split.md) | Ratified architecture decision — every advanced conditional satisfied at once |

### Invalid fixtures (15) — one violation per file

| File | Diagnostic kind | Field code |
|---|---|---|
| [`docs/prds/prd-003-bad-date-invalid.md`](docs/prds/prd-003-bad-date-invalid.md) | `field_rules.regex` failure | `created` |
| [`docs/prds/prd-004-bad-status-invalid.md`](docs/prds/prd-004-bad-status-invalid.md) | `state_machine` unknown-status **warning** | `status` |
| [`docs/prds/prd-005-missing-rice-invalid.md`](docs/prds/prd-005-missing-rice-invalid.md) | `conditional_required_fields` (frontmatter, `required:true`) | `rice` |
| [`docs/prds/prd-006-missing-shipped-date-invalid.md`](docs/prds/prd-006-missing-shipped-date-invalid.md) | `conditional_required_fields` (frontmatter, `required:true`) | `shipped_date` |
| [`docs/prds/prd-007-missing-ship-section-invalid.md`](docs/prds/prd-007-missing-ship-section-invalid.md) | `conditional_required_fields` (`body_section:`) | `body_section:## Ship Timeline` |
| [`docs/prds/prd-008-bad-rice-reach-invalid.md`](docs/prds/prd-008-bad-rice-reach-invalid.md) | `field_rules.min` violation | `rice.reach` |
| [`docs/prds/prd-009-bad-priority-invalid.md`](docs/prds/prd-009-bad-priority-invalid.md) | `field_rules.values` (enum) violation | `priority` |
| [`docs/prds/prd-010-leaked-rules-invalid.md`](docs/prds/prd-010-leaked-rules-invalid.md) | template-meta-leak **warning** | `validation_rules` |
| [`docs/prds/prd-bad-name-invalid.md`](docs/prds/prd-bad-name-invalid.md) | `path_regex` mismatch | `location` |
| [`docs/prds/prd-011-missing-template-invalid.md`](docs/prds/prd-011-missing-template-invalid.md) | Doc has no `template:` key | `template` |
| [`docs/prds/prd-012-broken-link-invalid.md`](docs/prds/prd-012-broken-link-invalid.md) | Broken `frontmatter.relationships` link | `relationships.implements_bet` |
| [`docs/prds/prd-013-bad-rice-type-invalid.md`](docs/prds/prd-013-bad-rice-type-invalid.md) | `field_rules.type: integer` violation | `rice.reach` |
| [`docs/prds/prd-014-missing-template-file-invalid.md`](docs/prds/prd-014-missing-template-file-invalid.md) | `template:` points at nonexistent file | `template` |
| [`docs/tasks/t-003-missing-owner-invalid.md`](docs/tasks/t-003-missing-owner-invalid.md) | `required_fields` missing | `owner` |
| [`docs/decisions/d-002-not-enough-approvers-invalid.md`](docs/decisions/d-002-not-enough-approvers-invalid.md) | Conditional `min_count` violation | `approvers` |
| [`docs/decisions/d-003-missing-summary-invalid.md`](docs/decisions/d-003-missing-summary-invalid.md) | Conditional with DSL `not in` | `decision_summary` |
| [`docs/decisions/d-004-warn-due-date-invalid.md`](docs/decisions/d-004-warn-due-date-invalid.md) | Conditional `severity: warning` | `due_date` |
| [`docs/assets/Bad_Asset.json`](docs/assets/Bad_Asset.json) | Asset filename slug violation | `filename` |

## Running

From the repo root:

```bash
# Validate the whole example vault — exits 1 (invalid fixtures present)
bun cli/validate-documents.js --root examples/example --json | jq '.summary'

# Run the example-as-test-dataset assertion suite
bun test tests/example-vault.test.js

# LSP smoke against this vault (uses server/main.bundled.cjs)
node examples/example/smoke.js
```

## Adding a fixture

1. Add the markdown file under `docs/<bucket>/` with `-invalid.md` suffix
   if it should trip a diagnostic (otherwise no suffix).
2. Add an entry in `tests/example-vault.expectations.json` declaring the
   expected `valid`, `errors[]`, `warnings[]`.
3. Run `bun test tests/example-vault.test.js` — both the per-fixture and
   the coverage assertion (in the same file) must pass.

If the fixture exercises a **new** diagnostic kind not yet covered, also
add a matcher to `DIAGNOSTIC_KINDS` in `tests/example-vault.test.js`.

## Out of scope

A small set of validator paths are intentionally not exercised here —
they require artificial template shapes that obscure the example:

- `path-regex-bad-regex` (template ships an unparseable regex)
- `bundle-readme-template-mismatch` (bundle README pattern)
- "Failed to parse" frontmatter (parser-level error, no `field` code)

See the comment in `tests/example-vault.test.js:DIAGNOSTIC_KINDS` for the
authoritative list of skipped kinds.
