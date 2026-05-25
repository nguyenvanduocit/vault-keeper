---
name: vault.garden
description: "Gardener-style vault maintenance — runs `vault-keeper entropy --json` to measure 4 chaos dimensions (schema drift, vocab drift, lifecycle decay, distribution health), surfaces emergence patterns, proposes context-aware pruning actions, applies per-batch with approval, remeasures to confirm entropy dropped. Closed loop. Modifies files (performs all edits directly via the Edit tool). Use when user says 'cắt tỉa vault', 'garden vault', 'prune vault', 'vault health gradient', 'vault entropy', 'cleanup drift', '/vault.garden'."
---

# vault.garden — gardener-style vault maintenance

A closed-loop session that measures vault entropy, proposes pruning actions, applies the approved ones, and remeasures to confirm entropy dropped. Distinct from `/vault.health` (binary read-only validator) — this skill modifies files.

## Pre-flight (silent)

1. Resolve project root: `${CLAUDE_PROJECT_DIR:-$PWD}`.
2. Confirm `vault-keeper` is on `$PATH`. If missing, print install instructions from `README.md` and exit.
3. Check git status inside the vault folders. If there are uncommitted changes in any vault folder, **block and ask**: *"Vault has uncommitted changes. Commit them first so rollback during this garden session is unambiguous. Continue anyway? (y/N)"* — default N.
4. Uncommitted changes OUTSIDE the vault folders → warn, do not block.

## Phase 1 — Measure

Run:

`vault-keeper entropy --json --root "${CLAUDE_PROJECT_DIR:-$PWD}"`

Capture stdout as `EntropyReport`. If exit ≠ 0, surface stderr and stop. Do NOT retry.

Render baseline summary (≤ 8 lines):

```
vault.garden — <project-root>
Snapshot: <measured_at> (git: <short>)

Overall health: <score>/100
  Schema drift     <s>  <verdict>
  Vocab drift      <s>  <verdict>
  Lifecycle decay  <s>  <verdict>
  Distribution     <s>  <verdict>
  Pattern garden   <N> candidates emerging

<total_docs> docs · <total_templates> templates · scan <ms>ms
```

Verdict bands: ≥80 = ✓ healthy, 60–79 = ⚠ moderate, <60 = ✗ degraded.

## Phase 2 — Suggest

Generate pruning proposals from the report. Use 5 action verbs:

| Verb | Source signal | Confidence | Reversibility |
|------|---------------|------------|---------------|
| **prune** | `lifecycle.stale_docs` with 0 incoming links | high | reversible (archive move) |
| **graft** | `vocab.tag_clusters` / `vocab.link_clusters` | medium | reversible (find/replace) |
| **promote** | `emergence.field_candidates` / `section_candidates` | low | reversible via git |
| **retire** | template usage = 0 docs (from `distribution.template_usage.counts`) | medium | reversible via git |
| **compost** | `lifecycle.zombie_docs` | high | reversible (status edit) |

**Sample concrete notes only when needed.** For graft proposals you typically need no samples (the cluster already lists members). For promote proposals, Read 3–5 representative docs to pick a primitive (enum vs string).

Internal proposal shape (do not show user yet):

```json
{
  "id": "g1",
  "verb": "graft",
  "scope": "vocab",
  "summary": "Merge #OLAP + #olap → #olap (45 uses across 12 files)",
  "evidence": { "...": "..." },
  "actions": [ { "kind": "find_replace_tag", "from": "#OLAP", "to": "#olap", "files_affected": 12 } ],
  "confidence": 0.92,
  "reversibility": "reversible",
  "delegated_to": "skill_direct"
}
```

## Phase 3 — Approve (batched per verb)

Present batches in this order (most reversible first):

1. **prune** (move to `<vault>/archive/<YYYY>/`)
2. **compost** (status field edit)
3. **graft** (find/replace tag or link)
4. **promote** (template edit)
5. **retire** (template delete — requires no orphan docs)

Per batch prompt:

```
━━━ Batch <i>/<n>: <VERB> (<count> proposals, <reversibility>) ━━━
1. <summary>
2. <summary>
...

Approve: [a]ll · [n]one · [s]elect individual · [d]iff first · [q]uit garden
```

- `[a]` → apply all proposals in this batch.
- `[s]` → list numbered proposals; user enters comma-separated indices.
- `[d]` → render a concrete diff per proposal, then re-ask.
- `[n]` → skip the whole batch.
- `[q]` → abort the session; applied batches stay, no remeasure runs.

## Phase 4 — Execute

All proposals run via `delegated_to: "skill_direct"` — use the `Edit` /
`Write` tool directly. Examples:

  - **prune** → move file to `<vault>/archive/<YYYY>/<basename>`.
  - **graft** → find-replace the canonical-vs-variant in body / frontmatter across the listed files.
  - **promote** → edit the template file's `fields:` block (add an optional entry).
  - **retire** → delete the template file (already confirmed zero usage).
  - **compost** → edit the doc's `status:` field.

Actions inside a batch run **serially**, not in parallel — one action may produce a file the next reads.

**Failure handling:** on any action failure within a batch, stop the batch, render the error, ask `[c]ontinue · [r]ollback batch · [q]uit`. Rollback uses the session log at `.vault-keeper/garden-session-<sessionId>.log` plus `git checkout -- <files>`. The pre-flight clean-vault check makes rollback safe.

## Phase 5 — Remeasure

Re-run:

`vault-keeper entropy --json --root "${CLAUDE_PROJECT_DIR:-$PWD}"`

A new snapshot is written automatically. Compute the delta vs the baseline (Phase 1) using `diffSnapshots` semantics and render:

```
━━━ Session result ━━━
Duration: <m>m <s>s
Actions applied: <N> (graft: a, compost: b, prune: c, promote: d, retire: e)

Score:     <before> → <after>  (<signed-delta>)
  Schema:    <b> → <a>  (<signed>)
  Vocab:     <b> → <a>  (<signed>)
  Lifecycle: <b> → <a>  (<signed>)
  Distribution: <b> → <a>  (<signed>)

Pattern garden:
  resolved: <list>
  still pending: <list>

Snapshot saved: .vault-keeper/snapshots/<filename>
Next session suggested: when score < <baseline> (currently <after>)
```

## Termination

Session ends on any of:
1. User `[q]uit` at any batch.
2. All 5 batches processed (approved or skipped).
3. Hard limit 50 actions/session.
4. Phase 4 failure with user choosing `[q]uit`.

The session does NOT auto-loop. Gardening pruning has diminishing return per session — cadence is the user's call.

## What this skill does NOT do

- Does NOT auto-commit. Suggest a commit message at the end; the user decides.
- Does NOT push.
- Does NOT edit template `fields:` without going through the `promote` verb.
- Does NOT delete documents — `prune` archives them.
- Does NOT edit `.claude/vault-keeper.json` (config belongs to the user).

## Exit contract

Last line is one of:
- `vault.garden: <N> actions applied, score <before> → <after>.`
- `vault.garden: session aborted, <N> actions applied, score <before> → <after>.` (after `[q]`)
- `vault.garden: 0 actions applied, no changes (baseline score <X>).`
