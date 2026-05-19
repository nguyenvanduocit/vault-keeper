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
├── package.json                 # `bin: vault-keeper-validate`, scripts, deps
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
│   │   ├── inlay-hint.js
│   │   ├── rename.js
│   │   └── document-formatting.js
│   └── smoke.js                 #   End-to-end LSP regression test
│
├── lib/                         # Shared parsing / loading (LSP + CLI)
│   ├── body-parser.js           #   Markdown body parser
│   ├── canonical-formatter.js   #   Document formatter
│   ├── conditional-eval.js      #   DSL evaluator (`field in [...]`)
│   ├── doc-io.js                #   parseDocument + resolveDocPath
│   ├── template-rules.js        #   Load + normalize template validation_rules
│   ├── template-section-rules.js#   Parse per-section yaml section-rules fences
│   ├── utils.js                 #   deepFreeze
│   ├── validators.js            #   Pure validators (template field, naming, slug, applyRules)
│   └── vault-config.js          #   .claude/vault-keeper.json loader
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

Both run the **same** per-doc validators. The CLI additionally runs:

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
        │     └── applyRules
        │           (rules from lib/template-rules.js loadTemplateRules)
        ├── lib/body-parser.js parseBody
        │     │
        │     └─── warnings[] ──→ diagnostics
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
        │             ├── lib/validators.js applyRules
        │             │     ├── required_fields
        │             │     ├── field_rules (regex/enum/type/min)
        │             │     ├── conditional_required_fields
        │             │     │     └── lib/conditional-eval.js (DSL)
        │             │     ├── state_machine
        │             │     └── body_section: prefix check
        │             └── validatePathRegex
        ├── findAllFiles(target) ──→ asset slug pass (non-md)
        │
        └── generateSummary → printResults (banner) OR JSON.stringify
                │
                ▼
        stdout + exit 0/1
```

## Module-by-module reference

### `lib/vault-config.js`

The config primitive. One function (`loadVaultConfig(projectRoot)`) + a
project-root resolver (`resolveProjectRoot(opts)`). Returns a frozen
object cached per process keyed by the resolved config path.

Owns: `.claude/vault-keeper.json` parsing, defaults, walk-up root
resolution.

### `lib/template-rules.js`

`loadTemplateRules(templatePath, projectRoot)` reads a template's
frontmatter via `gray-matter`, picks out `validation_rules:`,
normalizes it (defensive copy of each collection), and merges in body
section-rules. Returns `null` if the template can't be loaded.

`normalizeRules(rules)` defines the canonical shape of a rules object —
the contract every downstream consumer relies on.

### `lib/template-section-rules.js`

Walks a template body's markdown AST, finds H2 headings, looks for the
first fenced `yaml section-rules` code block in each section, parses
it. Exports `parseSectionRules(body)` and `loadTemplateSectionRules
(path)`.

`getRequiredSections(sectionRules)` lifts `required: true` flags into
the canonical heading list.

### `lib/conditional-eval.js`

A hand-rolled recursive-descent parser + evaluator for the
`conditional_required_fields[].condition` DSL. Grammar:

```
expr        := or_expr
or_expr     := and_expr ( 'or' and_expr )*
and_expr    := comparison ( 'and' comparison )*
comparison  := field ( 'in' | 'not' 'in' ) list
list        := '[' ( string ( ',' string )* )? ']'
field       := IDENT ( '.' IDENT )*
string      := single-quoted | double-quoted
```

Exports `evaluate(expression, context)` and `getField(obj, path)`.

### `lib/validators.js`

The pure-validator surface (no I/O). Each function takes a
frontmatter object + filepath and returns an `Issue[]`:

- `validateTemplateField` — template field shape.
- `validateTemplateMetaLeak` — template-only keys leaked into instances.
- `validateSlug` — folder + file slug rule.
- `validatePaths` — relative paths in frontmatter / body.
- `applyRules(rules, frontmatter, body, filepath)` — the big one,
  consumes a full `validation_rules` object.

Also owns the `CONFIG` object that exposes
`contentFolders` / `excludePatterns` / `slug` / `templateOnlyFields`
via lazy getters tied to `loadVaultConfig()`.

### `lib/body-parser.js`

The unified body parser. Builds the markdown AST via `unified() +
remarkParse + remarkGfm`, walks top-level children, dispatches on H2
heading text to per-section handlers. Section handlers extract
structured data + emit shape-warnings when bullets/rows don't match the
expected format.

Pure: no FS, no template knowledge. Format hints flow in via
`opts.formatHints`.

### `lib/canonical-formatter.js`

Pure document formatter. Takes raw text + optional `sections[]`
ordering, applies frontmatter reordering, section reordering, AC
heading normalization, relationship bullet normalization, whitespace
cleanup. Idempotent.

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

### `server/vault-index.js`

Lazy + incrementally-refreshed index of every vault document. Powers
workspaceSymbol, definition (id-resolution), references (backlinks),
and the cached frontmatter previews shown by hover / inlay-hint.

Built on first cross-doc request; refreshed per-file on `didSave`.

### `server/providers/*`

One module per LSP operation. Each exports a static `capability`
declaration plus a `register({ connection, docs, vaultIndex,
projectRoot })` function. Providers are independent — a failure in one
doesn't crash the server.

### `server/diagnostics.js`

Converts validator `Issue` objects to LSP `Diagnostic` objects.
Resolves line numbers (explicit `issue.line` → frontmatter line-map
→ line 0). Narrows the range to the field's key span when locatable.

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

1. **Define the rule shape** — add a field to a template's
   `validation_rules` block.
2. **Plumb it through `normalizeRules()`** in `lib/template-rules.js`
   if it's a brand-new field shape. Defensive-copy to keep the
   returned object immutable.
3. **Enforce it generically** in `lib/validators.js#applyRules` (or a
   sibling pure validator). Read the field name dynamically; don't
   hardcode field semantics.
4. **Surface in the CLI** — usually automatic if you put enforcement
   in `applyRules`.
5. **Surface in the LSP** — usually automatic via
   `server/validator.js` re-using `applyRules`. Rebuild the bundle
   (`bun run build`).
6. **Test** — add a unit test in `tests/validate-documents.test.js`
   (pure functions) + an integration test in
   `tests/validate-documents.integration.test.js` (real fixture
   files).

## See also

- [Templates](templates/README.md) — the configuration surface.
- [CLI validator](cli-validator.md) — invocation + JSON output.
- [LSP features](lsp-features.md) — per-operation reference.
- [Troubleshooting](troubleshooting.md) — common error categories.
