# Programmatic usage

Beyond the `vault-keeper` CLI and the LSP server, every layer of the
plugin is importable as a plain ES module. Build your own scripts on top
of it — CI gates, bulk-rewrites, custom reporters, editor integrations,
dashboards that surface vault state — without shelling out to the CLI.

All modules are pure ESM (`"type": "module"` in `package.json`); import
them from a Bun or Node ≥ 18 project that depends on the package.

```bash
bun add claude-code-vault-keeper
# or, against a local checkout:
bun add file:../claude-code-vault-keeper
```

## The barrel

`import` directly from the package name to get the public surface —
parsers, validators, formatter, the orchestrator, config helpers, and
the LSP-side per-buffer validator are all re-exported from one barrel:

```js
import {
  // I/O
  parseDocument, resolveDocPath,

  // Parsing
  parseBody, parseSectionRules, loadTemplateSectionRules,

  // Template rules
  loadTemplateRules, normalizeRules,

  // Validators (pure)
  CONFIG,
  applyRules,
  validateTemplateField,
  validateTemplateMetaLeak,
  validateSlug, validatePaths, suggestSlug,
  stripCodeRegions,
  inferDocType, isTemplateFile, isTemplateInstance, findTemplateMetaLeaks,

  // Formatter
  formatVaultDocument, formatVaultDocumentAsync,

  // Conditional DSL (used by validation_rules.conditional_required_fields)
  evaluateCondition, getField,

  // Vault config
  resolveProjectRoot, loadVaultConfig,

  // Orchestrator (file-walking + per-doc validation)
  validateDocument, findDocuments, findAllFiles, validateLinkExistence,

  // LSP-side variant — validates an in-memory buffer, no FS scan
  validateBuffer,

  // Package version (string)
  VERSION,
} from 'claude-code-vault-keeper';
```

## Subpath exports

If you want a smaller import surface, the package exposes one subpath
per logical module:

| Subpath | What's there |
|---|---|
| `claude-code-vault-keeper/parser` | `parseBody` |
| `claude-code-vault-keeper/doc-io` | `parseDocument`, `resolveDocPath` |
| `claude-code-vault-keeper/template-rules` | `loadTemplateRules`, `normalizeRules` |
| `claude-code-vault-keeper/template-section-rules` | `parseSectionRules`, `loadTemplateSectionRules`, `getRequiredSections` |
| `claude-code-vault-keeper/validators` | `applyRules`, `validateSlug`, `validatePaths`, … `CONFIG` |
| `claude-code-vault-keeper/formatter` | `formatVaultDocument`, `formatVaultDocumentAsync` |
| `claude-code-vault-keeper/conditional-eval` | `evaluate`, `getField` |
| `claude-code-vault-keeper/vault-config` | `resolveProjectRoot`, `loadVaultConfig` |
| `claude-code-vault-keeper/orchestrator` | `validateDocument`, `findDocuments`, `findAllFiles` |
| `claude-code-vault-keeper/lsp-validator` | `validateBuffer` |
| `claude-code-vault-keeper/package.json` | The manifest (read `version` etc.) |

Deep imports of original files (`claude-code-vault-keeper/lib/<x>.js`,
`claude-code-vault-keeper/cli/<x>.js`, `claude-code-vault-keeper/server/<x>.js`)
still work via wildcard entries in the `exports` map — but the named
subpaths above are the supported surface. Prefer them in new code.

## Validating a single file

`parseDocument` reads from disk; `validateDocument` is the orchestrator
that wires every rule together.

```js
import { validateDocument } from 'claude-code-vault-keeper';

const result = await validateDocument('docs/notes/note-001-hello.md');

if (!result.valid) {
  for (const err of result.errors) {
    console.error(`[${err.field}] ${err.message}`);
    if (err.fix) console.error(`   fix: ${err.fix}`);
  }
  process.exit(1);
}
```

Result shape:

```ts
{
  filepath: string,
  docType: string,
  valid: boolean,
  skipped?: boolean,             // true for template files
  errors: Issue[],
  warnings: Issue[],
  rulesSource: string | null,    // template path that supplied validation_rules
  frontmatter: {                 // a small projected subset
    template?: string,
    status?: string,
    owner?: string,
  }
}

type Issue = {
  level: 'error' | 'warning',
  field: string,                 // dot-path or synthetic tag
  message: string,
  fix?: string,
  error_type?: string,           // stable machine tag for some errors
};
```

Pass `{projectRoot}` when the file lives outside `process.cwd()`:

```js
await validateDocument('/abs/path/to/vault/notes/foo.md', {
  projectRoot: '/abs/path/to/vault',
});
```

## Validating a whole vault

