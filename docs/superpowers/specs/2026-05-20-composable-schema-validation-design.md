# Composable Schema Validation — Design Spec

- **Date:** 2026-05-20
- **Status:** Approved (brainstorming) — pending implementation plan
- **Topic:** Replace the ad-hoc `validation_rules` frontmatter block AND the
  hardcoded body-parser section logic with one composable, template-driven
  schema system that covers both frontmatter and body from a single shared
  registry of rule primitives.

---

## 1. Problem

### Frontmatter

`validation_rules` is not a schema — it is ~12 named sub-blocks
(`required_fields`, `field_rules`, `conditional_required_fields`,
`state_machine`, `path_regex`, `sections`, `optional_fields`, …), each with a
bespoke structure and its own enforcement branch in `applyRules`
(`lib/validators.js:207-365`).

- Adding a new *kind* of constraint means adding a code branch — the plugin's
  own `CLAUDE.md` Rule 2 ("add a template field, not a code branch") is
  violated by the schema language itself.
- No closed, composable vocabulary.
- No meta-schema → the template itself is never validated. A malformed
  `field_rules` entry throws an uncaught exception that aborts the whole CLI
  run and silently kills LSP diagnostics. PoC-verified:
  - bad `field_rules.regex` → `Validation failed: Invalid regular expression`
  - `field_rules.values: 123` → `Validation failed: rule.values.includes is not a function`
- `state_machine` only warns when `status` is not a declared key — an `enum`
  in disguise.

### Body

`lib/body-parser.js` (~1327 lines) hardcodes **12 section types**
(`SECTION_HANDLERS` — `acceptance criteria`, `rice score`, `relationships`,
`status history`, …) and emits **23 hardcoded warning types**. The
`` ```yaml section-rules `` fences only feed *hints* into those hardcoded
handlers. The plugin's anti-hardcoding principle is violated by its own body
validator: the section types and their rules live in plugin code, not in
templates.

## 2. Goal

One composable schema system. A **closed registry of rule primitives**. Both
frontmatter and body validation are fully **template-declared** — the plugin
holds zero domain knowledge: no field names, no section types, no enum values.

- Adding a constraint *kind* = registering one primitive function.
- Adding a vault rule = composing primitives in a template, zero plugin code.

## 3. Scope

- **In scope:** redesign of frontmatter validation AND body validation, both
  driven by one shared primitive registry.
- **Greenfield:** `validation_rules` and the 12 hardcoded `SECTION_HANDLERS`
  are replaced outright. No backward-compatibility shim (project policy).
- **Out of scope:** real state-machine transition validation (the dropped
  `state_machine` is replaced by `enum`); derived lifecycle fields
  (`approved_at` etc. — those are *extraction*, not *validation*; see §11).

## 4. Shared primitive registry

The core. One closed set of primitives. Each primitive is a pure function
`(value, param, ctx) => Issue[]`. The registry is consumed by both the
frontmatter engine (§5) and the body engine (§6).

### 4.1 Scalar primitives

Operate on a single value — a frontmatter field's value, or a value extracted
from the body (a table cell, a heading's text).

| Primitive | Applies to | Meaning |
|---|---|---|
| `type` | any | `string \| integer \| number \| boolean \| date \| array` |
| `required` | any | presence — `true \| false \| {when}` |
| `enum` | any | value must be one of the listed values |
| `pattern` | string | value matches the regex |
| `min` / `max` | string → length, number → value, array → element count (resolved by `type`) |
| `uniqueItems` | array | elements must be distinct |
| `exists` | string | value is a repo-relative path; target file must exist |
| `description` | any | metadata for LSP hover — not a constraint |

### 4.2 Structural primitives (body only)

A body section's content is structured (prose, lists, tables, sub-headings,
code fences). These primitives describe that structure.

| Primitive | Meaning |
|---|---|
| `required` | the section/heading must exist |
| `repeatable` | the heading/section occurs 0..N times; cardinality via `min`/`max` |
| `heading` | constrains a heading's text — takes `pattern` / `enum` |
| `table` | the content is a table — declares `columns`; optional `key_column`/`value_column` to expose it as a key→value map |
| `list` | the content is a list — `item:` carries per-item rules |
| `code` | the content contains a fenced code block of language `lang` |
| `formula` | an arithmetic/comparison expression over extracted values must hold |

### 4.3 Modifiers

- `when` — gate any constraint on a condition. Reuses the existing boolean DSL.
- `severity` — `error \| warning` (default `error`).
- `message` — custom error text.

### 4.4 Shorthand vs expanded form

- **Shorthand** (the common case): `enum: [draft, review]`, `min: 3`,
  `required: true`.
- **Expanded** — when a constraint needs a modifier:
  `{ value: <payload>, when?: "<DSL>", severity?: error|warning, message?: "<text>" }`.
- `required`'s payload defaults to `true`, so `required: { when: "<DSL>" }`
  is the conditional-required form.

### 4.5 Expression evaluators

- **`when`** — boolean DSL (`in`, `not in`, `and`, `or`). The existing
  `lib/conditional-eval.js`, reused unchanged.
- **`formula`** — arithmetic + comparison (`+ - * /`, `== < > <= >=`) over
  named extracted values. A generic expression evaluator, implemented as a
  sibling to / extension of `conditional-eval.js`. Generic — it evaluates
  whatever expression the template declares; no formula is hardcoded.

## 5. Frontmatter validation — the `fields:` schema

### 5.1 Template shape

`fields:` is a top-level template-frontmatter key — no `validation_rules` or
`schema` wrapper. Keyed by field name; dot-paths supported
(`success_metric.primary.verdict`). Constraints are written flat on the entry.

```yaml
fields:
  $path:
    pattern: "^prds/prd-\\d+-[a-z0-9-]+\\.md$"
  status:
    type: string
    required: true
    enum: [draft, review, approved]
  rice_score:
    type: integer
    min: 1
    max: 100
  owner:
    type: string
    required: { when: "status in ['approved']" }
