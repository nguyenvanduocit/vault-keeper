# CI/CD integration

The CLI validator is a single Bun script that exits non-zero on any
schema violation. Wiring it into a CI pipeline is straightforward.

## The contract

| Stage | Command | Pass | Fail |
|---|---|---|---|
| Install runtime | `bun install --frozen-lockfile` (inside this plugin) | exit 0 | exit ≠ 0 |
| Validate vault | `bun cli/validate-documents.js --root "$VAULT" --strict` | exit 0 | exit 1 |

For machine-readable output use `--json` and pipe through `jq`. See
[cli-validator](cli-validator.md#json-output---json) for the JSON shape.

## Generic Bash runner

The minimal CI step is three lines:

```bash
# Install Bun (one-time per runner; see https://bun.sh for the install script)
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Install plugin runtime deps + validate
cd path/to/claude-code-vault-keeper && bun install --frozen-lockfile
bun cli/validate-documents.js --root "$CI_PROJECT_DIR" --strict
```

The validator never writes anywhere — safe on read-only runners.

## GitHub Actions

`.github/workflows/validate-vault.yml`:

```yaml
name: Validate vault

on:
  pull_request:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      # The plugin may live at the repo root OR nested as a submodule /
      # plugin path. Adjust working-directory accordingly.
      - name: Install plugin runtime deps
        working-directory: ./vendor/claude-code-vault-keeper
        run: bun install --frozen-lockfile

      - name: Validate vault
        run: |
          bun ./vendor/claude-code-vault-keeper/cli/validate-documents.js \
            --root "$GITHUB_WORKSPACE" \
            --strict \
            --json > vault-validation.json

      - name: Upload JSON report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vault-validation
          path: vault-validation.json
```

The validator failing exit-code-1 marks the job red. The
`if: always()` on the artifact upload preserves the JSON even on
failure so you can inspect what broke.

### Posting a PR comment with the failures

Add a step after the validate step (use `if: failure()` so it only runs
when there's something to report):

```yaml
      - name: Comment on PR with failures
        if: failure() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const data = JSON.parse(fs.readFileSync('vault-validation.json'));
            const lines = data.results
              .filter(r => !r.valid)
              .flatMap(r => [
                `### \`${r.filepath}\``,
                ...r.errors.map(e => `- **${e.field}**: ${e.message}`)
              ]);
            const body = `## Vault validation failed (${data.summary.errorCount} errors)\n\n${lines.join('\n')}`;
            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            });
```

## GitLab CI

`.gitlab-ci.yml`:

```yaml
validate-vault:
  image: oven/bun:latest
  stage: test
  script:
    - cd vendor/claude-code-vault-keeper && bun install --frozen-lockfile && cd ../..
    - bun ./vendor/claude-code-vault-keeper/cli/validate-documents.js
        --root "$CI_PROJECT_DIR"
        --strict
        --json > vault-validation.json
  artifacts:
    when: always
    paths:
      - vault-validation.json
    expire_in: 30 days
```

GitLab honours the script-exit code: any non-zero exit fails the job.

## Pre-commit hook

The validator runs fast enough to use as a pre-commit hook. Two options:

### Option A — only validate changed files

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit (chmod +x)

set -e
CHANGED=$(git diff --cached --name-only --diff-filter=ACM | grep '\.md$' || true)
if [ -z "$CHANGED" ]; then
  exit 0
fi

for f in $CHANGED; do
  bun /path/to/claude-code-vault-keeper/cli/validate-documents.js --path "$f"
done
```

### Option B — full vault scan

Cheaper to reason about (one command, one exit code), slower on huge
vaults:

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit
bun /path/to/claude-code-vault-keeper/cli/validate-documents.js \
  --root "$PWD" --strict
```

### With [pre-commit framework](https://pre-commit.com)

`.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: vault-keeper-validate
        name: vault-keeper-validate
        entry: bash -c 'bun /path/to/claude-code-vault-keeper/cli/validate-documents.js --strict'
        language: system
        pass_filenames: false
        files: '\.md$'
        always_run: true
```

## Patterns

### Gate on zero invalid

```bash
bun cli/validate-documents.js --root . --json > vault.json
test "$(jq '.summary.invalid' vault.json)" -eq 0
```

### Fail on warnings too

```bash
bun cli/validate-documents.js --root . --strict
```

`--strict` upgrades the exit-code behaviour: any warning becomes a
failure.

### Slice by template

```bash
# Validate only PRDs that broke
bun cli/validate-documents.js --root . --json \
  | jq '
    [.results[]
     | select(.valid == false)
     | select(.frontmatter.template == "templates/prd-template.md")
     | .filepath]
  '
```

### Count by error category

```bash
bun cli/validate-documents.js --root . --json \
  | jq '.summary.commonIssues'
```

Top-N common errors:

```bash
bun cli/validate-documents.js --root . --json \
  | jq '
    .summary.commonIssues
    | to_entries
    | sort_by(.value) | reverse
    | limit(5; .[])
  '
```

### Validate only one section

```bash
bun cli/validate-documents.js --path docs/prds --strict
```

Useful when one team owns a folder and you don't want their drift to
gate the whole vault's CI.

## Performance notes

- A scan of ~500 documents typically completes in <1s on warm Bun.
- Templates are cached for the lifetime of the run — multiple
  instances of the same template type pay parse cost once.
- The body parser is invoked at most once per file.
- `--json` skips the banner rendering so it's marginally faster than
  the human-readable mode.

## Things to NOT do in CI

- Don't run `bun run build` in CI as part of validate gating. The
  bundle is the LSP-side artifact; the CLI doesn't use it.
- Don't run `bun run smoke` in CI as a validation gate — smoke is an
  LSP regression check, separate concern.
- Don't pin to a specific Bun minor version unless you have a
  reproducibility need. The validator uses only the ESM + standard-Node
  API surface.

## See also

- [CLI validator](cli-validator.md) — flags, exit codes, JSON shape.
- [Vault config](vault-config.md) — `--root` resolution.
- [Troubleshooting](troubleshooting.md) — common errors with concrete
  fixes.
