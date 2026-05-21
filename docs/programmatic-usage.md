# Programmatic usage

Beyond the `vault-keeper` CLI and the LSP server, every layer of the
plugin is importable as a plain ES module. Build your own scripts on top
of it — CI gates, bulk-rewrites, custom reporters, editor integrations,
dashboards that surface vault state — without shelling out to the CLI.

All modules are pure ESM (`"type": "module"` in `package.json`); import
them from a Bun or Node >= 18 project that depends on the package.

```bash
bun add claude-code-vault-keeper
# or, against a local checkout:
bun add file:../claude-code-vault-keeper
```

## The barrel

`import` directly from the package name to get the public surface —
parsers, validators, schema engine, formatter, the orchestrator, config
helpers, and the LSP-side per-buffer validator are all re-exported from
one barrel:

```js
import {
  // I/O
  parseDocument, resolveDocPath,

  // Template rules
  loadTemplateRules,

  // Template body parsing
  parseBodySchema, findSectionRuleBlocks,

  // Schema engine (composable validation primitives)
  applyFieldSchema,
  applyBodySchema,
  validateTemplateSchema,
  validateBodyTemplateSchema,

  // Validators (pure)
  CONFIG,
  validateTemplateField,
  validateTemplateMetaLeak,
  validateSlug, validatePaths, validateSectionRulesLeak, suggestSlug,
  stripCodeRegions,
  inferDocType, isTemplateFile, isTemplateInstance, findTemplateMetaLeaks,

  // Formatter
  formatVaultDocument, formatVaultDocumentAsync,

  // Conditional DSL (used by `when` modifiers in field schema)
  evaluateCondition, getField,

  // Vault config
  resolveProjectRoot, loadVaultConfig,

  // Utils
  deepFreeze,

  // Orchestrator (file-walking + per-doc validation)
  validateDocument, findDocuments, findAllFiles,
  runValidateCli,

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
| `claude-code-vault-keeper/doc-io` | `parseDocument`, `resolveDocPath` |
| `claude-code-vault-keeper/template-rules` | `loadTemplateRules` |
| `claude-code-vault-keeper/template-section-rules` | `parseBodySchema`, `findSectionRuleBlocks` |
| `claude-code-vault-keeper/schema-engine` | `applyFieldSchema`, `applyBodySchema`, `validateTemplateSchema`, `validateBodyTemplateSchema` |
| `claude-code-vault-keeper/validators` | `validateTemplateField`, `validateSlug`, `validatePaths`, `validateSectionRulesLeak`, ... `CONFIG` |
| `claude-code-vault-keeper/formatter` | `formatVaultDocument`, `formatVaultDocumentAsync` |
| `claude-code-vault-keeper/conditional-eval` | `evaluate`, `getField` |
| `claude-code-vault-keeper/vault-config` | `resolveProjectRoot`, `loadVaultConfig` |
| `claude-code-vault-keeper/orchestrator` | `validateDocument`, `findDocuments`, `findAllFiles` |
| `claude-code-vault-keeper/lsp-validator` | `validateBuffer` |
| `claude-code-vault-keeper/package.json` | The manifest (read `version` etc.) |

The old `claude-code-vault-keeper/lib/<x>.js` deep-import surface is no
longer exported. Use the package barrel or the named subpaths above for
library code. Wildcard exports remain for `./cli/*` and `./server/*` only
where those entry points are intentionally exposed.

## Import policy

Use the package barrel unless you have a concrete reason to pin to a smaller
subpath. The barrel is the supported public API and carries semver
expectations.

Use subpaths when one of these is true:

- You are writing a small script and want the dependency boundary to be
  obvious (`claude-code-vault-keeper/formatter`, for example).
- You are building an integration that should not import CLI/LSP helpers by
  accident.
- You need `package.json` metadata without importing runtime code.

Avoid `./cli/*` and `./server/*` wildcard paths for new library code. They are
exported for intentional integration points and compatibility, but the stable
library surface is the barrel plus named subpaths in the table above.

The `./schema-engine` subpath is also a barrel. It intentionally hides the
internal split across `lib/primitives/`, `lib/apply/`, and `lib/meta/`.
External code should not depend on those private paths.

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
  rulesSource: string | null,    // template path that supplied the schema
  frontmatter: {                 // a small projected subset
    template?: string,
    status?: string,
    owner?: string,
  }
}

type Issue = {
  level: 'error' | 'warning',
  field: string,                 // dot-path, synthetic tag, or heading path
  message: string,
  fix?: string,
  error_type?: string,           // stable machine tag (16 defined types)
  bodyLine?: number,             // 1-indexed body-relative line (body issues only)
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

## Loading template rules directly

When you want to introspect or report on a template's schema without
running a validation pass:

```js
import { loadTemplateRules } from 'claude-code-vault-keeper';

const schema = await loadTemplateRules('templates/note-template.md', root);

if (!schema) {
  console.error('template missing or has malformed frontmatter');
} else {
  console.log('fields:', schema.fields);
  console.log('strict:', schema.strict);
  console.log('sections:', schema.sections);
  console.log('tier:', schema.tier);
  console.log('body schema nodes:', schema.bodySchema.length);
  console.log('template errors:', schema.templateErrors);
}
```

Returns `null` for any failure (file missing, malformed YAML).
Otherwise returns `{ fields, strict, sections, tier, bodySchema,
templateErrors }`.

## Applying the schema engine directly

`applyFieldSchema` and `applyBodySchema` are pure functions — feed
them a schema + data, get back issues. Useful for editor integrations
that haven't written the file to disk yet.

### Frontmatter validation

```js
import { applyFieldSchema } from 'claude-code-vault-keeper';

const schema = { fields: { title: { required: true }, status: { enum: ['draft', 'done'] } } };
const frontmatter = { template: 'templates/note.md', title: 'Hi', status: 'oops' };
const docMeta = { repoRelativePath: 'docs/notes/note-001.md' };

const issues = applyFieldSchema(schema, frontmatter, docMeta);
// → [{ level: 'error', field: 'status', message: "Value 'oops' is not in ...", error_type: 'enum-violation' }]
```

### Body validation

```js
import { applyBodySchema, applyBodySchemaAsync, parseBodySchema } from 'claude-code-vault-keeper';

// parseBodySchema extracts BodySchemaNode[] from a template's markdown body
const bodySchema = parseBodySchema(templateBodyMarkdown);

const bodyIssues = applyBodySchema(bodySchema, documentBodyMarkdown);
// → BodyIssue[] with { level, field, message, error_type, bodyLine? }
```

Use `applyBodySchemaAsync` when templates include async body validators such
as `mermaid:`:

```js
const bodyIssues = await applyBodySchemaAsync(bodySchema, documentBodyMarkdown);
```

### Template meta-validation

```js
import { validateTemplateSchema, validateBodyTemplateSchema } from 'claude-code-vault-keeper';

const fieldErrors = validateTemplateSchema(fieldsSchema);
const bodyErrors = validateBodyTemplateSchema(bodySchema);
// → Issue[] with error_type: 'template-schema-invalid'
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

Pure result data — render however you want.

```js
import { validateDocument, findDocuments } from 'claude-code-vault-keeper';

const docs = await findDocuments();
const results = await Promise.all(docs.map((d) => validateDocument(d)));

// Group errors by error_type tag
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

Stable `error_type` tags (16 types):

| Tag | Trigger |
|---|---|
| `type-mismatch` | Value doesn't match declared `type` |
| `enum-violation` | Value not in `enum` list |
| `pattern-mismatch` | Value doesn't match `pattern` regex |
| `min-violation` | Value/length/count below `min` |
| `max-violation` | Value/length/count above `max` |
| `unique-violation` | Array contains duplicates (`uniqueItems: true`) |
| `required-missing` | Required field or section is missing |
| `exists-missing` | Referenced file does not exist (`exists: true`) |
| `path-mismatch` | Synthetic `$path` pattern failed |
| `undeclared-field` | Frontmatter key not in schema (`strict: true`) |
| `heading-mismatch` | Body heading doesn't match `heading.pattern` or `heading.enum` |
| `table-shape` | Required table missing or missing required columns |
| `list-item` | Required list missing, or item doesn't match `item.pattern` |
| `code-missing` | Required code fence missing or wrong language |
| `formula-violation` | Formula evaluated to `false` or value non-numeric |
| `cardinality` | Repeatable heading count outside `min`/`max` bounds |
| `template-schema-invalid` | The template itself has schema errors |

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
  console.error(`\n${f}`);
  for (const e of r.errors) console.error(`   ${e.field}: ${e.message}`);
}

process.exit(failed > 0 ? 1 : 0);
```

## See also

- [CLI validator](cli-validator.md) — every flag the orchestrator
  accepts when invoked directly.
- [Architecture](architecture.md) — module-by-module data flow.
- [Vault config](vault-config.md) — what `loadVaultConfig` returns.
- [Templates / Frontmatter rules](templates/frontmatter-rules.md) —
  the composable field primitives `applyFieldSchema` enforces.
