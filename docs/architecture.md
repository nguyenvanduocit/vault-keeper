# Architecture

A 30,000-foot view of how the plugin is wired internally — useful when
you need to extend it or trace a bug back to its source.

## Module map

```
claude-code-vault-keeper/
├── .claude-plugin/
│   ├── plugin.json              # Plugin manifest
│   └── marketplace.json         # Marketplace entry
├── .lsp.json                    # LSP server config (Claude Code reads this)
├── package.json                 # `bin: vault-keeper`, exports, scripts, deps
│
├── server/                      # LSP runtime (editor side)
│   ├── main.bundled.cjs         #   SHIPPED ARTIFACT — self-contained ~1.5 MB bundle
│   ├── main.js                  #   LSP lifecycle + handler wiring
│   ├── validator.js             #   Per-doc validation pipeline (no FS scan)
│   ├── diagnostics.js           #   validator issue → LSP Diagnostic
│   ├── vault-index.js           #   Lazy vault index (search, backlinks, frontmatter cache)
│   ├── position-context.js      #   Cursor position → semantic element classifier
│   ├── frontmatter-lines.js     #   YAML dot-path → 0-indexed source line
│   ├── providers/               #   Per-operation LSP providers
│   │   ├── completion.js
│   │   ├── code-action.js
│   │   ├── code-lens.js
│   │   ├── rename.js
│   │   └── document-formatting.js
│   └── smoke.js                 #   End-to-end LSP regression test
│
├── lib/                         # Shared parsing / loading (LSP + CLI)
│   ├── schema-engine.js         #   Public schema-engine barrel
│   ├── primitives/              #   Runtime primitive specs + registry
│   ├── meta/                    #   Template meta-validation
│   ├── apply/                   #   Field/body schema application
│   ├── helpers/                 #   Issue, constraint, and heading helpers
│   ├── body-shapes.js           #   Generic markdown shape parsers
│   ├── expression-eval.js       #   Formula expression evaluator
│   ├── canonical-formatter.js   #   Document formatter
│   ├── conditional-eval.js      #   DSL evaluator (`field in [...]`)
│   ├── doc-io.js                #   parseDocument + resolveDocPath
│   ├── template-rules.js        #   Load template schema (fields, bodySchema, etc.)
│   ├── template-section-rules.js#   Parse per-section yaml section-rules fences
│   ├── utils.js                 #   deepFreeze
│   ├── validators.js            #   Pure validators (template field, naming, slug)
│   ├── vault-config.js          #   .claude/vault-keeper.json loader
│   └── index.js                 #   Public API barrel
│
├── cli/
│   └── validate-documents.js    #   Full-vault validator (the `bin` entry)
│
├── examples/example/            # Runnable reference vault + test dataset
├── tests/                       # Bun test suite
└── docs/                        # ← you are here
```

## Two entry points, one core

| Entry | What it spawns | Validates from |
|---|---|---|
| **LSP** | `node server/main.bundled.cjs --stdio` (via `.lsp.json`) | Editor buffer (may be unsaved) |
| **CLI** | `bun cli/validate-documents.js` | Files on disk |

Both entry points share the same document-level contract:

1. Parse frontmatter and markdown body.
2. Run cross-cutting validators that do not need the whole vault.
3. Load the referenced template.
4. Apply frontmatter schema.
5. Apply body schema.
6. Return `Issue[]` objects with stable `error_type` values.

The CLI additionally runs vault-wide checks:

- Cross-document orphan detection (incoming-link graph).
- Asset slug pass (non-markdown files).
- Bundle README re-include scan.

The LSP intentionally omits those — they need a full-vault scan and
would freeze the editor on every keystroke.

## Data flow

### LSP path (per-keystroke)

```
Editor buffer (unsaved markdown)
        │
        ▼
server/main.js (textDocument/didChange + 250 ms debounce)
        │  isVaultFile(repoPath) gate
        ▼
server/validator.js
        ├── gray-matter ──→ frontmatter, body
        ├── lib/validators.js
        │     ├── validateTemplateField
        │     ├── validateTemplateMetaLeak
        │     ├── validateSlug
        │     ├── validatePaths
        │     └── validateSectionRulesLeak
        ├── lib/template-rules.js loadTemplateRules
        │     └─→ { fields, strict, sections, tier, bodySchema }
        ├── lib/apply/field-schema.js applyFieldSchema
        │     └─→ frontmatter issues (type, enum, pattern, required, min/max, ...)
        ├── lib/apply/body-schema.js applyBodySchema
        │     └─→ body issues (required sections, heading match, table/list/code/formula)
        └─── issues[]
                │
                ▼
        server/diagnostics.js issuesToDiagnostics
                │
                ▼
        Editor (textDocument/publishDiagnostics)
```

