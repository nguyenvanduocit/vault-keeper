# CLI validator

`cli/validate-documents.js` is the single CLI entry point — usable
interactively or wired into CI/CD. It is exposed via the `bin` field as
`vault-keeper-validate` so it resolves the same way regardless of how the
plugin is installed.

## Runtime

[Bun](https://bun.sh) — the shebang is `#!/usr/bin/env bun`. The validator
does no Bun-only API tricks but the shebang requires Bun on the runner.

## Invocation

Three equivalent ways to invoke it:

```bash
# A. Direct, from the plugin directory
bun cli/validate-documents.js [flags]

# B. Via the npm script shortcut (same as A)
bun run validate
bun run validate:strict
bun run validate:json

# C. Via the bin entry after `bun install`
bun x vault-keeper-validate [flags]
```

## Flags

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--root <path>` | string | resolved root | Pin the vault project root. Bypasses the walk-up resolver. |
| `--path <path>` | string | whole vault | Validate one file or one folder instead of the whole vault. |
| `--strict` | flag | off | Exit `1` on warnings as well as errors (CI gating mode). |
| `--json` | flag | off | Emit the full result as a single JSON document on stdout; suppress the banner / colored output. |

Flags can appear in any order; values for `--root` / `--path` are the
argv slot immediately after the flag.

## Project root resolution

When `--root` is **not** supplied:

1. `CLAUDE_PROJECT_DIR` environment variable.
2. Walk up from `process.cwd()` looking for a `.git/` directory.
3. Walk up again looking for a `.claude/` directory.
4. Walk up again looking for a `CLAUDE.md` file.
5. Fall back to `process.cwd()`.

When `--root` IS supplied, the validator also pins
`CLAUDE_PROJECT_DIR=<resolved-root>` so every downstream resolver agrees
even if your vault is nested inside another git repository.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every document is valid. In `--strict` mode this additionally requires zero warnings. |
| `1` | At least one document is invalid (error-level issue), OR `--strict` saw a warning, OR an unrecoverable error was thrown. |

The validator never writes anywhere outside stdout/stderr — safe to run on
read-only runners.

## Human-readable output

Default output is a banner-style report intended for terminal use:

```
============================================================
VAULT TEMPLATE VALIDATION REPORT
============================================================

📊 SUMMARY
Total Documents: 12
✅ Valid: 11/12 (91.7%)
❌ Invalid: 1
⚠️  Warnings: 3
🚨 Errors: 2

📁 BY DOCUMENT TYPE
✅ note: 8/8 (100.0%)
⚠️ prd: 3/4 (75.0%)

🔍 TOP ISSUES
   2x - title: Missing required field
   1x - owner: Missing required field

❌ INVALID DOCUMENTS (1)

📄 product-knowledge/02-product/prds/prd-007-foo.md
   🚨 title: Missing required field: title
      💡 Fix: Add title to frontmatter
   🚨 owner: Missing required field: owner
      💡 Fix: Add owner to frontmatter

============================================================
```

`Top issues` ranks the five most-common error / warning categories. Each
invalid document gets a per-issue line plus a `💡 Fix` hint pulled from
the rule definition.

## JSON output (`--json`)

`--json` emits a single JSON document on stdout — no banner, no progress
log, nothing else. The format is stable for piping into `jq`, GitHub
Actions step output, or an artifact uploader.

### Shape

```jsonc
{
  "summary": {
    "total": 12,
    "skipped": 0,
    "valid": 11,
    "invalid": 1,
    "errorCount": 2,
    "warningCount": 3,
    "byDocType": {
      "note": { "total": 8, "valid": 8, "invalid": 0 },
      "prd":  { "total": 4, "valid": 3, "invalid": 1 }
    },
    "byFolder": {
      "product-knowledge/02-product": { "total": 4, "valid": 3, "invalid": 1 }
    },
    "commonIssues": {
      "title: Missing required field": 1,
      "owner: Missing required field": 1
    }
  },
  "results": [
    {
      "filepath": "product-knowledge/02-product/prds/prd-007-foo.md",
      "docType": "prd",
      "valid": false,
      "errors": [
        {
          "level": "error",
          "field": "title",
          "message": "Missing required field: title",
          "fix": "Add title to frontmatter"
        }
      ],
      "warnings": [],
      "rulesSource": "templates/prd-template.md",
      "frontmatter": { "template": "templates/prd-template.md", "status": "draft", "owner": null }
    }
    // ... one entry per scanned document
  ]
}
```

### Common patterns

```bash
# Gate CI on zero invalid documents
bun cli/validate-documents.js --root . --json > vault.json
test "$(jq '.summary.invalid' vault.json)" -eq 0

# List every error message
jq '.results[] | select(.valid == false) | .errors[] | .message' vault.json

# Group failure count by template
jq '
  [.results[] | select(.valid == false) | .frontmatter.template]
  | group_by(.) | map({template: .[0], count: length})
' vault.json
```

## Scan scope

By default the CLI scans every markdown file under `vaultFolders` (from
`.claude/vault-keeper.json`, default `["."]`). The full scan includes
**re-included README.md files** when a `README.md` is a bundle-root doc
declared via its own `template:` field.

`--path <file-or-folder>` narrows the scan:

```bash
# Single file
bun cli/validate-documents.js --path docs/notes/note-001-hello.md

# Subfolder
bun cli/validate-documents.js --path docs/notes
```

When `--path` points at a single file, the orphan-detection cross-document
graph is skipped (a single file has no graph context).

## Asset slug pass

After the markdown documents are validated, the CLI runs a second pass
over **non-markdown** files under the same scan scope to enforce slug
naming on assets (PNG, JSON, HTML, etc.). The slug rule is the same as
for markdown filenames — see [naming-conventions](naming-conventions.md).

Issues from the asset pass appear in the results array with
`docType: "asset"`.

## Performance notes

- Template files are loaded once and cached for the rest of the run.
- The body parser is invoked at most once per file (cache is shared with
  cross-document orphan checks).
- A full-vault scan of ~500 docs typically runs in <1 second on warm
  Bun runtime.

## See also

- [Vault config](vault-config.md) — what `vaultRoot` / `vaultFolders` /
  `excludePatterns` control.
- [Templates](templates/README.md) — what the validator enforces.
- [CI/CD integration](ci-cd-integration.md) — wiring this into your
  pipeline.
- [Troubleshooting](troubleshooting.md) — common errors with fixes.