# strict: true   # optional — opt in to undeclared-key errors
```

Other top-level template keys, unchanged, **not** part of the schema (they do
not validate anything): `sections:` (formatter H2 ordering), `tier:` (LSP
completion grouping), `template_id` / `template_version` (identity).

The rule: anything that *validates* lives in `fields:`; anything else stays
out.

### 5.2 Synthetic fields

Values not sourced from frontmatter are modeled as **synthetic fields** with a
`$` prefix — same engine, same primitives, only the value resolver differs.

- `$path` — the document's repo-relative POSIX path. Replaces `path_regex`.

Resolution: a normal field resolves via `getField(frontmatter, dotPath)`; a
synthetic field resolves via a registered function (`$path` →
`doc.repoRelativePath`). The resolver map is generic infrastructure. Future
`$filename` / `$folder` add the same way (out of scope now). Meta-validation
restricts synthetic fields to the primitives that make sense (`pattern`,
`enum`).

### 5.3 Undeclared-key policy

A frontmatter key not declared in `fields:` is **ignored by default** (Zod's
lenient default; markdown vaults carry incidental keys — Obsidian `aliases`,
`tags`, …). A template opts into strictness with top-level `strict: true`,
turning any undeclared key into an error. Typos on *required* fields surface
regardless — the missing required field is reported.

## 6. Body validation — heading-matched `section-rules`

### 6.1 Mechanism

1. Parse the document body to an AST (remark, as `body-parser` already does).
2. Parse the template body to an AST. The template body is a **heading tree**;
   each heading section may carry one `` ```yaml section-rules `` fenced block.
3. For each template heading that carries `section-rules`, find the matching
   heading in the document and validate the document section's content
   against the block's primitives.
4. **Recursive** — a sub-heading (H3 under an H2) carries its own
   `section-rules` and is matched within its parent's matched section.

The template body **mirrors** the shape the document body must have.

### 6.2 Heading matching

- **Non-repeatable** — matched by normalized heading text (lowercased,
  trimmed). Template `## Acceptance Criteria` matches document
  `## Acceptance Criteria`.
- **Repeatable** (`repeatable: true`) — the template heading is a
  pattern-placeholder. Every document heading at that nesting level is a
  repeated item, each validated by the section's rules (`heading.pattern`,
  nested content rules). Cardinality via `min` / `max`.

### 6.3 No `fields:` wrapper

Unlike frontmatter, body rules are written directly in the `section-rules`
block — the heading plus its position in the AST tree *is* the address. No
keyed map is needed.

### 6.4 `body-parser.js` → generic shape parsers

`body-parser.js` is reduced to a small set of **shape parsers** — pure
infrastructure that knows markdown shapes, not vault sections:

- `table` — parse a GFM table into header + rows.
- `list` — parse a list into items.
- `heading-tree` — parse the body into a tree of headings + their content.
- `code-fence` — locate fenced code blocks and their language.