### CLI path (full-vault)

```
process.argv (--root, --path, --strict, --json)
        │
        ▼
cli/validate-documents.js#main
        │  resolveProjectRoot + chdir
        ├── lib/vault-config.js loadVaultConfig
        │     └── vaultRoot, vaultFolders, excludePatterns
        ├── findDocuments(target) ──→ markdown file list
        │       └── findBundleReadmes (bundle re-include scan)
        ├── for each doc:
        │     └── validateDocument(filepath)
        │             ├── lib/doc-io.js parseDocument
        │             ├── lib/validators.js (template field, leak, slug, paths)
        │             ├── lib/template-rules.js loadTemplateRules
        │             ├── lib/apply/field-schema.js applyFieldSchema
        │             │     └── composable field primitives
        │             ├── lib/apply/body-schema.js applyBodySchema
        │             │     └── body section-rules validation
        │             └── $path pattern check (via applyFieldSchema)
        ├── findAllFiles(target) ──→ asset slug pass (non-md)
        │
        └── generateSummary → printResults (banner) OR JSON.stringify
                │
                ▼
        stdout + exit 0/1
```

## Module-by-module reference

### `lib/schema-engine.js`

The public schema-engine barrel. It preserves the historic
`claude-code-vault-keeper/schema-engine` import surface while the
implementation lives in smaller modules.

Exports:

- `PRIMITIVES` from `lib/primitives/index.js`.
- `SYNTHETIC_RESOLVERS` from `lib/apply/synthetic.js`.
- `applyFieldSchema` from `lib/apply/field-schema.js`.
- `applyBodySchema` from `lib/apply/body-schema.js`.
- `validateTemplateSchema` from `lib/meta/field-schema.js`.
- `validateBodyTemplateSchema` from `lib/meta/body-schema.js`.

Do not put new engine logic in this file. It should stay a compatibility
barrel; implementation belongs in `primitives/`, `apply/`, `meta/`, or
`helpers/`.

### `lib/primitives/*`

Runtime primitive implementations and their template-time shape metadata.
`lib/primitives/index.js` is the canonical registry for primitive ordering
and public helper exports. Each primitive module owns its own validation
function and, where needed, inner-key allow-lists used by meta-validation.

Primitive modules should stay domain-neutral. They may know about generic
shapes such as strings, arrays, headings, tables, lists, code fences, dates,
and arithmetic expressions. They should not know about PRDs, decisions,
tasks, owners, statuses, or project-specific workflow states. Those belong in
templates.

Current primitive ownership:

| Module | Owns |
|---|---|
| `scalar.js` | `type`, `required`, `enum`, `pattern`, `min`, `max`, `uniqueItems`, `exists`, `description` |
| `chronological.js` | `time` / `datetime` helpers plus `before` and `after` |
| `heading.js` | Heading text `pattern` / `enum` checks |
| `table.js` | Table columns, row cardinality, strict headers, per-cell values |
| `list.js` | List cardinality, uniqueness, per-item required/pattern/enum |
| `code.js` | Code fence language, count, and content pattern checks |
| `formula.js` | Formula expression evaluation against supplied values |
| `repeatable.js` | Marker primitive for repeatable section schemas |

`PRIMITIVES` order is intentional. Diagnostic ordering tests and example-vault
expectations depend on JavaScript object insertion order, so append or move
entries deliberately.

### `lib/apply/*`

Schema application orchestrators:

- `field-schema.js` walks a template `fields:` block, resolves synthetic
  `$` fields, evaluates `when` gates, applies primitive constraints, and
  enforces strict undeclared-field checks.
- `body-schema.js` matches the parsed template heading tree against a
  document body, handles repeatable section cardinality, and dispatches to
  structural primitives (`heading`, `table`, `list`, `code`, `formula`).
- `synthetic.js` owns synthetic field resolvers such as `$path`.

`apply/` code is responsible for orchestration, not primitive semantics. For
example, `body-schema.js` decides which section a `table` rule applies to;
`primitives/table.js` decides whether that table satisfies its declared
columns and values.

Important field-schema rules:

- Missing optional values skip the remaining constraints for that field.
- `required` runs before all other primitives and short-circuits on missing
  values.
- Expanded constraints can use `value`, `when`, `severity`, and `message`.
- `when` expressions are evaluated against document frontmatter.
- Strict mode reports every undeclared top-level frontmatter key.

Important body-schema rules:

- A single H1 wrapper in both template and document is unwrapped so template
  title text does not have to match document title text.
- Non-repeatable sections match by normalized heading text at the same depth.
- Repeatable sections claim every unclaimed document heading at that depth
  within the matched parent.
- `required` may be conditional through the same `when` DSL used by
  frontmatter fields.
