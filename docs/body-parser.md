# Body parser

`lib/body-parser.js` parses markdown body content (frontmatter stripped
by the caller) and extracts structured sections.

Both the LSP (via `server/validator.js`) and the CLI use the same
parser instance. Templates declare which sections matter via body
section-rules and `body_section_formats`; the parser surfaces warnings
when bullets / tables in a recognised section don't match the expected
format.

## API

```js
import { parseBody } from "./lib/body-parser.js";

const parsed = await parseBody(bodyMarkdown, {
  sourcePath: "docs/notes/note-001.md",   // attaches to warnings
  formatHints: { relationships: { ... } } // from template
});
```

Returns:

```js
{
  relationships: [ ... ],
  acceptanceCriteria: [ ... ],
  userStories: [ ... ],
  statusHistory: [ ... ],
  phaseHistory: [ ... ],
  blockedHistory: [ ... ],
  riceScore: { ... },
  shipTimeline: { ... },
  contributions: [ ... ],
  metricVerdict: { ... },
  dataSources: { ... },
  warnings: [ ... ],
  derived: { ... }
}
```

## Recognised sections

Sections are matched by H2 heading text (`## <Heading>`). Headings not
in the list pass through untouched — the parser doesn't complain about
unknown sections.

### `## Relationships`

Bullet list of typed edges to other vault documents.

**Canonical form:**

```markdown
## Relationships

- **implements** [DIBB-001](../strategy/dibbs/dibb-001.md) — *bets on growth*
- **derived_from** [PRD-007](../prds/prd-007.md#AC2)
- **references** [Note](../notes/note-003.md)
```

**Extracted:**

```js
relationships: [
  { predicate: "implements", title: "DIBB-001",
    path: "../strategy/dibbs/dibb-001.md",
    anchor: null, reason: "bets on growth", line: 3 },
  { predicate: "derived_from", title: "PRD-007",
    path: "../prds/prd-007.md", anchor: "AC2", reason: null, line: 4 },
  ...
]
```

**Warnings:** bullets that don't match the regex emit `code: "body"`
warnings citing the `format`/`example` hint from
`body_section_formats.relationships` (or the template's body
section-rules).

### `## Acceptance Criteria`

H3 sub-headings with priority + status markers.

**Canonical form:**

```markdown
## Acceptance Criteria

### AC1 — User can checkout — `must` · `verified`

Description / verification artifact link goes here.

### AC2 — Payment methods preserved — `must` · `in_progress`
```

**Extracted:**

```js
acceptanceCriteria: [
  { id: "AC1", title: "User can checkout",
    priority: "must", status: "verified",
    flag: null, gherkin: null, line: 3 },
  ...
]
```

Each AC may carry an optional flag in parens: `### AC2 — Foo — \`must\`
· \`descoped\` (descoped: ran out of budget)` — `flag` becomes
`"descoped: ran out of budget"`.

**Gherkin sub-blocks** inside an AC (fenced `gherkin` code block) parse
into `gherkin: { hasScenario, hasGiven, hasWhen, hasThen }`.

### `## User Stories`

PRD → story refinement list. Same bullet shape as Relationships but
keyed under `userStories[]`.

### `## Status History`

Table of status transitions.

```markdown
## Status History

| At                        | From | To       | By     | Note            |
|---------------------------|------|----------|--------|-----------------|
| 2026-05-10T09:00:00+07:00 | draft | review   | @alice | RICE draft done |
| 2026-05-12T14:30:00+07:00 | review | approved | @bob   |                 |
```

**Extracted:**

```js
statusHistory: [
  { at: "2026-05-10T09:00:00+07:00", from: "draft", to: "review",
    by: "@alice", note: "RICE draft done", line: 4 },
  ...
]
```

The "At" column accepts both `At (UTC)` and `At` header variants.

### `## Phase History`

Identical shape to Status History. Extracted as `phaseHistory[]`.

### `## Blocked History`

Open/close pairs.

```markdown
| Opened                    | Closed | Reason                     | By     |
|---------------------------|--------|----------------------------|--------|
| 2026-05-12T08:00:00+07:00 | _open_ | Blocked by PRD-007 AC1 clarification | @bob |
```

**Extracted:** `blockedHistory[]` with `from`, `to` (null if `_open_`),
`reason`, `by`.

### `## RICE Score`

Reach / Impact / Confidence / Effort breakdown (free-form table or
key-value list). Extracted as `riceScore: { reach, impact, confidence,
effort, total, scoreComputedMatch }`.

### `## Ship Timeline`

Target-ship-date + lock state + history.

