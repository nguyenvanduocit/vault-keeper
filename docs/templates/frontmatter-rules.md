# Frontmatter rules

The `validation_rules` block in a template's frontmatter declares the
schema that every instance of that template must satisfy. This page
covers the rules that govern frontmatter:

- [`required_fields`](#required_fields)
- [`optional_fields`](#optional_fields)
- [`conditional_required_fields`](#conditional_required_fields)
- [`field_rules`](#field_rules)
- [`state_machine`](#state_machine)

For folder / filename / body rules see
[folder-and-naming](folder-and-naming.md) and [body-rules](body-rules.md).

---

## `required_fields`

A flat list of frontmatter dot-paths that must resolve to a non-empty
value (`undefined`, `null`, or empty string fail).

```yaml
validation_rules:
  required_fields: [template, document_type, title, owner, status]
```

Dot-paths work for nested keys:

```yaml
required_fields:
  - template
  - metadata.author
  - metadata.created_at
```

If `metadata.author` is missing or empty the validator emits:

```
[ERR ] field=metadata.author  Missing required field: metadata.author
       fix: Add metadata.author to frontmatter
```

### Notes

- The check is "non-empty value" — `0` and `false` count as present.
  Empty arrays and empty objects do NOT pass (`""`, `null`, `undefined`
  fail).
- Order in the list is irrelevant — each path is checked independently.

---

## `optional_fields`

Pure documentation — the validator does not enforce anything on
`optional_fields`. Use it to communicate to instance authors which keys
are permitted but not required:

```yaml
validation_rules:
  required_fields: [template, title, owner]
  optional_fields: [tags, related_url, deadline]
```

Future tooling (e.g. the completion provider) may use this list to drive
suggestions. The CLI validator currently ignores it.

---

## `conditional_required_fields`

Required only when a DSL condition matches the instance's frontmatter.
Each entry is an object:

```yaml
validation_rules:
  conditional_required_fields:
    - condition: "status in ['approved', 'shipped']"
      field: shipped_date
      required: true
    - condition: "doc_type in ['feature']"
      field: design_link
      required: true
      severity: warning
```

### Entry shape

| Key | Type | Required | Meaning |
|---|---|---|---|
| `condition` | string (DSL) | yes | Tiny DSL evaluated against frontmatter; see [DSL grammar](#dsl-grammar) |
| `field` | string (dot-path) | yes | Frontmatter key that becomes required when the condition matches |
| `required` | bool | one-of-two | `true` → field must be present + non-empty |
| `min_count` | int | one-of-two | Field must be an array of at least this length |
| `severity` | string | no | `"warning"` (default `"error"`) — emit at warning level instead of error |

Exactly one of `required: true` or `min_count: <int>` should be set per
entry.

### `body_section:` prefix — conditional body sections

A `field:` value that starts with `body_section:` switches the check
from "frontmatter key present" to "body H2 heading present":

```yaml
conditional_required_fields:
  - condition: "prd_type in ['feature', 'enhancement']"
    field: "body_section:## Ship Timeline"
    required: true
```

When `prd_type` is `feature` or `enhancement`, the instance body must
contain a `## Ship Timeline` H2 heading. Code blocks (``` … ``` and
~~~ … ~~~) are stripped before the heading scan, so headings inside
fenced code don't count as "present".

### DSL grammar

The condition language is intentionally narrow. Grammar:

```
expr        := or_expr
or_expr     := and_expr ( 'or' and_expr )*
and_expr    := comparison ( 'and' comparison )*
comparison  := field ( 'in' | 'not' 'in' ) list
list        := '[' ( string ( ',' string )* )? ']'
field       := IDENT ( '.' IDENT )*
string      := single-quoted | double-quoted
```

Examples:

```
status in ['approved', 'shipped']
prd_type in ['feature'] and status not in ['draft', 'review']
priority in ['must', 'should'] or owner in ['@alice', '@bob']
metadata.kind in ['feature']
```

The only operators are `in`, `not in`, `and`, `or`. Dotted field paths
are supported. String literals must be single- or double-quoted. There
is no equality operator, no arithmetic, no functions — by design (the
DSL is meant to be readable in a template by a non-engineer).

### What happens on evaluation

- The DSL is evaluated against the instance's parsed frontmatter object.
- If the condition matches → the field is checked.
- If the condition does not match → the entry is skipped silently.
- A DSL parse error or evaluation error produces ONE error diagnostic
  with `field: "validation_rules"` so the template author sees the
  problem.

---

## `field_rules`

Per-field rules that govern the **value** of a present field. The
validator skips empty values (those are `required_fields`' territory).

```yaml
validation_rules:
  field_rules:
    - field: created
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: status
      values: [draft, review, approved, shipped]
    - field: rice.reach
      type: integer
      min: 1
```

Each entry targets one `field` (dot-path) and applies one or more of:

### `regex` (string)

Value must match this regex. The string is compiled with `new RegExp()`
at runtime — escape backslashes correctly in YAML.

```yaml
- field: ticket_id
  regex: "^[A-Z]+-\\d+$"
```

A non-string value automatically fails the regex check.

**Special case: native YAML dates.** When YAML 1.1 parses `created:
2026-05-12` into a JavaScript `Date` object, the regex check accepts it
silently (YAML already validated the date format). Only `Invalid Date`
sentinels are flagged.

### `values` (array — enum)

Value must appear in the list.

```yaml
- field: priority
  values: [must, should, nice]
```

If `priority: critical` appears in an instance, the validator emits:

```
[ERR ] field=priority  Invalid priority: 'critical'
       fix: Use one of: must, should, nice
```

### `type: integer`

Value must be an integer (`Number.isInteger`). `1.5` fails. Strings of
digits fail (they're not numbers).

```yaml
- field: rice.reach
  type: integer
```

### `min` (number)

Numeric lower bound (inclusive).

```yaml
- field: rice.confidence
  min: 0.1
```

Negative `min` works (`min: -1` permits `-1` and above).

### Combining rules

Multiple rule fields on one entry all apply:

```yaml
- field: rice.reach
  type: integer
  min: 1
- field: status
  values: [draft, review, approved]
  regex: "^[a-z][a-z_]+$"
```

Each violation produces a separate diagnostic.

---

## `state_machine`

Declares the lifecycle of the `status` field as a transition graph.

```yaml
validation_rules:
  state_machine:
    draft:    [review, dropped]
    review:   [approved, draft]
    approved: [shipped, draft]
    shipped:  []
    dropped:  []
```

### What the validator checks

- If `frontmatter.status` exists and is **not** a declared key of the
  state machine, emit one **warning**:

  ```
  [WARN] field=status  Status 'shippping' is not declared in template state_machine
         fix: Use one of: draft, review, approved, shipped, dropped
  ```

The transition graph (`draft: [review, dropped]`) is **declarative
metadata** — the validator does not currently verify history transitions
against it. Tools that build on top of the validator (board generators,
agent skills) read the graph to suggest next states, but the validator
itself only checks that the current `status` is a known node.

This is intentional: history-table parsing is the body parser's job, and
keeping the state machine as a pure schema declaration means it works
for any vault — no per-domain history table format assumption.

---

## A complete example

```yaml
---
template_path: templates/feature-template.md
document_type: feature
validation_rules:
  required_fields:
    - template
    - document_type
    - title
    - owner
    - status
  optional_fields:
    - tags
    - design_link
  conditional_required_fields:
    - condition: "status in ['shipped']"
      field: shipped_date
      required: true
    - condition: "priority in ['must']"
      field: rice
      required: true
    - condition: "rice.reach in ['high', 'medium']"
      field: "body_section:## Risk Assessment"
      required: true
      severity: warning
  field_rules:
    - field: created
      regex: "^\\d{4}-\\d{2}-\\d{2}$"
    - field: priority
      values: [must, should, nice]
    - field: rice.reach
      type: integer
      min: 1
    - field: rice.confidence
      type: integer
      min: 1
  state_machine:
    draft:    [review, dropped]
    review:   [approved, draft]
    approved: [shipped, draft]
    shipped:  []
    dropped:  []
---
```

An instance must declare at least `template`, `document_type`, `title`,
`owner`, `status` (else hard errors). If `status: shipped` it must also
declare `shipped_date`. `created` must be `YYYY-MM-DD`. `priority` must
be one of three values. `rice.reach` must be an integer ≥ 1. The
`status` field is checked against the declared state machine (warning
on unknown).

## See also

- [Folder & filename rules](folder-and-naming.md) — `allowed_folders`,
  naming conventions.
- [Body rules](body-rules.md) — `sections[]`, body section-rules code
  fences.
- [Full example](full-example.md) — end-to-end template + instance.
- [Troubleshooting](../troubleshooting.md) — common rule-author errors
  with fixes.