- Body diagnostics carry heading paths in `field` and, when available,
  body-relative line anchors in `bodyLine`.

### `lib/meta/*`

Template meta-validation:

- `field-schema.js` validates malformed `fields:` declarations before
  documents use them.
- `body-schema.js` validates malformed `section-rules` blocks.
- `allowed-keys.js` owns the top-level body section-rules key set.

Meta-validation catches template authoring errors before runtime validation
tries to apply them. This is where unknown primitive names, bad regexes,
invalid enum shapes, invalid `when` expressions, bad formula expressions, and
unknown nested section-rule keys become `template-schema-invalid` issues.

The meta layer should report structured issues and continue walking. It should
not throw for normal template mistakes.

### `lib/body-shapes.js`

Generic markdown shape parsers — pure infrastructure, zero section-type
knowledge. Builds the heading tree and extracts tables, lists, and code
fences.

- `parseHeadingTree(markdownBody)` — returns a virtual root HeadingNode
  (depth 0) with nested children.
- `parseTable(node)` — GFM table AST node -> `{ headers, rows, line }`.
- `parseList(node)` — list AST node -> `{ items: [{ text, line }] }`.
- `findCodeFences(contentNodes)` — code fences from content nodes.

### `lib/expression-eval.js`

Formula expression evaluator for the `formula` body primitive. Supports
arithmetic (`+`, `-`, `*`, `/`), comparison (`==`, `!=`, `<`, `>`,
`<=`, `>=`), parenthesized sub-expressions, unary minus. Identifiers
resolve from a values object. Equality uses epsilon `1e-9`.

- `evaluate(expression, values)` — evaluate and return result.
- `parse(expression)` — parse into AST (for meta-validation).

### `lib/vault-config.js`

The config primitive. One function (`loadVaultConfig(projectRoot)`) + a
project-root resolver (`resolveProjectRoot(opts)`). Returns a frozen
object cached per process keyed by the resolved config path.

Owns: `.claude/vault-keeper.json` parsing, defaults, walk-up root
resolution.

### `lib/template-rules.js`

`loadTemplateRules(templatePath, projectRoot)` reads a template's
frontmatter via `gray-matter`, extracts `fields:`, `strict:`,
`sections:`, `tier:`, parses the body into a `BodySchemaNode[]` tree,
runs meta-validation on both fields and body schema, and returns the
complete schema object or `null`.

Returns: `{ fields, strict, sections, tier, bodySchema, templateErrors }`.

This module is the boundary between authored markdown templates and the
runtime schema engine. If template loading fails because the file is missing
or frontmatter YAML is malformed, it returns `null`. If the template loads but
declares an invalid schema, it returns a schema object with
`templateErrors`.

### `lib/template-section-rules.js`

Walks a template body's markdown AST via `parseHeadingTree`, finds
each heading's `yaml section-rules` code block, parses it.

- `parseBodySchema(templateBodyMarkdown)` — returns `BodySchemaNode[]`.
- `findSectionRuleBlocks(markdownBody)` — returns `{line}[]` for leak
  detection in authored documents.

### `lib/conditional-eval.js`

A hand-rolled recursive-descent parser + evaluator for the `when` DSL.

- `evaluate(expression, context)` — evaluate against frontmatter.
- `getField(obj, path)` — resolve a dot-path on an object.

### `lib/validators.js`

The pure-validator surface (no I/O). Each function takes a
frontmatter object + filepath and returns an `Issue[]`:

- `validateTemplateField` — template field shape.
- `validateTemplateMetaLeak` — template-only keys leaked into instances.
- `validateSlug` — folder + file slug rule.
- `validatePaths` — relative paths in frontmatter / body.
- `validateSectionRulesLeak` — section-rules fences in documents.

Also owns the `CONFIG` object that exposes
`contentFolders` / `excludePatterns` / `slug` / `templateOnlyFields`
via lazy getters tied to `loadVaultConfig()`.

### `lib/canonical-formatter.js`

Pure document formatter. Takes raw text + optional `sections[]`
ordering, applies frontmatter reordering, section reordering,
whitespace cleanup. Idempotent.

### `lib/doc-io.js`

Two helpers: `parseDocument(filepath)` (reads file, returns
`{ frontmatter, body, filepath, error? }`) and `resolveDocPath
(linkPath)` (normalizes a relationship `link.path` value to a graph
key, stripping URLs / code refs / anchor fragments).

### `cli/validate-documents.js`

The CLI entry point. Orchestrates the full-vault scan:

1. Resolve project root + chdir.
2. Build the document list (`findDocuments` + bundle re-include).
3. Validate each document via `validateDocument`.
4. Asset slug pass.
5. Emit results (banner or JSON).
6. Exit 0/1 based on `--strict` semantics.