```js
import {
  findDocuments,
  findAllFiles,
  validateDocument,
  validateSlug,
  resolveProjectRoot,
} from 'claude-code-vault-keeper';

const root = resolveProjectRoot({ root: '/abs/path/to/vault' });
process.chdir(root);
process.env.CLAUDE_PROJECT_DIR = root;  // pin downstream resolvers

const docs = await findDocuments();
const results = await Promise.all(docs.map((d) => validateDocument(d)));

// Asset slug pass (non-markdown files in the vault still must be slugged)
const allFiles = await findAllFiles();
const mdSet = new Set(docs);
for (const f of allFiles) {
  if (mdSet.has(f) || f.endsWith('.md')) continue;
  const issues = validateSlug(f);
  if (issues.length) results.push({ filepath: f, docType: 'asset',
    valid: issues.every((i) => i.level !== 'error'),
    errors: issues.filter((i) => i.level === 'error'),
    warnings: issues.filter((i) => i.level === 'warning'),
    frontmatter: {} });
}

const invalid = results.filter((r) => !r.valid);
console.log(`${results.length - invalid.length}/${results.length} valid`);
```

> `process.chdir(root)` + setting `CLAUDE_PROJECT_DIR` are the same
> rebind that the CLI's `main()` performs — every downstream resolver
> derives paths from cwd / that env var.

## Loading template rules directly

When you want to introspect or report on a template's rules without
running a validation pass:

```js
import { loadTemplateRules } from 'claude-code-vault-keeper';

const rules = await loadTemplateRules('templates/note-template.md', root);

if (!rules) {
  console.error('template missing or has no validation_rules block');
} else {
  console.log('required:', rules.required_fields);
  console.log('path_regex:', rules.path_regex);
  console.log('state machine:', rules.state_machine);
}
```

Returns `null` for any failure (file missing, malformed YAML, no
`validation_rules` block). Cached internally — call as often as you like.

## Applying rules to in-memory frontmatter

`applyRules` is pure — feed it a normalized rules object + a frontmatter
object + the body text, get back an `Issue[]`. Useful for editor
integrations that haven't written the file to disk yet.

```js
import { loadTemplateRules, applyRules } from 'claude-code-vault-keeper';

const rules = await loadTemplateRules('templates/note-template.md', root);
const frontmatter = { template: 'templates/note-template.md', title: 'Hi' };
const body = '## Relationships\n';

const issues = applyRules(rules, frontmatter, body, 'docs/notes/note-001.md');
```

## Validating an unsaved buffer (LSP-style)

`server/validator.js` exposes the per-doc subset of the CLI pipeline,
operating on a string instead of a file path. This is what the LSP uses
on every keystroke.

```js
import { validateBuffer } from 'claude-code-vault-keeper';

const text = `---
template: templates/note-template.md
title: Quick draft
---

## Relationships
`;

const { issues, lineMap, skipped } = await validateBuffer({
  text,
  filepath: 'docs/notes/draft.md',   // repo-relative
  projectRoot: '/abs/path/to/vault',
});
```

Each issue carries a `line` (0-indexed, document-absolute) so editors
can render diagnostics at the right position.

## Parsing the body separately

`parseBody` returns the structured body sections + warnings emitted by
the body parser (the same warnings the LSP surfaces as `field=body`
diagnostics).

```js
import {
  parseBody,
  loadTemplateSectionRules,
} from 'claude-code-vault-keeper';

const sectionRules = await loadTemplateSectionRules(
  'templates/prd-template.md',
  root,
);

const parsed = await parseBody(body, { formatHints: sectionRules });

// Structured body data — pick what you need:
parsed.relationships;       // typed edges from ## Relationships
parsed.acceptanceCriteria;  // AC entities + implementing/verifying refs
parsed.userStories;         // PRD → story refinements
parsed.contributions;       // ## Contributions log
parsed.statusHistory;       // ## Status History rows
parsed.phaseHistory;        // ## Phase History rows
parsed.riceScore;           // RICE Score table
parsed.shipTimeline;        // Ship Timeline + extensions
parsed.derived;             // computed lifecycle timestamps
parsed.warnings;            // body-format diagnostics
```

## Canonical formatting

The same rewrites the CLI applies on `vault-keeper-format` / the LSP
applies on `textDocument/formatting`:

```js
import { formatVaultDocumentAsync } from 'claude-code-vault-keeper';

// Async form: reads the template referenced in `originalText`'s
// frontmatter to learn the canonical section order.
const { formatted, changed } = await formatVaultDocumentAsync(originalText, {
  projectRoot: root,
});
```

The sync `formatVaultDocument(text, { sections })` accepts an explicit
section slug list instead of resolving the template from disk — fast
path when you've already loaded the template rules or only need
frontmatter re-ordering.

## Building a custom reporter

Pure result data → render however you want.

