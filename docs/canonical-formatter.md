# Canonical formatter

`lib/canonical-formatter.js` rewrites a vault document into its canonical
shape. The LSP exposes it via `documentFormattingProvider` (format-on-save
or explicit format request). It runs in-memory and is **idempotent** —
running it twice produces the same output as running it once.

## What it touches

The formatter applies these transforms in order:

1. [Frontmatter key reordering](#frontmatter-key-reordering)
2. [Body section reordering](#body-section-reordering)
3. [AC heading normalization](#ac-heading-normalization)
4. [Relationship bullet normalization](#relationship-bullet-normalization)
5. [Trailing whitespace strip](#trailing-whitespace-strip)
6. [Blank-line collapse](#blank-line-collapse)
7. [Final newline normalization](#final-newline-normalization)

All transforms **skip lines inside fenced code blocks** (``` … ``` and
~~~ … ~~~) so embedded code samples don't get rewritten.

## API

```js
import { formatVaultDocument, formatVaultDocumentAsync }
  from "./lib/canonical-formatter.js";

// Pure: caller provides the canonical sections list
const { formatted, changed } = formatVaultDocument(text, {
  sections: ["problem", "goals", "*", "relationships"],
});

// Async: loads template's `sections` from disk via frontmatter.template
const { formatted, changed } = await formatVaultDocumentAsync(text, {
  projectRoot: "/path/to/vault",
});
```

`changed` is `true` if the output differs from the input.

## 1. Frontmatter key reordering

Frontmatter keys are sorted with priority keys first in fixed order,
then everything else alphabetically.

Priority keys (in order):

```
id  title  template  status  phase  owner  created  updated
```

Example input:

```yaml
---
status: draft
owner: '@alice'
template: templates/note-template.md
title: Hello
random_field: yes
zzz_last: 1
---
```

After formatting:

```yaml
---
title: Hello
template: templates/note-template.md
status: draft
owner: '@alice'
random_field: yes
zzz_last: 1
---
```

`title`, `template`, `status`, `owner` move to the front in the
priority order; `random_field` and `zzz_last` sort alphabetically
after.

### Frontmatter YAML serialization

The formatter re-emits frontmatter via `js-yaml.dump` with:

- `lineWidth: -1` (no auto-wrap)
- `noRefs: true` (no YAML anchors / aliases)
- `quotingType: "'"` + `forceQuotes: false` (single-quoted strings when
  needed)

Date objects are serialized as ISO date strings (YAML 1.1's date type).

## 2. Body section reordering

When `opts.sections` (or the template's `sections[]` validation rule) is
present, body H2 sections are reordered to match the canonical list.

```yaml
validation_rules:
  sections:
    - problem
    - goals
    - "*"
    - relationships
```

- Sections in the explicit list appear in that order.
- Sections not in the list ("unlisted") insert at the `*` wildcard
  position, OR at the end if no wildcard.
- Sections preserve their full content (heading + body) — only the
  order changes.

### Heading → slug

The mapping is exact: `## Acceptance Criteria` → `acceptance-criteria`
(lowercase, spaces → hyphens).

### Preamble

Content before the first H2 (the H1 title, intro paragraphs) is
preserved as the "preamble" and stays in front of all reordered
sections.

## 3. AC heading normalization

H3+ headings that match the Acceptance Criteria shape are normalized:

| Input | Output |
|---|---|
| `### AC1: User logs in` | `### AC1 — User logs in` |
| `### AC 2 - Fast checkout` | `### AC2 — Fast checkout` |
| `### AC1 — user logs in` | `### AC1 — User logs in` (title-case first char) |

Regex (case-insensitive):

```
^(#{3,})\s+AC\s*(\d+)\s*[-:—]\s*(.+)$
```

The separator becomes ` — ` (em-dash with spaces), the AC number
collapses (`AC 1` → `AC1`), the title's first character is
upper-cased.

## 4. Relationship bullet normalization

Bullets in any section that match the relationship shape get rewritten
to canonical form.

| Input | Output |
|---|---|
| `- implements: [DIBB-001](path.md)` | `- **implements** [DIBB-001](path.md)` |
| `- implements [DIBB-001](path.md) - bets on growth` | `- **implements** [DIBB-001](path.md) — bets on growth` |
| `- **implements**: [DIBB-001](path.md)` | `- **implements** [DIBB-001](path.md)` |

Canonical form:

```
- **<predicate>** [<title>](<path>) [— <reason>]
```

- Predicate gets wrapped in `**` (Markdown bold).
- The colon (`:`) or extra space between predicate and link is dropped.
- Reason fragments get a ` — ` (em-dash with spaces) prefix.

Already-canonical bullets pass through unchanged.

### Predicates the regex recognises

Any `[a-z_]+` word followed by a markdown link counts as a "predicate"
candidate. The formatter doesn't enforce a closed vocabulary — your
template decides what's meaningful via body section-rules. The
formatter only normalises **shape**.

## 5. Trailing whitespace strip

Every non-code-block line has trailing whitespace stripped (`/\s+$/`).

Code-block lines are preserved (whitespace inside code can be
semantically meaningful).

## 6. Blank-line collapse

Runs of 3+ consecutive blank lines collapse to 2. Inside-section runs
stay tight (one blank line max between intra-section paragraphs is the
expected human-written shape; the formatter tolerates 2 between H2s).

## 7. Final newline normalization

The file ends with exactly one trailing newline (POSIX convention).

## Idempotency invariant

`format(format(x)) === format(x)` for any string `x`. The formatter is
deterministic — same input → same output. CI can run it twice and
assert byte-identity to catch idempotency regressions.

The one trap historically: gray-matter strips the leading `\n` from
`parsed.content` when input was already canonical, breaking
idempotency. The formatter normalises this by stripping ALL leading
newlines from the parsed body and re-injecting exactly one — see
`canonical-formatter.js` comments for the full rationale.

## Async variant

`formatVaultDocumentAsync(text, { projectRoot })` reads the doc's
frontmatter, extracts the `template:` field, loads that template's
`validation_rules.sections[]`, and applies the section ordering
automatically. Use this from contexts that don't already have the
sections list in hand (e.g. an editor extension).

If the template can't be loaded, sections reordering is skipped — every
other transform still applies.

## What it does NOT do

The formatter only normalises shape; it does **not**:

- Add missing required fields.
- Insert missing required sections.
- Reorder frontmatter keys beyond the priority list (alphabetical for
  the rest is intentional).
- Touch list-item ordering inside a section.
- Re-wrap long lines.

For schema-level issues (missing fields, format violations), use the
[CLI validator](cli-validator.md) — the formatter and validator have
separate responsibilities.

## See also

- [LSP features](lsp-features.md#documentformatting) — how
  `documentFormattingProvider` exposes this.
- [Body rules](templates/body-rules.md) — `sections[]` declaration in
  templates.
- [Body parser](body-parser.md) — what the parser expects vs what the
  formatter normalises.