The 12 `SECTION_HANDLERS` and 23 hardcoded warning types are **deleted**. No
code path knows what "RICE" or "Acceptance Criteria" means.

### 6.5 Examples

Acceptance Criteria — a section containing 0..N repeated H3 items:

````markdown
## Acceptance Criteria
```yaml section-rules
required: true
```

### <item>
```yaml section-rules
repeatable: true
heading:
  pattern: "^AC\\d+ — .+ — `(must|should|nice)` · `(draft|verified)`$"
```
````

RICE Score — a key/value table plus an arithmetic check:

````markdown
## RICE Score
```yaml section-rules
required: true
table:
  key_column: Dimension
  value_column: Value
formula: "score == reach * impact * confidence / effort"
```
````

`table` exposes the rows as a key→value map (`reach`, `impact`, … from the
`Dimension` column); `formula` evaluates the expression over them. No plugin
code mentions RICE.

### 6.6 Pinned details

**Repeatable cardinality & matching.** A `repeatable` template heading at
depth N claims every document heading at depth N within the matched parent
section. Cardinality is `min`/`max` (count of matching headings); `required:
true` means `min: 1`; absent means `0..N`. A document heading at that depth
that fails the section's `heading.pattern` is a `heading-mismatch` error — a
repeatable section owns its heading level.

**`table` + `formula` value resolution.** When a `table` declares
`key_column` + `value_column`, its rows become a map: each identifier is the
`key_column` cell normalized (lowercased, trimmed, spaces → `_`), its value
the `value_column` cell parsed as a number. `formula` identifiers resolve
against that map; an identifier whose cell is non-numeric yields a
`formula-violation`. Numeric `==` uses an epsilon tolerance (`1e-9`) so float
arithmetic does not fail spuriously.

**Body issue addressing.** A body issue carries an explicit 0-indexed
document-absolute `line` (from the offending AST node's `position`, offset as
`validateSectionRulesLeak` already does) so `server/diagnostics.js` resolves
it directly. `field` is a human-readable heading path (`## Acceptance
Criteria`, or `## Acceptance Criteria › ### AC1`) used as the diagnostic
`code`; `narrowRange` falls back to a whole-line highlight, which is correct
for a body node.

## 7. Engine

A new module `lib/schema-engine.js`:

- `PRIMITIVES` — the registry (§4.1, §4.2).
- `SYNTHETIC_RESOLVERS` — the `$`-field value resolvers (§5.2).
- `validateTemplateSchema(parsed)` — template meta-validation (§8).
- `applyFieldSchema(schema, frontmatter, docMeta)` — frontmatter validation.
- `applyBodySchema(templateBodyAst, docBodyAst)` — body validation (§6).

`applyRules` in `lib/validators.js` and the 12 `SECTION_HANDLERS` in
`body-parser.js` are removed. `when` keeps using `lib/conditional-eval.js`
unchanged. `formula` gets a new module `lib/expression-eval.js` — a
recursive-descent evaluator for arithmetic (`+ - * /`) and comparison,
hand-rolled following the proven structure of `conditional-eval.js`, no new
dependency.

The issue shape is **unchanged** — `{ level, field, message, fix, error_type?,
line?/bodyLine? }` — so `server/diagnostics.js` and the CLI reporter keep
working untouched. For body issues, `field` carries the heading path; `line`
points at the offending node via the AST `position`.

`error_type` values: `type-mismatch`, `enum-violation`, `pattern-mismatch`,
`min-violation`, `max-violation`, `unique-violation`, `required-missing`,
`exists-missing`, `path-mismatch`, `undeclared-field`, `heading-mismatch`,
`table-shape`, `list-item`, `code-missing`, `formula-violation`,
`cardinality`, `template-schema-invalid`.

## 8. Template meta-validation

Because both `fields:` and `section-rules` have defined structures, the
template itself is validated — once, when loaded, before any document:

- every key in a field entry / `section-rules` block is a known primitive (or
  `description` / a modifier);
- `type` ∈ the six allowed types;
- every regex (`pattern`, …) compiles;
- `enum` is a non-empty array; `min` / `max` are numbers;
- `when` strings parse as valid boolean DSL; `formula` strings parse as valid
  expressions;
- synthetic `$` fields use only `pattern` / `enum`.

A malformed template yields a structured **template error** attributed to the
template — the engine never throws mid-document. This is the root-cause fix
for the crash bug and for "templates are never validated."

