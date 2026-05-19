# Programmatic usage

Beyond the `vault-keeper-validate` CLI and the LSP server, every layer of
the plugin is importable as plain ES modules. Build your own scripts on
top of them — CI gates, bulk-rewrites, custom reporters, editor
integrations — without shelling out to the CLI.

All modules are pure ESM (`"type": "module"` in `package.json`); import
them with `import` from a Bun or Node project that points at this repo
(workspace dep, git submodule, npm-link, or `bun install` from a local
path).

```js
// package.json
{
  "dependencies": {
    "vault-keeper": "file:../vault-keeper"
  }
}
```

> File paths shown below are relative to the plugin root. The plugin has
> no `exports` map yet — import each module by its full path
> (e.g. `vault-keeper/lib/template-rules.js`).

## Module map

| Module | Purpose |
|---|---|
| `cli/validate-documents.js` | Orchestrator. `validateDocument` + `findDocuments` + `findAllFiles`. |
| `lib/doc-io.js` | `parseDocument(filepath)` — read a markdown file, return `{frontmatter, body}`. |
| `lib/vault-config.js` | `resolveProjectRoot(opts)` + `loadVaultConfig(root)`. |
| `lib/template-rules.js` | `loadTemplateRules(templatePath, root)` + `normalizeRules(obj)`. |
| `lib/template-section-rules.js` | `parseSectionRules(body)` + `loadTemplateSectionRules(path)`. |
| `lib/body-parser.js` | `parseBody(markdown, {formatHints})` — body section + warning extraction. |
| `lib/canonical-formatter.js` | `formatVaultDocument(text)` + `formatVaultDocumentAsync(text)`. |
| `lib/validators.js` | Pure validators (`validateTemplateField`, `validateSlug`, …) + `applyRules`. |
| `lib/conditional-eval.js` | `evaluate(expression, context)` + `getField(obj, path)`. |
| `server/validator.js` | `validateBuffer({text, filepath, projectRoot})` — in-memory variant. |

## Validating a single file

`parseDocument` reads from disk; `validateDocument` is the orchestrator
that wires every rule together.

```js
import { validateDocument } from 'vault-keeper/cli/validate-documents.js';

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
} from 'vault-keeper/cli/validate-documents.js';
import { resolveProjectRoot } from 'vault-keeper/lib/vault-config.js';

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
import { loadTemplateRules } from 'vault-keeper/lib/template-rules.js';

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
import { loadTemplateRules } from 'vault-keeper/lib/template-rules.js';
import { applyRules } from 'vault-keeper/lib/validators.js';

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
import { validateBuffer } from 'vault-keeper/server/validator.js';

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
import { parseBody } from 'vault-keeper/lib/body-parser.js';
import { loadTemplateSectionRules } from 'vault-keeper/lib/template-section-rules.js';

const sectionRules = await loadTemplateSectionRules(
  'templates/prd-template.md',
  root,
);

const { sections, warnings } = await parseBody(body, {
  formatHints: sectionRules,
});
```

## Canonical formatting

The same rewrites the CLI applies on `vault-keeper-format` / the LSP
applies on `textDocument/formatting`:

```js
import { formatVaultDocumentAsync } from 'vault-keeper/lib/canonical-formatter.js';

const formatted = await formatVaultDocumentAsync(originalText, {
  templatePath: 'templates/note-template.md',
  projectRoot: root,
});
```

The sync `formatVaultDocument(text, opts)` skips body parsing — fast
path when you only need frontmatter re-ordering.

## Building a custom reporter

Pure result data → render however you want.

```js
import { validateDocument, findDocuments } from 'vault-keeper/cli/validate-documents.js';

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

## Pre-commit script example

```js
#!/usr/bin/env bun
// scripts/vault-precommit.mjs — fail the commit on any vault error.

import { execFileSync } from 'node:child_process';
import { validateDocument } from 'vault-keeper/cli/validate-documents.js';
import { resolveProjectRoot } from 'vault-keeper/lib/vault-config.js';

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
], { cwd: '/path/to/vault-keeper', encoding: 'utf-8' });

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