Re-exports the pure validators so tests can import them from a single
location.

### `server/main.js`

LSP lifecycle. On `initialize`:

1. Resolve project root from `workspaceFolders` / `rootUri` /
   `rootPath` / cwd (requires `templates/` directory OR
   `.claude/vault-keeper.json` marker).
2. Load `vault-keeper.json` for this root.
3. Create `VaultIndex`.
4. Register every provider.

On each document event (`didOpen` / `didChange` / `didSave`):

1. `isVaultFile(filepath)` gate (relative-path membership in
   `vaultFolders`).
2. Call `validateBuffer({ text, filepath, projectRoot })`.
3. Convert issues to LSP diagnostics + publish.

### `server/validator.js`

Per-document pipeline that mirrors the CLI's per-doc subset. Operates
on in-memory text (the buffer may be unsaved). Excludes cross-doc
rules.

Use this path for editor-like integrations where the source of truth is a
buffer string. Use `validateDocument` from the CLI orchestrator for disk-backed
validation.

### `server/vault-index.js`

Lazy + incrementally-refreshed index of every vault document. Powers
workspaceSymbol, definition (id-resolution), references (backlinks),
and the cached frontmatter previews shown by hover.

Built on first cross-doc request; refreshed per-file on `didSave`.

### `server/providers/*`

One module per LSP operation. Each exports a static `capability`
declaration plus a `register({ connection, docs, vaultIndex,
projectRoot })` function. Providers are independent — a failure in one
doesn't crash the server.

Notable changes:
- `code-lens.js` — provides a backlink count + last-updated lens above
  `template:`. Domain-specific body lenses (AC, Ship Timeline, Decision
  Log) have been removed.
- `completion.js` — provides link-target, heading-anchor, template-path,
  and generic enum completions (driven by the template's `fields:`
  schema).

### `server/diagnostics.js`

Converts validator `Issue` objects to LSP `Diagnostic` objects.
Resolves line numbers (explicit `issue.line` -> frontmatter line-map
-> line 0). Narrows the range to the field's key span when locatable.

### `server/frontmatter-lines.js`

Maps a YAML frontmatter dot-path (e.g. `metadata.author`) to a
0-indexed source line. Used by `diagnostics.js` to position
field-level diagnostics correctly.

## The bundle

`server/main.bundled.cjs` is a self-contained CommonJS bundle built by
esbuild:

```
esbuild server/main.js --bundle --platform=node --format=cjs --outfile=server/main.bundled.cjs
```

The bundle inlines every runtime dep (gray-matter, remark-parse,
remark-gfm, etc.) so the LSP runs in Claude Code's plugin cache with
no `bun install` needed.

The CLI uses raw imports + `node_modules` because it runs from the
plugin repo (not the cache).

Rebuild via `bun run build`. Smoke test via `bun run smoke`
(bundled) or `bun run smoke:source` (source).

## Extension points

If you need to add a new rule, follow the order:

1. **Define the rule shape** — add a field to a template's `fields:`
   block, or add a key to a section-rules code fence.
2. **If the primitive is brand new**, add it to the `PRIMITIVES`
   registry in `lib/primitives/index.js`. Put the implementation in a
   focused `lib/primitives/<name>.js` module. The runtime primitive must
   expose a pure function `(value, param, ctx) => Issue[]`.
3. **For body-level primitives**, add the key to `SECTION_RULES_KEYS`
   in `lib/meta/allowed-keys.js`, add any inner-key allow-lists to the
   primitive module, and dispatch it from `lib/apply/body-schema.js`.
4. **Surface in the CLI** — usually automatic if enforcement is in
   `applyFieldSchema` or `applyBodySchema`.
5. **Surface in the LSP** — usually automatic via
   `server/validator.js` re-using the schema engine. Rebuild the
   bundle (`bun run build`).
6. **Test** — add unit tests for the primitive + integration tests
   with fixture templates.

Keep the ownership boundaries intact:

- New primitive semantics go in `lib/primitives/<name>.js`.
- New field/body traversal behavior goes in `lib/apply/*`.
- New template authoring checks go in `lib/meta/*`.
- New document-wide checks that do not belong to a template go in
  `lib/validators.js`.
- New full-vault checks belong in `cli/validate-documents.js`, not in the LSP
  path.

Before shipping an engine change, run:

```bash
bun test ./tests
bun run smoke
```

If the change affects `server/main.js` or provider code, rebuild the bundled
server with `bun run build` and include `server/main.bundled.cjs` in the
change.

## See also

- [Templates](templates/README.md) — the configuration surface.
- [CLI validator](cli-validator.md) — invocation + JSON output.
- [LSP features](lsp-features.md) — per-operation reference.
- [Troubleshooting](troubleshooting.md) — common error categories.
