# Claude Code skills

`claude-code-vault-keeper` ships seven Claude Code skills. Each is a verb the user types in a Claude session; together they cover the full vault lifecycle without leaving the editor.

## The skills

| Verb | What it does |
|---|---|
| [`/vault.setup`](vault.setup/SKILL.md) | Interview-driven vault onboarding. Scaffolds `.claude/vault-keeper.json` + per-type templates, then validates. |
| [`/vault.new <type> [slug]`](vault.new/SKILL.md) | Scaffolds a new doc from `templates/<type>-template.md` with frontmatter placeholders derived from `validation_rules`. |
| [`/vault.health`](vault.health/SKILL.md) | Read-only digest of `vault-keeper doctor --json` + `vault-keeper validate --json`. Groups violations by template, folder, rule kind. |
| [`/vault.fix`](vault.fix/SKILL.md) | Deterministic auto-format: frontmatter key order, section order, AC/relationship normalization, whitespace. Never invents values. |
| [`/vault.changelog`](vault.changelog/SKILL.md) | Read-only remote changelog: `git fetch` → ahead/behind summary → what's new on `origin/<branch>` (vault-scoped) → recent activity, most-touched docs, top contributors. Never merges. |
| [`/vault.sync`](vault.sync/SKILL.md) | Validate-then-push: refuses to push if validate fails; otherwise stash → pull --rebase → restore → commit → push. |
| [`/vault.monitor-git-sync`](vault.monitor-git-sync/SKILL.md) | Passive background watcher; auto-fast-forwards `origin/<branch>` into local, notifies only on conflict. |

## Composition

```
/vault.setup     ─→ create vault                      (once per repo)
/vault.new       ─→ create individual doc             (daily)
/vault.health    ─→ check what's broken               (daily)
/vault.fix       ─→ apply deterministic auto-fixes    (daily)
/vault.changelog ─→ preview what's new on remote      (daily, read-only)
/vault.sync      ─→ commit + push                     (daily)
/vault.monitor-git-sync → keep main in sync           (always-on watcher)
```

## Plugin invariants

Per the project's [authoring principle](../CLAUDE.md), every skill is **vault-agnostic** — no skill hardcodes a field name, template name, or path prefix. All vault-specific logic comes from the `validation_rules` block of a template, read at runtime.

## See also

- [Templates](../docs/templates/README.md) — the rule vocabulary the skills enforce.
- [Programmatic usage](../docs/programmatic-usage.md) — the public API the skills invoke under the hood.