```markdown
| target_ship_date | locked_at  | locked_by |
|------------------|------------|-----------|
| 2026-06-01       | 2026-05-15 | @alice    |

### History

| At                        | Kind       | From       | To         | Reason  | By |
|---------------------------|------------|------------|------------|---------|-----|
| 2026-05-15T10:00:00+07:00 | lock       |            | 2026-06-01 | First commit | @alice |
| 2026-05-20T10:00:00+07:00 | target_ship_date | 2026-06-01 | 2026-06-15 | Slipped | @alice |
```

**Extracted:** `shipTimeline: { target_ship_date, locked_at, locked_by,
history: [...] }`.

### `## Contributions`

Per-role attribution list.

```markdown
- **author** · @alice · 2026-05-10T09:00:00+07:00 · sections: `*` · effort: `medium`
- **reviewer** · @bob · 2026-05-11T14:30:00+07:00 · sections: `*` · effort: `major` · decision: `approved`
```

**Extracted:** `contributions[]` with `role`, `person`, `at`,
`sections`, `effort`, optional `decision`, `artifact`, `note`.

### `## Contribution Log`

Derived view (parsed for drift detection only — `## Contributions` is
the authoritative source).

```markdown
- 2026-05-10T09:00:00+07:00 — [@alice](../people/alice.md) **author**
- 2026-05-12T14:30:00+07:00 — [@bob](../people/bob.md) **reviewer**
```

**Extracted:** `contributionLog[]` with `at`, `handle`, `path`, `role`.

### `## Success Metric Verdict`

Verdict structure with primary + supporting measurements.

### `## Data Sources`

Per-source breakdown (Intercom / Amplitude / BigQuery / external).

## Warnings

Each warning is an object:

```js
{
  type: "relationship-bullet-format",      // category
  level: "warning",
  line: 23,                                // 1-indexed in body
  message: "Relationship bullet does not match expected format: `...`",
  fix: "Fix the format to match the expected pattern shown in the message",
  raw: "...the bad bullet line..."         // original source
}
```

Warning categories the parser emits:

| Category | Trigger |
|---|---|
| `relationship-bullet-format` | Bullet in `## Relationships` doesn't match expected shape |
| `ac-heading-format` | H3 in `## Acceptance Criteria` doesn't match expected heading shape |
| `contribution-bullet-format` | Bullet in `## Contributions` doesn't match expected shape |
| `status-history-row-format` | Table row in `## Status History` has wrong column count or unparseable cell |
| `phase-history-row-format` | Same, for `## Phase History` |
| `blocked-history-row-format` | Same, for `## Blocked History` |
| `ship-timeline-row-format` | Same, for `## Ship Timeline` history |

The validator (LSP + CLI) lifts every parser warning to a diagnostic
with `code: "body"` and the line attached.

## Derived fields

The parser computes a small set of derived timestamps from the history
tables — useful for tools that surface "X days in current phase" /
"date entered status".

```js
derived: {
  started_at: "2026-05-10T09:00:00+07:00",         // earliest phase-history entry
  in_progress_at: "2026-05-12T14:30:00+07:00",     // first transition to in_progress status
  shipped_at: "2026-05-20T16:00:00+07:00",         // first transition to shipped status
  approved_at: "2026-05-12T14:30:00+07:00",        // first transition to approved status
  ...
}
```

These fields are NEVER written back to frontmatter — they're computed
at read time from the body's history tables. The LSP's
`status:`-line inlay hint uses `derived.in_progress_at` /
`derived.statusHistory` to render "in this phase: Nd".

## Text normalization

Before regex matching, bullet/list lines are normalised:

- Collapse runs of whitespace to single spaces.
- Replace en-dash / em-dash (`–`, `—`) with em-dash (`U+2014`).
- Replace smart quotes (`'`, `'`, `"`, `"`) with straight quotes.

Table cells are extracted via `mdast-util-to-string` which already
gives clean text; normalisation still runs for dash/quote
consistency.

## Configuration via `formatHints`

Pass per-section format hints from a template's `validation_rules`:

```js
const parsed = await parseBody(body, {
  formatHints: {
    relationships: {
      format: "- [<title>](<path>) [— *<reason>*]",
      example: "- [DIBB-001](../strategy/dibbs/dibb-001.md) — *bets on growth*"
    },
    contributions: {
      format: "**<role>** · @<handle> · <ISO-ts> · ...",
      example: "**author** · @alice · 2026-01-01T00:00:00+07:00 · ..."
    }
  }
});
```

When a bullet/row doesn't match, the warning includes the `format:`
string verbatim. This is the same hint passed via `body_section_formats`
in the template (or via body section-rules code fences) — see
[body-rules](templates/body-rules.md).

## See also

- [LSP features — diagnostics](lsp-features.md#diagnostics) — how
  parser warnings become editor squiggles.
- [Canonical formatter](canonical-formatter.md) — how relationship
  bullets / AC headings get normalised on format-on-save.
- [Body rules](templates/body-rules.md) — declaring format hints in
  templates.