A `vault-keeper lint-templates` subcommand (list every broken template
independent of documents) is a natural follow-up — noted, out of scope.

## 9. Migration map

### Frontmatter

| Old `validation_rules` key | New |
|---|---|
| `required_fields` | `required: true` on each field |
| `field_rules` (`regex`/`values`/`type`/`min`) | flattened onto the field as `pattern` / `enum` / `type` / `min` |
| `conditional_required_fields` | `required: { when }` / `<constraint>: { value, when }` |
| `state_machine` | **dropped** → `status: { enum: [...] }` |
| `path_regex` | `$path: { pattern }` |
| `sections` | kept — top-level `sections:` (formatter config) |
| `tier` | kept — top-level `tier:` |
| `optional_fields` | **dropped** — unset `required` ⇒ optional |
| `body_section_formats` | **dropped** — body `section-rules` supersede it |
| `allowed_roles`, `required_body_sections`, `required_gherkin_section` | **dropped from frontmatter** — body `section-rules` express them |

### Body

| Old `section-rules` hint / body-parser behavior | New |
|---|---|
| `required: true` | `required: true` (unchanged) |
| `heading_format` / `heading_example` | `heading: { pattern }` |
| `valid_priorities` / `valid_statuses` | encoded in the `heading.pattern` regex |
| `gherkin: true` | `code: { lang: gherkin }` |
| `headers` (table headers) | `table: { columns }` |
| `format` / `example` (line format) | `list: { item: { pattern } }` |
| 12 `SECTION_HANDLERS` | **deleted** — replaced by generic shape parsers |
| 23 hardcoded warning types | **deleted** — issues emitted generically by primitives |

## 10. Files affected

| File | Change |
|---|---|
| `lib/schema-engine.js` | **new** — registry, synthetic resolvers, meta-validation, frontmatter + body apply |
| `lib/template-rules.js` | rewritten — loads `fields:` / `$path` / `strict` / `sections` / `tier` |
| `lib/template-section-rules.js` | rewritten — parses `section-rules` blocks as primitive schemas, builds the template heading tree |
| `lib/body-parser.js` | gutted to generic shape parsers (`table`/`list`/`heading-tree`/`code-fence`); 12 handlers + 23 warnings removed |
| `lib/conditional-eval.js` | extended (or a sibling module added) for `formula` arithmetic/comparison |
| `lib/validators.js` | `applyRules` removed; cross-cutting validators (`validateSlug`, `validateSectionRulesLeak`, `validateTemplateMetaLeak`, `validatePaths`) stay |
| `cli/validate-documents.js` | `validateDocument` calls the new engine; `validatePathRegex` removed (folded into `$path`) |
| `server/validator.js` | `validateBuffer` calls the new engine |
| `server/main.js` + LSP providers (`completion`, `code-action`, `inlay-hint`, `code-lens`, `hover`) | updated to the new schema |
| `lib/canonical-formatter.js` | reads `sections` from its new top-level location |
| `lib/index.js` | public-API exports updated |
| `examples/example/templates/*.md` (4 templates) | migrated to the new format |
| `docs/templates/*.md` | rewritten |
| `skills/vault.new/SKILL.md` | API-usage section rewritten — it calls `loadTemplateRules` and maps `field_rules`; the returned shape changes |
| `skills/vault.setup/`, `vault.health/`, `vault.fix/`, `skills/README.md` | terminology updated (`validation_rules` / `field_rules` → `fields:` schema) |
| `tests/*` | extensive updates + new coverage for the engine, body schema, meta-validation |
| `CHANGELOG.md`, project `CLAUDE.md` | updated |

The implementation plan will sequence this work into phases.

## 11. Non-goals

- Backward compatibility with the old `validation_rules` format or the old
  `section-rules` hint keys.
- Real state-machine transition validation (transitions checked against a body
  history table — a separate future feature).
- Derived lifecycle fields (`approved_at`, `started_at`, …). These are
  *extraction*, not validation; they leave the validation path. A grep
  confirmed no code reads them today — only `body-parser` produces them — so
  dropping them breaks nothing. A future consumer computes them from the
  generic `table` shape-parser output.
- `vault-keeper lint-templates` subcommand (natural follow-up; see §8).
- Capture-group → sub-field decomposition of headings (a `heading.pattern`
  regex carries its own enums inline; deferred).
- The `validateSectionRulesLeak` built-in rule (a `section-rules` fence is
  template-only) is **kept** — unaffected by this redesign.