```js
import { validateDocument, findDocuments } from 'claude-code-vault-keeper';

const docs = await findDocuments();
const results = await Promise.all(docs.map((d) => validateDocument(d)));

// Group errors by error_type tag (only some issues carry one)
const byType = new Map();
for (const r of results) {
  for (const err of r.errors) {
    if (!err.error_type) continue;
    const list = byType.get(err.error_type) ?? [];
    list.push({ file: r.filepath, message: err.message });
    byType.set(err.error_type, list);
  }
}

for (const [tag, items] of byType) {
  console.log(`\n== ${tag} (${items.length}) ==`);
  for (const it of items) console.log(`  ${it.file}: ${it.message}`);
}
```

Stable `error_type` tags currently emitted:

| Tag | Where |
|---|---|
| `path-regex-mismatch` | Template `path_regex` did not match the doc path. |
| `path-regex-bad-regex` | Template's `path_regex` does not compile. |
| `bundle-readme-template-mismatch` | Bundle README declared the wrong template (or none). |

## Building a dashboard

`parseBody` + `parseDocument` + `findDocuments` are the right ingredients
for a "what's in my vault?" view. The example below walks every doc and
emits a CSV of status + owner + AC count — feed it into a spreadsheet,
a Markdown report, or a static-site generator.

```js
import {
  findDocuments,
  parseDocument,
  parseBody,
  loadTemplateRules,
  resolveProjectRoot,
} from 'claude-code-vault-keeper';

const root = resolveProjectRoot({ root: '/abs/path/to/vault' });
process.chdir(root);
process.env.CLAUDE_PROJECT_DIR = root;

const docs = await findDocuments();
const rows = [];

for (const filepath of docs) {
  const { frontmatter, body, error } = await parseDocument(filepath);
  if (error) continue;

  // Optional: pull the template's `body_section_formats` so parseBody
  // emits warnings in the same vocabulary the LSP uses.
  const rules = await loadTemplateRules(frontmatter.template, root);
  const parsed = await parseBody(body, {
    formatHints: rules?.body_section_formats,
  });

  rows.push({
    path: filepath,
    template: frontmatter.template ?? '',
    status: frontmatter.status ?? '',
    owner: frontmatter.owner ?? '',
    title: frontmatter.title ?? '',
    relationships: parsed.relationships.length,
    acs: parsed.acceptanceCriteria.length,
    contributions: parsed.contributions.length,
    statusHistoryLen: parsed.statusHistory.length,
    started_at: parsed.derived.started_at,
    shipped_at: parsed.derived.shipped_at,
    warnings: parsed.warnings.length,
  });
}

// Emit CSV (or JSON, or feed into any view layer)
const headers = Object.keys(rows[0]);
console.log(headers.join(','));
for (const r of rows) {
  console.log(headers.map((h) => JSON.stringify(r[h] ?? '')).join(','));
}
```

## Pre-commit script example

```js
#!/usr/bin/env bun
// scripts/vault-precommit.mjs — fail the commit on any vault error.

import { execFileSync } from 'node:child_process';
import {
  validateDocument,
  resolveProjectRoot,
} from 'claude-code-vault-keeper';

const root = resolveProjectRoot();
process.chdir(root);

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  .toString()
  .split('\n')
  .filter((f) => f.endsWith('.md'));

let failed = 0;
for (const f of staged) {
  const r = await validateDocument(f);
  if (r.valid) continue;
  failed++;
  console.error(`\n❌ ${f}`);
  for (const e of r.errors) console.error(`   ${e.field}: ${e.message}`);
}

process.exit(failed > 0 ? 1 : 0);
```

Hook it up in `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
exec bun ./scripts/vault-precommit.mjs
```

## Invoking the CLI from another script

For one-off cases where importing is overkill, the CLI emits a stable
JSON shape with `--json`:

```bash
bun cli/validate-documents.js --root /path/to/vault --json
```

```js
import { execFileSync } from 'node:child_process';

const out = execFileSync('bun', [
  'cli/validate-documents.js',
  '--root', '/path/to/vault',
  '--json',
], { cwd: '/path/to/claude-code-vault-keeper', encoding: 'utf-8' });

const { summary, results } = JSON.parse(out);
console.log(`invalid: ${summary.invalid}, warnings: ${summary.warningCount}`);
```

`results[].filepath`, `.valid`, `.errors[]`, `.warnings[]` mirror the
in-process API exactly. Exit code is `1` on any invalid doc (or any
warning when `--strict` is passed), `0` otherwise.

## See also

- [CLI validator](cli-validator.md) — every flag the orchestrator
  accepts when invoked directly.
- [Architecture](architecture.md) — module-by-module data flow.
- [Vault config](vault-config.md) — what `loadVaultConfig` returns.
- [Templates / Frontmatter rules](templates/frontmatter-rules.md) —
  the `validation_rules` vocabulary `applyRules` enforces.
