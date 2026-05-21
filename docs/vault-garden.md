# vault-garden — gardener-style vault maintenance

`/vault.health` answers *"is anything broken?"* `/vault.garden` answers *"how
chaotic is the vault, and what should I prune?"*

## Mental model

A vault is alive. It grows (new notes), it decays (stale notes, drifted
frontmatter), and it gives off signals about what it wants to become (the
same field showing up in 30/45 daily-notes is the vault asking for a template
update). Like a garden, it benefits from regular pruning. Without that, drift
accumulates silently and the queries on top of it quietly lie.

The engine measures four dimensions:

| Dimension | What it catches | Examples |
|-----------|-----------------|----------|
| **Schema drift** | Frontmatter values deviating from the template | `status: WIP` when allowed is `[draft, review, done]` |
| **Vocab drift** | Near-duplicate tags / wiki-link targets | `#book` vs `#books`, `[[Atomic Habits]]` vs `[[atomic-habits]]` |
| **Lifecycle decay** | Stale / orphan / zombie docs | Note untouched 200 days, status stuck `in-progress` 90 days |
| **Distribution health** | Pareto / Gini + frontmatter compression | 1 template carries 95% of notes; 12 docs with frontmatter no template references |
| **Pattern emergence** *(informational)* | Repeated non-template patterns | 30 notes added `mood:` — vault is asking for a template field |

## CLI

```
vault-keeper entropy                 # measure + write snapshot + print human report
vault-keeper entropy --json          # measure + snapshot + JSON to stdout
vault-keeper entropy --no-snapshot   # measure only, do not persist
vault-keeper entropy --diff          # compare latest vs previous snapshot
vault-keeper entropy --history       # list snapshots
```

Exit code is always 0 on successful measurement. Entropy is a gradient — gate
CI on `JSON.overall_score < threshold`, not on the exit code.

## Skill

`/vault.garden` runs the closed loop:

1. **Measure** — calls the CLI.
2. **Suggest** — proposes 5 kinds of action: **prune** (archive stale), **graft** (merge tag/link duplicates), **promote** (add emergent pattern to template), **retire** (remove unused template), **compost** (un-stick zombie statuses).
3. **Approve** — per-batch, grouped by verb, most reversible first.
4. **Execute** — delegates deterministic edits to `/vault.fix`, performs semantic edits directly.
5. **Remeasure** — confirms entropy dropped, renders the delta.

The skill does NOT auto-commit, push, or delete documents. `prune` archives to `<vault>/archive/<YYYY>/`.

## Configuration

Everything lives under `entropy:` in `.claude/vault-keeper.json`:

```json
{
  "vaultFolders": ["notes"],
  "entropy": {
    "weights": { "schema": 0.30, "vocab": 0.25, "lifecycle": 0.30, "distribution": 0.15 },
    "vocab":   { "distance_threshold": 0.2 },
    "lifecycle": {
      "default": {
        "stale_after_days": 90,
        "zombie_after_days": 30,
        "orphan_grace_days": 14,
        "zombie_status_set": ["in-progress", "draft", "wip"]
      },
      "perTemplate": {
        "templates/daily-note.md":    { "stale_after_days": 7 },
        "templates/book-template.md": { "stale_after_days": 365 }
      }
    },
    "emergence": { "candidate_threshold": 0.30, "min_template_docs": 10 }
  }
}
```

All fields optional; sensible defaults are baked into `lib/entropy/defaults.js`.

## Health flags

`EntropyReport.health_flags` carries alarms that don't move dimension scores
but that the gardener needs to see. The plugin populates the alarm; the
gardener decides what to do.

| Flag | Trigger | What to do |
|------|---------|------------|
| `missing_templates: string[]` | A doc's `template:` field points to a file that doesn't exist or fails to load | Either restore the template, or update the doc's `template:` to a valid path |

A vault with broken refs would otherwise score 100 (schema-drift sees no
template; distribution counts the doc as templated). `health_flags` makes
the broken state visible. Sorted ascending, deduped.

## Snapshots

Each run writes `<vault>/.vault-keeper/snapshots/<ISO-timestamp>.json` plus a
`latest.json` copy. The plugin does not auto-modify `.gitignore`; the
suggestion is to track snapshots in git so the antifragility story is
auditable.
