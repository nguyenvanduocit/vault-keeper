# Example vault

A self-contained, self-validating reference vault that doubles as the test
dataset for `claude-code-vault-keeper`. Every rule kind a template can declare
is exercised by at least one valid + one invalid instance under `docs/`.

This `CLAUDE.md` exists so `resolveProjectRoot()`'s walk-up can pin this
directory as the vault root when the validator is invoked without `--root`.
