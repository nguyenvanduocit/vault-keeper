# Vault entropy gardener — design

**Status:** draft, approved through brainstorming on 2026-05-21
**Owner:** `claude-code-vault-keeper`
**Scope:** new CLI subcommand `vault-keeper entropy` + new skill `/vault.garden` + new `lib/entropy/` module + git-tracked entropy snapshots.

---

## 1. Problem & mental model

`/vault.health` (existing) is a **binary** validator: a document either matches its template or it does not. That answers *"is anything broken?"* — it does not answer *"how chaotic is the vault, and what should I prune?"* A vault is alive; it grows, decays, drifts. The right question is gradient, not pass/fail.

The mental model the engine encodes:

1. **Second law of thermodynamics / Shannon entropy.** An unmaintained vault drifts toward higher entropy. Order requires energy input (pruning).
2. **Lehman's laws of software evolution.** Long-lived systems must continuously adapt or quality declines.
3. **Broken Windows.** One sloppy frontmatter signals "no one is watching" and invites more.
4. **Self-organized criticality (Per Bak's sandpile).** Drift accumulates silently, then cascades. Measure continuously.
5. **Andy Matuschak / Maggie Appleton digital garden.** Notes have a lifecycle (seed → sapling → evergreen). Pruning is core to the system, not exception.
6. **Antifragility (Taleb).** With a regular pruning loop, the vault gains from disorder rather than suffering from it.
7. **Pareto + Gini.** 20% of templates likely produce 80% of drift; surface that asymmetry.
8. **Kolmogorov complexity proxy (compression).** A healthy vault compresses well — patterns exist.

The plugin already enforces the principle "logic in the plugin, configuration in the template." The entropy engine extends that: **logic in the plugin, judgment in the skill layer.** The CLI measures deterministically; the LLM-driven skill reasons about what to do.

## 2. User-facing entry points

```
vault-keeper entropy                 # measure + write snapshot + print human report
vault-keeper entropy --json          # measure + write snapshot + JSON to stdout
vault-keeper entropy --no-snapshot   # measure only, do not persist
vault-keeper entropy --diff          # latest vs previous snapshot, print delta
vault-keeper entropy --diff=14d      # latest vs nearest snapshot ≥14 days old
vault-keeper entropy --history       # list snapshots with date + score
```

```
/vault.garden                        # closed-loop session:
                                     #   measure → suggest → approve → execute → remeasure
```

`/vault.health` (binary check, read-only) is unchanged. `/vault.garden` is the new gradient + write skill. The two cohabit, do not overlap.

## 3. Architecture & module layout

```
claude-code-vault-keeper/
├── cli/
│   ├── main.js                      (existing, add `entropy` dispatch)
│   ├── validate-documents.js        (existing, unchanged)
│   └── entropy.js                   NEW — entry for `vault-keeper entropy`
│
├── lib/
│   ├── entropy/                     NEW module
│   │   ├── index.js                 barrel — exports measure() + types
│   │   ├── measure.js               top-level orchestrator
│   │   ├── schema-drift.js          Shannon entropy on frontmatter values
│   │   ├── vocab-drift.js           fuzzy cluster tag/link near-duplicates
│   │   ├── lifecycle.js             orphan / stale / zombie detection
│   │   ├── emergence.js             non-template pattern detector
│   │   ├── distribution.js          Pareto / Gini / gzip compression
│   │   ├── score.js                 weighted aggregation → 0–100 + breakdown
│   │   └── snapshot.js              read / write / diff snapshot JSON
│   ├── schema-engine.js             (existing, reused)
│   ├── doc-io.js                    (existing, reused — parseDocument)
│   ├── template-rules.js            (existing, reused)
│   └── vault-config.js              (existing, reused — `vaultFolders`)
│
├── skills/
│   ├── vault.health/                (existing, unchanged — binary check)
│   └── vault.garden/                NEW skill
│       └── SKILL.md                 LLM loop: measure → suggest → approve → execute → remeasure
│
├── examples/example/
│   └── notes/{drift,stale,emergent} NEW fixture subfolders
│
└── tests/
    └── entropy/                     NEW test directory
```

**Invariants:**

- `lib/entropy/` imports nothing from `skills/` (one-way dependency).
- Every primitive is a pure function `(documents, templates, config) → Measurement`. I/O lives in `measure.js`.
- Snapshot JSON is pure data (no functions, no closures) — safe for `git diff`.
- CLI exit code from `entropy` is always `0` on successful measurement. Entropy is a gradient, not a pass / fail.

**Data flow for one garden session:**

```
user: /vault.garden
   │
   ├─► Bash: vault-keeper entropy --json --root $PWD
   │     │
   │     ├─► lib/entropy/measure.js
   │     │     ├── scan vaultFolders (vault-config.js)
   │     │     ├── parseDocument each .md (doc-io.js)
   │     │     ├── group by template
   │     │     ├── run 4 primitives (schema, vocab, lifecycle, distribution) in parallel
   │     │     ├── run emergence primitive (informational, not in score)
   │     │     ├── aggregate → score.js → 0–100 + dimensional breakdown
   │     │     └── return EntropyReport (JSON)
   │     │
   │     └─► write snapshot → .vault-keeper/snapshots/<timestamp>.json
   │
   ├─► skill reads EntropyReport + samples concrete notes (only where needed)
   ├─► LLM proposes actions (prune / graft / promote / retire / compost)
   ├─► user approves per-batch (grouped by action verb)
   ├─► skill applies approved actions:
   │     ├── deterministic edits → delegate to /vault.fix or direct Edit
   │     └── log session to .vault-keeper/garden-session-<id>.log
   │
   └─► Bash: vault-keeper entropy --json (remeasure)
         └─► skill renders delta: "drift −12%, decay −8%, emergence +2 candidates"
```

## 4. Entropy measurement algorithms

All primitives accept the same triple `(documents, templates, config)` and return a `Measurement` shape with a `score` (0–1, where 0 means perfectly healthy and 1 means maximally chaotic in that dimension) plus a `details` block.

### 4.1 Schema drift — `lib/entropy/schema-drift.js`

Per template T, per declared field F, computes deviation from expected value distribution:

- `F.type === 'enum'` → `drift_score = invalid_count / total_count` where invalid means value not in `F.enum`. Captures case drift (`"WIP"` vs `"wip"`).
- `F.required === true` → `drift_score = 1 − (docs_with_F / total_docs)`.
- otherwise typed → `drift_score = 1 − type_homogeneity` (dominant type proportion).
- Shannon entropy on value distribution recorded as `entropy_norm` for visibility but not summed into score.

Output:

```json
{
  "perTemplate": {
    "book-template": {
      "fields": {
        "status": {
          "expected": "enum[reading,done,abandoned]",
          "value_distribution": { "reading": 12, "done": 30, "WIP": 2, "wip": 1 },
          "drift_score": 0.067,
          "orphan_values": ["WIP", "wip"],
          "entropy_norm": 0.42
        }
      }
    }
  },
  "global_drift_score": 0.067
}
```

### 4.2 Vocab drift — `lib/entropy/vocab-drift.js`

Fuzzy clusters tags and wiki-link targets:

- Pairwise normalized Damerau-Levenshtein distance, cluster threshold default `0.2` (configurable via `entropy.vocab.distance_threshold`).
- Case-insensitive collapse and simple singular/plural detection layered on top.
- For each cluster, pick most-used variant as `canonical`.
- `fragmentation = cluster_size − 1`. `drift_score = sum(fragmentation) / total_unique_terms`.

### 4.3 Lifecycle decay — `lib/entropy/lifecycle.js`

Lifecycle thresholds live in `.claude/vault-keeper.json` (not in template frontmatter — Approach A pure):

```json
{
  "entropy": {
    "lifecycle": {
      "default": { "stale_after_days": 90, "zombie_after_days": 30, "orphan_grace_days": 14 },
      "perTemplate": {
        "daily-note": { "stale_after_days": 7 },
        "book-template": { "stale_after_days": 365 }
      }
    }
  }
}
```

- `mtime` resolved via `git log -1 --format=%at` if available, falls back to `fs.stat`.
- Incoming-link count comes from a pure-function extract of `server/vault-index.js` (moved into `lib/` so both CLI and LSP can call it).
- A doc is **zombie** when its status field belongs to the zombie set (default `{in-progress, draft, wip}`, configurable per template) AND its `mtime > zombie_after_days`.
- `decay_score = (|stale| + |orphan| + |zombie|) / total_docs`, deduplicated (a doc can be all three; count once).

### 4.4 Pattern emergence — `lib/entropy/emergence.js`

The positive entropy dimension. For each template T:

- `declared_fields = Set(T.fields)`; for every doc using T, collect `extra_keys = doc.frontmatter.keys − declared_fields`.
- Field F is an emergence candidate when `appearances[T][F] / |docs[T]| > 0.3` (configurable).
- `suggested_primitive` chosen by value cardinality: low + repeated → `enum`; high cardinality → `string`.
- Same logic for H2 headings not in `T.sections`.

Emergence does **not** affect the overall score — a healthy vault may have many candidates, a dead one may have zero. It is rendered as an informational section ("Pattern garden growing").

### 4.5 Distribution health — `lib/entropy/distribution.js`

Three sub-signals composed:

- **Gini** on template usage and folder distribution. Healthy band 0.3–0.7. Below → flat (no Pareto); above → monoculture or sprawl.
- **Untemplated rate**: docs with frontmatter but no `$template` → AI-slop candidates.
- **Compression ratio** = `gzip(corpus).length / corpus.length` over the concatenated frontmatter corpus. Healthy is **low** (patterns repeat). Per-doc outliers flagged when an individual doc's ratio is much higher than its template's baseline.

### 4.6 Score aggregation — `lib/entropy/score.js`

```
schema_health      = 100 × (1 − schema_drift.global_drift_score)
vocab_health       = 100 × (1 − vocab_drift.drift_score)
lifecycle_health   = 100 × (1 − lifecycle.decay_score)
distribution_health = 100 × (1 − distribution.distribution_score)
overall            = weighted_avg([...], weights)
```

Default weights (in `lib/entropy/score.js`):

```js
const DEFAULT_WEIGHTS = { schema: 0.30, vocab: 0.25, lifecycle: 0.30, distribution: 0.15 };
```

Override via `entropy.weights` in `.claude/vault-keeper.json`.

### 4.7 Final `EntropyReport`

```json
{
  "schema_version": 1,
  "measured_at": "2026-05-21T10:30:00Z",
  "vault_root": "<abs path>",
  "git_head": "077137a",
  "overall_score": 78,
  "dimensions": {
    "schema":       { "score": 82, "details": { /* §4.1 */ } },
    "vocab":        { "score": 71, "details": { /* §4.2 */ } },
    "lifecycle":    { "score": 80, "details": { /* §4.3 */ } },
    "distribution": { "score": 75, "details": { /* §4.5 */ } }
  },
  "emergence": { "field_candidates": [...], "section_candidates": [...] },
  "stats": { "total_docs": 487, "total_templates": 8, "scan_duration_ms": 320 }
}
```

## 5. Snapshot persistence

Location:

```
<vault-root>/.vault-keeper/
└── snapshots/
    ├── latest.json                  ← copy of the most recent snapshot
    ├── 2026-05-21T10-30-00Z.json    ← immutable, ISO timestamp (`:` replaced by `-`)
    └── ...
```

- `.vault-keeper/` is **artifact space** (runtime output). `.claude/` remains **config space**.
- Plugin does NOT auto-modify `.gitignore`. Tracking snapshots is the user's choice; the default invitation is to commit them, because they are small (~5–20 KB) and provide an antifragility audit trail.
- `latest.json` is overwritten on each run for fast skill reads (no `ls + sort`).
- Snapshot filenames cannot collide because timestamps include millisecond precision in implementation (the spec example shows seconds for brevity).

`diffSnapshots(before, after)` returns pure delta data:

```json
{
  "elapsed_days": 3.2,
  "overall_delta": +12,
  "dimensions": { "schema": { "before": 70, "after": 82, "delta": +12 }, ... },
  "emergence_delta": {
    "new_field_candidates": ["mood"],
    "resolved_candidates": ["genre"],
    "still_pending": ["rating-scale"]
  }
}
```

Retention: the plugin does **not** auto-delete snapshots. A warning prints when the count exceeds 1000. Future `--prune-snapshots --older-than=…` deferred to a later version.

## 6. Skill `/vault.garden` loop

### 6.1 Metadata

```yaml
---
name: vault.garden
description: "Gardener-style vault maintenance — runs `vault-keeper entropy --json` to measure 4 chaos dimensions (schema drift, vocab drift, lifecycle decay, distribution health), surfaces emergence patterns, proposes context-aware pruning actions, applies per-batch with approval, remeasures to confirm entropy dropped. Closed loop. Modifies files (delegates deterministic edits to `/vault.fix`, performs semantic edits directly). Use when user says 'cắt tỉa vault', 'garden vault', 'prune vault', 'vault health gradient', 'vault entropy', 'cleanup drift', '/vault.garden'."
---
```

Distinct from `/vault.health`:

| | `/vault.health` | `/vault.garden` |
|---|---|---|
| Mode | read-only | read + write |
| Question | "Is anything broken?" | "How healthy? What to prune?" |
| Output | binary errors | gradient score + actions |
| LLM judgment | minimal | central |

### 6.2 Phase 1 — Pre-flight (silent)

1. Resolve project root: `${CLAUDE_PROJECT_DIR:-$PWD}`.
2. Confirm `vault-keeper` binary present.
3. Read `.claude/vault-keeper.json` (or proceed with whole-repo default).
4. Check git status inside `vaultFolders`. Uncommitted changes there → **block and ask the user to commit first**, so that any rollback during the session is unambiguous.
5. Uncommitted changes outside vault folders → warn, do not block.

### 6.3 Phase 2 — Measure

```bash
vault-keeper entropy --json --root "${CLAUDE_PROJECT_DIR:-$PWD}"
```

If exit ≠ 0, surface stderr and stop. The skill does not retry.

Baseline summary (6–8 lines):

```
vault.garden — <project-root>
Snapshot: 2026-05-21T10:30:00Z (git: 077137a)

Overall health: 78/100
  Schema drift     82  ✓ healthy
  Vocab drift      71  ⚠ moderate
  Lifecycle decay  80  ✓ healthy
  Distribution     75  ✓ healthy
  Pattern garden   2 candidates emerging

487 docs · 8 templates · scan 320ms
```

### 6.4 Phase 3 — Suggest

The LLM reads the `EntropyReport` and samples concrete notes **only when needed** (e.g. for `promote` proposals, read 3–5 representative docs to confirm semantics and pick a primitive).

Action verbs (5):

| Verb | Trigger | Confidence | Reversibility |
|------|---------|------------|---------------|
| **prune** | stale > N days + 0 incoming links | high | reversible (move to archive) |
| **graft** | vocab cluster fragmentation > 0 | medium | reversible (find-replace) |
| **promote** | emergence candidate appearances > 30% | low | reversible via git (template edit) |
| **retire** | template usage = 0 docs, or < 3 docs in last 180 days | medium | reversible via git |
| **compost** | zombie status > N days | high | edits status field |

Internal proposal shape:

```json
{
  "id": "g1",
  "verb": "graft",
  "scope": "vocab",
  "summary": "Merge #book + #books → #book (45 uses fragmented across 2 variants)",
  "evidence": { "cluster": ["#book", "#books"], "uses": 45 },
  "actions": [
    { "kind": "find_replace_tag", "from": "#books", "to": "#book", "files_affected": 12 }
  ],
  "confidence": 0.92,
  "reversibility": "reversible",
  "delegated_to": "vault.fix"
}
```

### 6.5 Phase 4 — Approve (batched per verb)

Batches presented in order from most-reversible to most-judgment-required:

1. **prune** (mechanical, archive move)
2. **compost** (status field edit)
3. **graft** (find-replace tag/link)
4. **promote** (template edit, semantic)
5. **retire** (template delete, requires no orphan docs)

Per-batch prompt:

```
━━━ Batch 1/4: GRAFT (4 proposals, all reversible) ━━━
1. Merge #book + #books → #book (45 uses, 12 files)
2. Merge [[Atomic Habits]] + [[atomic-habits]] → [[atomic-habits]] (8 uses, 5 files)
3. Merge status:WIP + status:wip → status:in-progress (3 docs)
4. Merge tag #ai-ml + #ai/ml → #ai/ml (12 uses, 7 files)

Approve: [a]ll · [n]one · [s]elect individual · [d]iff first · [q]uit garden
```

`q` aborts the session — applied batches stay, remaining batches are skipped, no remeasure runs.

### 6.6 Phase 5 — Execute

- `delegated_to === "vault.fix"` → skill runs `vault-keeper fix --paths=<list>` (existing deterministic formatter).
- `delegated_to === "skill_direct"` → skill uses the Edit / Write tool (template promotes, archive moves, tag find-replace).

Actions inside a batch are serialized (no parallel). One action may produce a file that the next action will read.

**Failure**: on any action failure, stop the batch, render the error, and ask `[c]ontinue with remaining · [r]ollback batch · [q]uit`. Rollback uses the session log at `.vault-keeper/garden-session-<id>.log` plus `git checkout -- <files>`. Pre-flight guaranteed a clean vault, so rollback is safe.

`prune` does **not** delete files. It moves them to `<vault>/archive/<YYYY>/<filename>`.

### 6.7 Phase 6 — Remeasure + delta

Re-run `vault-keeper entropy --json`. A new snapshot is persisted automatically by the CLI. The skill computes the delta against the baseline (Phase 2) and renders:

```
━━━ Session result ━━━
Duration: 4m 12s
Actions applied: 11 (graft: 4, compost: 3, prune: 2, promote: 2)

Score:     78 → 86  (+8)
  Schema:    82 → 92  (+10)
  Vocab:     71 → 89  (+18)
  Lifecycle: 80 → 81  (+1)
  Distribution: 75 → 75  (0)

Pattern garden:
  resolved: mood → promoted to daily-note template
  still pending: rating-scale (8 candidates)

Snapshot saved: .vault-keeper/snapshots/2026-05-21T10-34-12Z.json
Next session suggested: when score < 75 (currently 86)
```

### 6.8 Termination

The session ends on any of:

1. User `[q]uit` at any batch.
2. All 5 batches processed (approved or skipped).
3. Hard limit of 50 actions per session (runaway guard).
4. Action failure with user choosing `[q]uit`.

No auto-loop until target score. Gardening has diminishing return per session; cadence is the user's call.

### 6.9 What the skill does NOT do

- Does not auto-commit; suggests a commit message at end-of-session.
- Does not push.
- Does not edit template `fields:` without going through `promote` (no silent template mutations).
- Does not delete files; `prune` archives.
- Does not edit `.claude/vault-keeper.json` (config belongs to the user).

## 7. Testing strategy

### 7.1 Unit tests — `tests/entropy/`

One file per primitive. Inputs are in-memory document arrays; no real I/O. Coverage target ≥ 90% line coverage for the `lib/entropy/` primitives.

```
tests/entropy/
├── schema-drift.test.js
├── vocab-drift.test.js
├── lifecycle.test.js   (injected clock, no real fs mtime)
├── emergence.test.js
├── distribution.test.js
├── score.test.js
└── snapshot.test.js
```

### 7.2 Integration tests — `tests/entropy-cli.test.js`

Run `vault-keeper entropy` against `examples/example/` via subprocess and assert against a golden baseline at `tests/__fixtures__/entropy/example-vault-baseline.json`. This follows the existing pattern from commit `f1762f0` (`example-vault summary` baseline).

### 7.3 Skill smoke

The skill is markdown + LLM orchestration; not directly unit-testable. The reproduction recipe lives at the end of this spec. The contract the skill consumes is fully covered by 7.1 and 7.2.

### 7.4 Fixture additions

```
examples/example/
├── (existing docs unchanged)
├── notes/drift/
│   ├── book-status-wip.md           status="WIP" (case drift)
│   ├── book-status-completed.md     status="completed" (not in enum)
│   └── book-missing-rating.md       missing required field
├── notes/stale/
│   └── ancient-note.md              mtime set via utimesSync in test setup
└── notes/emergent/
    └── daily-{01..30}.md            field "mood:" not declared in daily-note template
```

These additions are scoped to new subfolders, so the existing `example-vault summary` baseline at the repo root is unaffected. If integration tests show drift in the existing baseline, the new subfolders will be excluded via `vaultFolders` in a test-only `.claude/vault-keeper.json` rather than altering the production fixture.

### 7.5 Performance

Budget: **< 1 s for 1000-doc vault**. The skill calls the CLI twice per session (baseline + remeasure); > 2 s combined feels sluggish. Benchmarks at 100 / 500 / 1000 docs live at `tests/entropy/perf.test.js`.

Hot paths to optimize if the budget is breached: vocab clustering is O(N²) — pre-filter to tags appearing ≥ 2 times globally. Gzip incrementally rather than re-allocating per doc.

## 8. Error handling

### 8.1 CLI exit codes

| Condition | Exit | Notes |
|---|---|---|
| Vault root missing | 2 | No JSON output |
| Config malformed | 2 | No JSON output |
| Template parse error | 1 | JSON still emitted with `template_errors[]` |
| Empty vault | 0 | `overall_score: null`, dimensions empty |
| Single-doc vault | 0 | Primitives that need N ≥ 2 return `score: null` |
| Git unavailable | 0 | `git_head: null`, mtime falls back to `fs.stat` |
| Snapshot write fails | 1 | JSON still emitted on stdout |
| Measurement OK | 0 | Gradient — CI gates by parsing JSON, not by exit code |

### 8.2 Skill error handling

- Binary missing → render install instructions from README.
- CLI exit ≠ 0 → print stderr, exit, no auto-fix.
- Mid-batch failure → rollback flow (§6.6).
- Re-measure failure → "Session applied X actions, but remeasure failed. Baseline snapshot preserved at <path>."

### 8.3 Per-dimension edge cases

- **Schema**: template with 0 docs → skip silently. Required field with 0 presence → `drift_score = 1.0`.
- **Vocab**: empty tag set → empty clusters, `drift_score = 0`. Singletons do not form clusters.
- **Lifecycle**: brand-new docs default-protected for 14 days (`orphan_grace_days`) so they are never tagged orphan on day 1.
- **Emergence**: templates with < 10 docs are unreliable; skip and record in `emergence.skipped[]`.
- **Distribution**: vault with one template → `gini: null`, verdict `single_template`. Frontmatter corpus < 100 bytes → `ratio: null`.

### 8.4 Backward compatibility

`lib/entropy/`, `cli/entropy.js`, and `skills/vault.garden/` are net-new. No existing API is broken. `package.json` does not require a major version bump. Snapshot `schema_version: 1` is the contract surface — bump when shape breaks compatibility.

## 9. Configuration surface

All entropy config lives under `entropy:` in `.claude/vault-keeper.json`:

```json
{
  "vaultFolders": ["..."],
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
        "daily-note":     { "stale_after_days": 7 },
        "book-template":  { "stale_after_days": 365, "zombie_status_set": ["reading"] }
      }
    },
    "emergence": { "candidate_threshold": 0.30, "min_template_docs": 10 }
  }
}
```

All fields optional; sensible defaults baked into `lib/entropy/`.

## 10. Build sequence

1. **Extract `lib/vault-index.js`** — move the incoming-link / frontmatter index logic out of `server/vault-index.js` into a pure-function module in `lib/`, then re-export from the LSP side so the LSP behavior is unchanged. Required by §4.3 (lifecycle.js needs incoming-link counts from CLI context too). Ships with its own unit test for the pure surface.
2. **`lib/entropy/snapshot.js` + `lib/entropy/score.js`** — pure utilities, easiest first, both with their unit tests.
3. **`lib/entropy/{schema-drift,vocab-drift,lifecycle,emergence,distribution}.js`** — five primitives, parallelizable, each with its unit test. `lifecycle.js` consumes the new `lib/vault-index.js` from step 1.
4. **`lib/entropy/measure.js` + `lib/entropy/index.js`** — orchestrator + barrel.
5. **`cli/entropy.js`** + `cli/main.js` dispatch wiring + integration test against `examples/example/`.
6. **Fixture additions** under `examples/example/notes/{drift,stale,emergent}/`.
7. **Skill `skills/vault.garden/SKILL.md`** — written last because it consumes the CLI shape.
8. **Documentation**: append an `Entropy gardener` section to `docs/architecture.md` and add a `docs/vault-garden.md` reference.

## 11. Open questions / deferred

- `--diff --fresh` (force remeasure for diff comparison) — deferred to v2.
- `vault-keeper entropy --prune-snapshots --older-than=…` — deferred to v2.
- Vault-level rate limiting on garden invocations — not planned; user decides cadence.
- LSP integration for entropy hover (e.g. hovering a tag shows its cluster) — not planned for v1; CLI + skill first.

## 12. Reproduction recipe (manual smoke for the skill)

1. `cd examples/example`
2. Augment with the fixture subfolders from §7.4.
3. Run `vault-keeper entropy` → confirm baseline score and JSON shape.
4. Run `/vault.garden`:
   - Confirm pre-flight blocks if `examples/example` has uncommitted changes.
   - Confirm baseline summary matches the CLI output.
   - For each batch, exercise `[a]`, `[s]`, `[d]`, `[n]`, `[q]` once.
5. Inspect `.vault-keeper/snapshots/` — both baseline and post-session snapshots present, `latest.json` matches the newest.
6. Run `vault-keeper entropy --diff` → delta matches what the skill rendered.
