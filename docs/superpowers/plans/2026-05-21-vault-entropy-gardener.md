# Vault entropy gardener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add gradient vault-health measurement (`vault-keeper entropy`) + LLM-orchestrated pruning loop (`/vault.garden`) on top of the existing binary `/vault.health` validator, with git-tracked snapshots for antifragility audit.

**Architecture:** Pure deterministic measurement primitives in `lib/entropy/` (no LLM, no judgment) feed an `EntropyReport` JSON to the CLI subcommand and to the skill layer. The skill consumes the report + samples concrete notes to propose pruning actions, gates each action behind per-batch approval, delegates execution to existing `/vault.fix` for deterministic edits and uses `Edit` directly for semantic edits, then re-measures to confirm entropy dropped.

**Tech Stack:** Node 22 + ESM + `bun:test` + `gray-matter` (existing) + `node:zlib` (built-in, no new dep). Distance function for vocab clustering = inline normalized Damerau-Levenshtein (~25 lines, no new dep).

**Spec:** `docs/superpowers/specs/2026-05-21-vault-entropy-gardener-design.md`

---

## File map

**Create:**
- `lib/vault-index.js` — pure-function incoming-link counter extracted from `server/vault-index.js`.
- `lib/entropy/index.js` — public barrel.
- `lib/entropy/snapshot.js` — read / write / diff snapshot JSON.
- `lib/entropy/score.js` — weighted aggregation.
- `lib/entropy/schema-drift.js` — Shannon-entropy + drift score on frontmatter.
- `lib/entropy/vocab-drift.js` — fuzzy cluster tags + wiki-links.
- `lib/entropy/lifecycle.js` — stale / orphan / zombie detection.
- `lib/entropy/emergence.js` — non-template field / section candidates.
- `lib/entropy/distribution.js` — Gini + compression-ratio composite.
- `lib/entropy/measure.js` — orchestrator that runs all primitives.
- `lib/entropy/defaults.js` — default thresholds + weights.
- `cli/entropy.js` — `vault-keeper entropy` subcommand entry.
- `skills/vault.garden/SKILL.md` — LLM-orchestrated loop skill.
- `docs/vault-garden.md` — user-facing reference.
- `tests/entropy/` — one unit-test file per primitive plus integration test.

**Modify:**
- `lib/vault-config.js` — surface `entropy` block from config file (default `null`).
- `cli/main.js` — dispatch `entropy` subcommand + add usage banner.
- `server/vault-index.js` — re-export incoming-link utility from `lib/vault-index.js` so the LSP behaviour is unchanged.
- `docs/architecture.md` — append `Entropy gardener` section.
- `lib/index.js` — re-export `measure` + types from `lib/entropy/`.

---

## Task 1: Extend `loadVaultConfig` to surface `entropy` block

**Why:** Every measurement primitive needs lifecycle thresholds, vocab distance threshold, weights, and emergence thresholds. These live under an `entropy:` key in `.claude/vault-keeper.json` — the loader must surface that block (default `null`) without baking entropy-engine defaults into the config layer (defaults live in `lib/entropy/defaults.js` because the engine owns them).

**Files:**
- Modify: `lib/vault-config.js`
- Test: `tests/vault-config.test.js` (existing file — append new test cases)

- [ ] **Step 1: Write the failing test**

Open `tests/vault-config.test.js` and append (at the bottom of the existing `describe` block; mirror the existing pattern that uses `tmp` + `_resetVaultConfigCache`):

```javascript
describe('loadVaultConfig — entropy block', () => {
  test('returns entropy: null when config omits the key', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({ vaultFolders: ['notes'] }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.entropy).toBe(null);
  });

  test('surfaces entropy block as-is when present', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({
        vaultFolders: ['notes'],
        entropy: {
          weights: { schema: 0.5, vocab: 0.5 },
          vocab: { distance_threshold: 0.15 },
        },
      }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.entropy).toEqual({
      weights: { schema: 0.5, vocab: 0.5 },
      vocab: { distance_threshold: 0.15 },
    });
  });

  test('entropy block is frozen', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({ entropy: { weights: { schema: 1 } } }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(Object.isFrozen(cfg.entropy)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/vault-config.test.js`
Expected: 3 failing assertions on `cfg.entropy` (currently `undefined`).

- [ ] **Step 3: Modify `loadVaultConfig`**

In `lib/vault-config.js`, locate the `merged` object inside `loadVaultConfig` and add the `entropy` field plus a deep-freeze:

```javascript
const merged = {
  vaultRoot:
    typeof fileConfig.vaultRoot === 'string' && fileConfig.vaultRoot.length > 0
      ? fileConfig.vaultRoot
      : DEFAULTS.vaultRoot,
  vaultFolders:
    Array.isArray(fileConfig.vaultFolders) && fileConfig.vaultFolders.length > 0
      ? fileConfig.vaultFolders.slice()
      : DEFAULTS.vaultFolders.slice(),
  excludePatterns:
    Array.isArray(fileConfig.excludePatterns) && fileConfig.excludePatterns.length > 0
      ? fileConfig.excludePatterns.slice()
      : DEFAULTS.excludePatterns.slice(),
  // Entropy block surfaced as-is (or null). Defaults live in lib/entropy/
  // because the engine owns its own knobs.
  entropy: fileConfig.entropy && typeof fileConfig.entropy === 'object'
    ? deepFreezeClone(fileConfig.entropy)
    : null,
};
```

Add a private helper at the top of the file (after the `DEFAULTS` block):

```javascript
/** Recursive structuredClone + deepFreeze. Safe for plain JSON shapes. */
function deepFreezeClone(value) {
  if (value === null || typeof value !== 'object') return value;
  const out = Array.isArray(value) ? value.slice() : { ...value };
  for (const k of Object.keys(out)) {
    out[k] = deepFreezeClone(out[k]);
  }
  return Object.freeze(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/vault-config.test.js`
Expected: all tests pass, including the 3 new ones.

Also run the full suite to ensure no regression:

```
bun test ./tests 2>&1 | tail -15
```

Expected: same pass count as before plus 3, zero new failures.

- [ ] **Step 5: Commit**

```bash
git add lib/vault-config.js tests/vault-config.test.js
git commit -m "feat(vault-config): surface entropy block from config

Adds optional \`entropy:\` field to loadVaultConfig's return shape, defaulting
to null when absent. Engine-side defaults live in lib/entropy/ because the
config layer should not bake knowledge of measurement primitives.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Extract pure-function `lib/vault-index.js` for incoming-link counts

**Why:** `lib/entropy/lifecycle.js` needs incoming-link counts to detect orphans. The only existing implementation lives inside the `VaultIndex` class in `server/vault-index.js`, which is class-based, lazy, and LSP-shaped. Extract just the link-counting walk into a pure async function in `lib/` so both CLI and LSP can call it without instantiating a class. Re-export from the LSP side keeps that behaviour unchanged.

**Files:**
- Create: `lib/vault-index.js`
- Modify: `server/vault-index.js`
- Test: `tests/vault-index.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/vault-index.test.js`:

```javascript
/**
 * Tests for lib/vault-index.js — pure-function incoming-link counter.
 *
 * Builds a tmp vault on disk with three .md files (A links to B; C is orphan)
 * and asserts countIncomingLinks() returns the expected per-target counts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countIncomingLinks } from '../lib/vault-index.js';

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-vi-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('countIncomingLinks', () => {
  test('counts incoming markdown body links by absolute target path', async () => {
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    writeFileSync(
      join(tmp, 'notes', 'a.md'),
      '---\ntitle: A\n---\n# A\n\nSee [B](./b.md) and [B again](./b.md#section).\n',
    );
    writeFileSync(
      join(tmp, 'notes', 'b.md'),
      '---\ntitle: B\n---\n# B\n',
    );
    writeFileSync(
      join(tmp, 'notes', 'c.md'),
      '---\ntitle: C orphan\n---\n# C\n',
    );

    const counts = await countIncomingLinks(join(tmp, 'notes'));

    expect(counts.get(join(tmp, 'notes', 'b.md'))).toBe(2);
    expect(counts.get(join(tmp, 'notes', 'c.md')) ?? 0).toBe(0);
    expect(counts.get(join(tmp, 'notes', 'a.md')) ?? 0).toBe(0);
  });

  test('skips http(s) links and code-fence-looking refs', async () => {
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    writeFileSync(
      join(tmp, 'notes', 'a.md'),
      '# A\n\nSee [external](https://example.com/foo.md) and [B](./b.md).\n',
    );
    writeFileSync(join(tmp, 'notes', 'b.md'), '# B\n');

    const counts = await countIncomingLinks(join(tmp, 'notes'));
    expect(counts.get(join(tmp, 'notes', 'b.md'))).toBe(1);
  });

  test('empty vault → empty Map', async () => {
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    const counts = await countIncomingLinks(join(tmp, 'notes'));
    expect(counts.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/vault-index.test.js`
Expected: import error "Cannot find module '../lib/vault-index.js'".

- [ ] **Step 3: Implement `lib/vault-index.js`**

Create `lib/vault-index.js`:

```javascript
/**
 * vault-index.js — Pure-function vault link index for CLI consumers.
 *
 * The LSP keeps its own stateful `VaultIndex` class in server/ for didSave
 * incremental updates; this file exposes only the one-shot link walk that
 * the entropy engine needs.
 *
 * No caching, no class instances — call it once per measurement run.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

/** Match `[text](path.md)` and `[text](path.md#anchor)`. Skips URLs. */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

const SKIP_DIRS = new Set(['node_modules', '.git', '.omc', '.vault-keeper']);

/**
 * Walk a vault root for .md files, count incoming markdown body links by
 * resolved absolute target path.
 *
 * @param {string} vaultRoot — absolute path to walk
 * @returns {Promise<Map<string, number>>} target absPath → incoming count
 */
export async function countIncomingLinks(vaultRoot) {
  const files = await walkMarkdown(vaultRoot);
  const counts = new Map();

  await Promise.all(
    files.map(async (absPath) => {
      let body;
      try {
        body = await readFile(absPath, 'utf-8');
      } catch {
        return;
      }
      MD_LINK_RE.lastIndex = 0;
      let m;
      while ((m = MD_LINK_RE.exec(body)) !== null) {
        const rawPath = m[2].split('#')[0];
        if (rawPath.startsWith('http')) continue;
        const target = resolve(dirname(absPath), rawPath);
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }),
  );

  return counts;
}

async function walkMarkdown(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.specify') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/vault-index.test.js`
Expected: all 3 tests pass.

- [ ] **Step 5: Sanity-check LSP did not regress**

Run the LSP smoke test:

```
bun run smoke:server 2>&1 | tail -10
```

Expected: same pass output as before (no behaviour change in `server/vault-index.js` yet).

- [ ] **Step 6: Commit**

```bash
git add lib/vault-index.js tests/vault-index.test.js
git commit -m "feat(lib): extract pure countIncomingLinks for CLI consumers

The LSP keeps its stateful VaultIndex class for didSave incremental updates;
this is the one-shot link walk the entropy engine needs. No caching, no
class — pure async function returning Map<absPath, count>.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `lib/entropy/defaults.js` — engine-side default thresholds

**Why:** Every primitive needs sensible defaults when the user's config omits a field. Centralize them in one file so weights / thresholds / lifecycle defaults all live next to the engine that consumes them, not buried inside individual primitives.

**Files:**
- Create: `lib/entropy/defaults.js`
- Test: `tests/entropy/defaults.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/defaults.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import {
  ENTROPY_DEFAULTS,
  resolveEntropyConfig,
} from '../../lib/entropy/defaults.js';

describe('ENTROPY_DEFAULTS', () => {
  test('weights sum to 1.0', () => {
    const w = ENTROPY_DEFAULTS.weights;
    const total = w.schema + w.vocab + w.lifecycle + w.distribution;
    expect(Math.abs(total - 1.0)).toBeLessThan(1e-9);
  });

  test('object is frozen', () => {
    expect(Object.isFrozen(ENTROPY_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(ENTROPY_DEFAULTS.weights)).toBe(true);
    expect(Object.isFrozen(ENTROPY_DEFAULTS.lifecycle)).toBe(true);
  });
});

describe('resolveEntropyConfig', () => {
  test('null → defaults', () => {
    const cfg = resolveEntropyConfig(null);
    expect(cfg.weights.schema).toBe(0.30);
    expect(cfg.lifecycle.default.stale_after_days).toBe(90);
  });

  test('partial override merges shallow', () => {
    const cfg = resolveEntropyConfig({
      weights: { schema: 0.5, vocab: 0.5, lifecycle: 0, distribution: 0 },
    });
    expect(cfg.weights.schema).toBe(0.5);
    // Lifecycle untouched — still defaults
    expect(cfg.lifecycle.default.stale_after_days).toBe(90);
  });

  test('per-template lifecycle override takes precedence', () => {
    const cfg = resolveEntropyConfig({
      lifecycle: {
        perTemplate: { 'daily-note': { stale_after_days: 7 } },
      },
    });
    expect(cfg.lifecycle.perTemplate['daily-note'].stale_after_days).toBe(7);
    // Default still in place for other templates
    expect(cfg.lifecycle.default.stale_after_days).toBe(90);
  });

  test('returned config is frozen', () => {
    const cfg = resolveEntropyConfig(null);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.weights)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/entropy/defaults.test.js`
Expected: import error "Cannot find module".

- [ ] **Step 3: Implement `lib/entropy/defaults.js`**

```javascript
/**
 * Engine-side default thresholds for the entropy measurement primitives.
 *
 * Lives next to the engine, NOT inside lib/vault-config.js, because the
 * config layer should not bake in knowledge of measurement primitives.
 * Consumers pass a user-side config (or null) to resolveEntropyConfig()
 * to get a fully-populated config object.
 */

export const ENTROPY_DEFAULTS = Object.freeze({
  weights: Object.freeze({
    schema: 0.30,
    vocab: 0.25,
    lifecycle: 0.30,
    distribution: 0.15,
  }),
  vocab: Object.freeze({
    distance_threshold: 0.2,
  }),
  lifecycle: Object.freeze({
    default: Object.freeze({
      stale_after_days: 90,
      zombie_after_days: 30,
      orphan_grace_days: 14,
      zombie_status_set: Object.freeze(['in-progress', 'draft', 'wip']),
    }),
    perTemplate: Object.freeze({}),
  }),
  emergence: Object.freeze({
    candidate_threshold: 0.30,
    min_template_docs: 10,
  }),
});

/**
 * Merge a user-supplied entropy config (from `.claude/vault-keeper.json`'s
 * `entropy:` block) on top of ENTROPY_DEFAULTS. Shallow merge per top-level
 * key — user override of `weights` replaces the whole weights object.
 *
 * @param {object|null} userCfg
 * @returns {object} frozen, fully-populated entropy config
 */
export function resolveEntropyConfig(userCfg) {
  const cfg = userCfg && typeof userCfg === 'object' ? userCfg : {};
  const merged = {
    weights: deepFreeze({ ...ENTROPY_DEFAULTS.weights, ...(cfg.weights ?? {}) }),
    vocab:   deepFreeze({ ...ENTROPY_DEFAULTS.vocab,   ...(cfg.vocab   ?? {}) }),
    lifecycle: deepFreeze({
      default: { ...ENTROPY_DEFAULTS.lifecycle.default, ...((cfg.lifecycle ?? {}).default ?? {}) },
      perTemplate: { ...ENTROPY_DEFAULTS.lifecycle.perTemplate, ...((cfg.lifecycle ?? {}).perTemplate ?? {}) },
    }),
    emergence: deepFreeze({ ...ENTROPY_DEFAULTS.emergence, ...(cfg.emergence ?? {}) }),
  };
  return Object.freeze(merged);
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/entropy/defaults.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/defaults.js tests/entropy/defaults.test.js
git commit -m "feat(entropy): default thresholds + resolveEntropyConfig

Centralizes engine-side defaults (weights, lifecycle thresholds, vocab
distance, emergence threshold) in lib/entropy/defaults.js. Merge function
shallow-merges per top-level key; per-template lifecycle entries override
the default block.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `lib/entropy/snapshot.js` — read / write / diff snapshot JSON

**Why:** Every garden session needs a baseline snapshot to compare against. Snapshots also persist across sessions for trend reporting (`--diff`, `--history`). Pure file I/O; no engine dependencies.

**Files:**
- Create: `lib/entropy/snapshot.js`
- Test: `tests/entropy/snapshot.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/snapshot.test.js`:

```javascript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSnapshot,
  readLatestSnapshot,
  listSnapshots,
  diffSnapshots,
} from '../../lib/entropy/snapshot.js';

let tmp;
beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-snap-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const sampleReport = (score, ts) => ({
  schema_version: 1,
  measured_at: ts,
  vault_root: '/x',
  git_head: 'abc123',
  overall_score: score,
  dimensions: {
    schema: { score, details: {} },
    vocab: { score, details: {} },
    lifecycle: { score, details: {} },
    distribution: { score, details: {} },
  },
  emergence: { field_candidates: [], section_candidates: [] },
  stats: { total_docs: 0, total_templates: 0, scan_duration_ms: 0 },
});

describe('writeSnapshot', () => {
  test('writes timestamped file + latest.json', () => {
    const report = sampleReport(78, '2026-05-21T10:30:00.000Z');
    const file = writeSnapshot(report, tmp);
    expect(file.endsWith('2026-05-21T10-30-00.000Z.json')).toBe(true);
    expect(existsSync(join(tmp, '.vault-keeper', 'snapshots', 'latest.json'))).toBe(true);

    const latest = JSON.parse(readFileSync(join(tmp, '.vault-keeper', 'snapshots', 'latest.json'), 'utf-8'));
    expect(latest.overall_score).toBe(78);
  });

  test('dryRun returns null and writes nothing', () => {
    const file = writeSnapshot(sampleReport(50, '2026-05-21T11:00:00.000Z'), tmp, { dryRun: true });
    expect(file).toBe(null);
    expect(existsSync(join(tmp, '.vault-keeper'))).toBe(false);
  });
});

describe('readLatestSnapshot', () => {
  test('returns null when no snapshots exist', () => {
    expect(readLatestSnapshot(tmp)).toBe(null);
  });

  test('returns most-recent snapshot', () => {
    writeSnapshot(sampleReport(60, '2026-05-20T10:00:00.000Z'), tmp);
    writeSnapshot(sampleReport(80, '2026-05-21T10:00:00.000Z'), tmp);
    const latest = readLatestSnapshot(tmp);
    expect(latest.overall_score).toBe(80);
  });
});

describe('listSnapshots', () => {
  test('returns sorted ascending by measured_at', () => {
    writeSnapshot(sampleReport(80, '2026-05-21T10:00:00.000Z'), tmp);
    writeSnapshot(sampleReport(60, '2026-05-20T10:00:00.000Z'), tmp);
    const list = listSnapshots(tmp);
    expect(list.length).toBe(2);
    expect(list[0].overall_score).toBe(60);
    expect(list[1].overall_score).toBe(80);
  });
});

describe('diffSnapshots', () => {
  test('computes per-dimension deltas', () => {
    const before = sampleReport(70, '2026-05-20T10:00:00.000Z');
    const after = sampleReport(82, '2026-05-21T10:00:00.000Z');
    const delta = diffSnapshots(before, after);
    expect(delta.overall_delta).toBe(12);
    expect(delta.dimensions.schema.delta).toBe(12);
    expect(delta.elapsed_days).toBeCloseTo(1, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/entropy/snapshot.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/snapshot.js`**

```javascript
/**
 * snapshot.js — read / write / diff entropy snapshot JSON.
 *
 * Snapshots live at `<vaultRoot>/.vault-keeper/snapshots/`. File names use
 * ISO timestamps with `:` replaced by `-` (FS-safe on Windows). `latest.json`
 * is an overwritten copy of the most recent snapshot for cheap reads.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR_REL = ['.vault-keeper', 'snapshots'];

function snapshotsDir(vaultRoot) {
  return join(vaultRoot, ...DIR_REL);
}

function filenameFor(measuredAt) {
  // 2026-05-21T10:30:00.123Z → 2026-05-21T10-30-00.123Z.json
  return measuredAt.replace(/:/g, '-') + '.json';
}

export function writeSnapshot(report, vaultRoot, { dryRun = false } = {}) {
  if (dryRun) return null;
  const dir = snapshotsDir(vaultRoot);
  mkdirSync(dir, { recursive: true });
  const filename = filenameFor(report.measured_at);
  const filepath = join(dir, filename);
  const json = JSON.stringify(report, null, 2);
  writeFileSync(filepath, json);
  writeFileSync(join(dir, 'latest.json'), json);
  return filepath;
}

export function readLatestSnapshot(vaultRoot) {
  const file = join(snapshotsDir(vaultRoot), 'latest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function listSnapshots(vaultRoot) {
  const dir = snapshotsDir(vaultRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.json') && f !== 'latest.json',
  );
  const reports = [];
  for (const f of files) {
    try {
      reports.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    } catch {
      // skip malformed
    }
  }
  reports.sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  return reports;
}

export function diffSnapshots(before, after) {
  const elapsedMs = new Date(after.measured_at) - new Date(before.measured_at);
  const dim = (name) => ({
    before: before.dimensions[name].score,
    after: after.dimensions[name].score,
    delta: after.dimensions[name].score - before.dimensions[name].score,
  });
  return {
    elapsed_days: elapsedMs / (1000 * 60 * 60 * 24),
    overall_delta: after.overall_score - before.overall_score,
    dimensions: {
      schema: dim('schema'),
      vocab: dim('vocab'),
      lifecycle: dim('lifecycle'),
      distribution: dim('distribution'),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/entropy/snapshot.test.js`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/snapshot.js tests/entropy/snapshot.test.js
git commit -m "feat(entropy): snapshot read/write/diff utility

Pure file I/O for entropy snapshots persisted at <vault>/.vault-keeper/
snapshots/. writeSnapshot creates timestamped file + overwrites latest.json
for cheap skill reads. diffSnapshots returns per-dimension delta + elapsed
days.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `lib/entropy/score.js` — weighted aggregation

**Why:** Each primitive returns a 0–1 chaos score for its dimension. `score.js` flips them to 0–100 health scores and takes the weighted average. Pure arithmetic; no I/O.

**Files:**
- Create: `lib/entropy/score.js`
- Test: `tests/entropy/score.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/score.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { aggregateScore, dimensionHealth } from '../../lib/entropy/score.js';
import { ENTROPY_DEFAULTS } from '../../lib/entropy/defaults.js';

describe('dimensionHealth', () => {
  test('chaos 0 → health 100', () => {
    expect(dimensionHealth(0)).toBe(100);
  });
  test('chaos 1 → health 0', () => {
    expect(dimensionHealth(1)).toBe(0);
  });
  test('chaos 0.3 → health 70', () => {
    expect(dimensionHealth(0.3)).toBe(70);
  });
  test('null chaos → null health', () => {
    expect(dimensionHealth(null)).toBe(null);
  });
});

describe('aggregateScore', () => {
  test('all 100 → 100', () => {
    const out = aggregateScore(
      { schema: 0, vocab: 0, lifecycle: 0, distribution: 0 },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(100);
  });

  test('weighted avg with defaults', () => {
    // chaos: schema 0.2, vocab 0.4, lifecycle 0.1, distribution 0.3
    // health: 80, 60, 90, 70
    // defaults: 0.30*80 + 0.25*60 + 0.30*90 + 0.15*70 = 24 + 15 + 27 + 10.5 = 76.5 → 77
    const out = aggregateScore(
      { schema: 0.2, vocab: 0.4, lifecycle: 0.1, distribution: 0.3 },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(77);
  });

  test('user weights override', () => {
    // chaos: schema 0.5, vocab 0.5; weights schema=1, vocab=0
    // health: 50, 50; weighted: 1*50 + 0*50 = 50
    const out = aggregateScore(
      { schema: 0.5, vocab: 0.5, lifecycle: 0.5, distribution: 0.5 },
      { schema: 1, vocab: 0, lifecycle: 0, distribution: 0 },
    );
    expect(out).toBe(50);
  });

  test('null chaos dimension excluded from average', () => {
    // schema=0, distribution=0 known; vocab and lifecycle = null (skipped)
    // remaining weights: schema 0.30 + distribution 0.15 = 0.45
    // weighted: (0.30*100 + 0.15*100) / 0.45 = 100
    const out = aggregateScore(
      { schema: 0, vocab: null, lifecycle: null, distribution: 0 },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(100);
  });

  test('all dimensions null → null', () => {
    const out = aggregateScore(
      { schema: null, vocab: null, lifecycle: null, distribution: null },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/entropy/score.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/score.js`**

```javascript
/**
 * score.js — convert chaos scores (0–1) to health scores (0–100) and
 * compute the weighted overall score.
 */

/**
 * @param {number|null} chaos  0 = perfectly healthy, 1 = maximally chaotic
 * @returns {number|null} 100 − round(chaos × 100), or null when chaos is null
 */
export function dimensionHealth(chaos) {
  if (chaos === null || chaos === undefined) return null;
  return Math.round(100 - chaos * 100);
}

/**
 * Weighted average of dimensional health scores. Dimensions with null chaos
 * are excluded from both the numerator and the denominator (so a single-doc
 * vault that cannot compute vocab still gets a meaningful overall score).
 *
 * @param {{schema, vocab, lifecycle, distribution}} chaos  per-dim chaos in [0, 1] or null
 * @param {{schema, vocab, lifecycle, distribution}} weights  must sum to 1.0
 * @returns {number|null} integer 0–100, or null if every dim is null
 */
export function aggregateScore(chaos, weights) {
  let weightedSum = 0;
  let weightUsed = 0;
  for (const dim of ['schema', 'vocab', 'lifecycle', 'distribution']) {
    const c = chaos[dim];
    if (c === null || c === undefined) continue;
    const health = 100 - c * 100;
    weightedSum += health * weights[dim];
    weightUsed += weights[dim];
  }
  if (weightUsed === 0) return null;
  return Math.round(weightedSum / weightUsed);
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/entropy/score.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/score.js tests/entropy/score.test.js
git commit -m "feat(entropy): chaos→health conversion + weighted aggregate

dimensionHealth(chaos) returns 100 − round(chaos × 100); null passes
through. aggregateScore excludes null dimensions from both numerator and
weight denominator so degenerate vaults still report meaningful scores.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: `lib/entropy/schema-drift.js` — Shannon entropy + drift on frontmatter

**Why:** First measurement primitive. For each template, for each declared field, compute deviation from the expected value distribution. Enum fields penalize values outside the enum (case drift); required fields penalize missing; optional typed fields penalize type heterogeneity.

**Files:**
- Create: `lib/entropy/schema-drift.js`
- Test: `tests/entropy/schema-drift.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/schema-drift.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { measureSchemaDrift } from '../../lib/entropy/schema-drift.js';

// Fixtures: minimal doc + template shape mirroring what doc-io / template-rules
// produce. measureSchemaDrift takes in-memory data only — pure function.
const enumTemplate = {
  path: 'templates/book-template.md',
  fields: {
    status: { type: 'string', enum: ['reading', 'done', 'abandoned'] },
    rating: { type: 'integer', required: false },
    title:  { type: 'string', required: true },
  },
};

const doc = (frontmatter, template = 'templates/book-template.md') => ({
  filepath: '/x/book.md',
  template,
  frontmatter,
});

describe('measureSchemaDrift', () => {
  test('all docs match enum → drift 0 for that field', () => {
    const out = measureSchemaDrift(
      [doc({ status: 'reading', title: 'A' }), doc({ status: 'done', title: 'B' })],
      [enumTemplate],
    );
    expect(out.perTemplate['templates/book-template.md'].fields.status.drift_score).toBe(0);
    expect(out.global_drift_score).toBe(0);
  });

  test('case drift outside enum → drift > 0 and orphan_values populated', () => {
    const out = measureSchemaDrift(
      [
        doc({ status: 'reading', title: 'A' }),
        doc({ status: 'WIP', title: 'B' }),
        doc({ status: 'wip', title: 'C' }),
      ],
      [enumTemplate],
    );
    const f = out.perTemplate['templates/book-template.md'].fields.status;
    expect(f.drift_score).toBeCloseTo(2 / 3, 5); // 2 invalid of 3
    expect(f.orphan_values.sort()).toEqual(['WIP', 'wip']);
  });

  test('missing required field penalized as drift 1.0 absent rate', () => {
    const out = measureSchemaDrift(
      [doc({ status: 'reading' }), doc({ status: 'done' })],  // no title
      [enumTemplate],
    );
    const f = out.perTemplate['templates/book-template.md'].fields.title;
    expect(f.drift_score).toBe(1);  // 0 of 2 present
  });

  test('template with zero docs is skipped (no NaN)', () => {
    const out = measureSchemaDrift([], [enumTemplate]);
    expect(out.global_drift_score).toBe(0);
    expect(out.perTemplate['templates/book-template.md']).toBeUndefined();
  });

  test('docs without resolved template are skipped silently', () => {
    const out = measureSchemaDrift(
      [doc({ status: 'reading' }, null)],
      [enumTemplate],
    );
    expect(out.global_drift_score).toBe(0);
  });

  test('Shannon entropy norm computed when ≥2 unique values', () => {
    const out = measureSchemaDrift(
      [
        doc({ status: 'reading', title: 'A' }),
        doc({ status: 'reading', title: 'B' }),
        doc({ status: 'done', title: 'C' }),
        doc({ status: 'done', title: 'D' }),
      ],
      [enumTemplate],
    );
    // 2 unique values evenly split → H = 1, log2(2) = 1, H_norm = 1
    expect(out.perTemplate['templates/book-template.md'].fields.status.entropy_norm).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy/schema-drift.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/schema-drift.js`**

```javascript
/**
 * schema-drift.js — Frontmatter shape variance per template.
 *
 * For each template, for each declared field, computes:
 *   - drift_score (0–1)  → 1 means the field is completely broken in this corpus
 *   - orphan_values[]    → enum values not in F.enum (e.g. "WIP" when allowed
 *                          is [reading, done, abandoned])
 *   - entropy_norm       → Shannon entropy normalized by log2(unique_count)
 *                          (informational; not folded into score)
 *
 * Pure function. No I/O. No template loading. Caller passes already-parsed
 * docs and templates.
 */

/**
 * @param {Array<{filepath, template, frontmatter}>} docs
 * @param {Array<{path, fields}>} templates
 * @returns {{perTemplate, global_drift_score}}
 */
export function measureSchemaDrift(docs, templates) {
  const byTemplate = new Map();
  for (const t of templates) byTemplate.set(t.path, t);

  /** template path → doc[] */
  const docsByTemplate = new Map();
  for (const d of docs) {
    if (!d.template) continue;
    if (!byTemplate.has(d.template)) continue;
    if (!docsByTemplate.has(d.template)) docsByTemplate.set(d.template, []);
    docsByTemplate.get(d.template).push(d);
  }

  const perTemplate = {};
  let driftSum = 0;
  let driftCount = 0;

  for (const [templatePath, templateDocs] of docsByTemplate) {
    if (templateDocs.length === 0) continue;
    const template = byTemplate.get(templatePath);
    const fields = template.fields ?? {};
    perTemplate[templatePath] = { fields: {} };

    for (const [fieldName, spec] of Object.entries(fields)) {
      // Collect value distribution
      const valueCounts = new Map();
      let presentCount = 0;
      for (const d of templateDocs) {
        const v = d.frontmatter?.[fieldName];
        if (v === undefined || v === null || v === '') continue;
        presentCount++;
        const key = String(v);
        valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
      }
      const total = templateDocs.length;

      let drift_score;
      let orphan_values = [];
      if (Array.isArray(spec.enum) && spec.enum.length > 0) {
        const enumSet = new Set(spec.enum.map(String));
        let invalid = 0;
        for (const [val, count] of valueCounts) {
          if (!enumSet.has(val)) {
            invalid += count;
            orphan_values.push(val);
          }
        }
        drift_score = total === 0 ? 0 : invalid / total;
      } else if (spec.required === true) {
        drift_score = total === 0 ? 0 : 1 - presentCount / total;
      } else {
        // Optional typed: penalize type heterogeneity
        const typeCounts = new Map();
        for (const d of templateDocs) {
          const v = d.frontmatter?.[fieldName];
          if (v === undefined || v === null || v === '') continue;
          const t = Array.isArray(v) ? 'array' : typeof v;
          typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
        }
        if (presentCount <= 1) {
          drift_score = 0;
        } else {
          const dominant = Math.max(...typeCounts.values());
          drift_score = 1 - dominant / presentCount;
        }
      }

      // Shannon entropy normalized
      let entropy_norm = null;
      if (valueCounts.size >= 2) {
        let H = 0;
        for (const c of valueCounts.values()) {
          const p = c / presentCount;
          H -= p * Math.log2(p);
        }
        entropy_norm = H / Math.log2(valueCounts.size);
      }

      perTemplate[templatePath].fields[fieldName] = {
        expected: describeSpec(spec),
        value_distribution: Object.fromEntries(valueCounts),
        drift_score,
        orphan_values,
        entropy_norm,
      };
      driftSum += drift_score;
      driftCount++;
    }
  }

  const global_drift_score = driftCount === 0 ? 0 : driftSum / driftCount;
  return { perTemplate, global_drift_score };
}

function describeSpec(spec) {
  if (Array.isArray(spec.enum)) return `enum[${spec.enum.join(',')}]`;
  if (spec.required) return `${spec.type ?? 'any'} (required)`;
  return spec.type ?? 'any';
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/entropy/schema-drift.test.js`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/schema-drift.js tests/entropy/schema-drift.test.js
git commit -m "feat(entropy): schema-drift primitive

Per template, per field: drift_score for enum violations (case drift),
missing required fields, and optional-field type heterogeneity. Shannon
entropy norm recorded informationally. Pure function — no I/O.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: `lib/entropy/vocab-drift.js` — fuzzy cluster tags + wiki-links

**Why:** Detects when the same concept is referenced by multiple near-duplicate strings (`#book` / `#books`, `[[Atomic Habits]]` / `[[atomic-habits]]`). Uses a tiny inline normalized Damerau-Levenshtein implementation (~25 lines) to avoid adding a dependency.

**Files:**
- Create: `lib/entropy/vocab-drift.js`
- Test: `tests/entropy/vocab-drift.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/vocab-drift.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { measureVocabDrift, normalizedDistance } from '../../lib/entropy/vocab-drift.js';

const doc = (fm, body = '') => ({ filepath: '/x.md', frontmatter: fm, body });

describe('normalizedDistance', () => {
  test('identical strings → 0', () => {
    expect(normalizedDistance('book', 'book')).toBe(0);
  });
  test('one-char substitution on length-4 string → 0.25', () => {
    expect(normalizedDistance('book', 'boos')).toBeCloseTo(0.25, 5);
  });
  test('adjacent transposition counted as single edit', () => {
    // book → boko = one transposition
    expect(normalizedDistance('book', 'boko')).toBeCloseTo(1 / 4, 5);
  });
});

describe('measureVocabDrift — tags', () => {
  test('singular/plural cluster at threshold 0.2', () => {
    const docs = [
      doc({ tags: ['book'] }),
      doc({ tags: ['book'] }),
      doc({ tags: ['books'] }),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    const cluster = out.tag_clusters.find((c) => c.members.includes('book'));
    expect(cluster.members.sort()).toEqual(['book', 'books']);
    expect(cluster.canonical).toBe('book');  // higher usage wins
    expect(cluster.total_uses).toBe(3);
    expect(cluster.fragmentation).toBe(1);
  });

  test('no clustering above threshold', () => {
    const docs = [doc({ tags: ['book'] }), doc({ tags: ['movie'] })];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(0);
  });

  test('case-insensitive collapse', () => {
    const docs = [doc({ tags: ['Book'] }), doc({ tags: ['BOOK'] }), doc({ tags: ['book'] })];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    const cluster = out.tag_clusters[0];
    expect(cluster.members.length).toBe(3);
  });

  test('empty vault → no clusters, drift_score 0', () => {
    const out = measureVocabDrift([], { distance_threshold: 0.2 });
    expect(out.tag_clusters).toEqual([]);
    expect(out.drift_score).toBe(0);
  });
});

describe('measureVocabDrift — wiki-links', () => {
  test('extracts wiki-link refs from body and clusters them', () => {
    const docs = [
      doc({}, 'See [[Atomic Habits]] for details.'),
      doc({}, 'Cf. [[atomic-habits]].'),
      doc({}, '[[Atomic Habits]]'),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.link_clusters.length).toBe(1);
    expect(out.link_clusters[0].members.length).toBe(2);
  });
});

describe('measureVocabDrift — drift_score', () => {
  test('fragmentation / unique_terms', () => {
    // 3 docs: tag "book", tag "books", tag "movie"
    // unique terms: 3; total fragmentation: 1
    // drift_score = 1 / 3
    const docs = [
      doc({ tags: ['book'] }),
      doc({ tags: ['books'] }),
      doc({ tags: ['movie'] }),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.drift_score).toBeCloseTo(1 / 3, 5);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy/vocab-drift.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/vocab-drift.js`**

```javascript
/**
 * vocab-drift.js — fuzzy clusters of tags + wiki-link targets.
 *
 * Detects when the same concept is referenced by near-duplicate strings
 * (`#book` / `#books`, `[[Atomic Habits]]` / `[[atomic-habits]]`).
 * Distance: case-insensitive Damerau-Levenshtein, normalized by max length.
 * Threshold defaults to 0.2 — strings closer than that cluster together.
 *
 * Pure function. Inputs are already-parsed documents.
 */

const WIKI_LINK_RE = /\[\[([^\]]+?)\]\]/g;

/**
 * @param {Array<{frontmatter, body}>} docs
 * @param {{distance_threshold: number}} cfg
 */
export function measureVocabDrift(docs, cfg) {
  const threshold = cfg.distance_threshold;

  // Collect tag usage (from frontmatter.tags arrays)
  const tagUses = new Map();
  for (const d of docs) {
    const tags = d.frontmatter?.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      tagUses.set(tag, (tagUses.get(tag) ?? 0) + 1);
    }
  }

  // Collect wiki-link target usage (from body)
  const linkUses = new Map();
  for (const d of docs) {
    if (typeof d.body !== 'string') continue;
    WIKI_LINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKI_LINK_RE.exec(d.body)) !== null) {
      const target = m[1].trim();
      linkUses.set(target, (linkUses.get(target) ?? 0) + 1);
    }
  }

  const tag_clusters = clusterTerms(tagUses, threshold);
  const link_clusters = clusterTerms(linkUses, threshold);

  const totalUnique = tagUses.size + linkUses.size;
  const totalFragmentation =
    sum(tag_clusters.map((c) => c.fragmentation)) +
    sum(link_clusters.map((c) => c.fragmentation));
  const drift_score = totalUnique === 0 ? 0 : totalFragmentation / totalUnique;

  return { tag_clusters, link_clusters, drift_score };
}

function clusterTerms(termCounts, threshold) {
  const terms = [...termCounts.keys()];
  // Union-Find over terms by normalized distance
  const parent = new Map(terms.map((t) => [t, t]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) {
      const d = normalizedDistance(terms[i].toLowerCase(), terms[j].toLowerCase());
      if (d <= threshold) union(terms[i], terms[j]);
    }
  }

  const groups = new Map();
  for (const t of terms) {
    const root = find(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }

  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;  // singletons aren't fragmentation
    let canonical = members[0];
    let bestUses = termCounts.get(canonical);
    for (const m of members) {
      if (termCounts.get(m) > bestUses) {
        canonical = m;
        bestUses = termCounts.get(m);
      }
    }
    const total_uses = sum(members.map((m) => termCounts.get(m)));
    clusters.push({
      members,
      canonical,
      total_uses,
      fragmentation: members.length - 1,
    });
  }
  return clusters;
}

/**
 * Normalized Damerau-Levenshtein distance, range [0, 1].
 * 0 = identical; 1 = entirely different.
 */
export function normalizedDistance(a, b) {
  if (a === b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const dist = damerauLevenshtein(a, b);
  return dist / maxLen;
}

function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // dp[i][j] = edits between a[0..i) and b[0..j)
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,        // deletion
        dp[i][j - 1] + 1,        // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return dp[m][n];
}

function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/entropy/vocab-drift.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/vocab-drift.js tests/entropy/vocab-drift.test.js
git commit -m "feat(entropy): vocab-drift primitive (fuzzy clustering)

Inline normalized Damerau-Levenshtein + union-find clustering over tag
and wiki-link terms. Case-insensitive comparison; canonical chosen by
highest usage. drift_score = fragmentation / unique_terms.

No new dependency — distance impl is ~25 lines.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: `lib/entropy/lifecycle.js` — stale / orphan / zombie detection

**Why:** Detects rotted docs. Stale = mtime older than threshold. Orphan = no incoming markdown links + past grace period. Zombie = status field stuck in a "draft-like" value past threshold. Reads thresholds from the entropy config; uses `lib/vault-index.js` (Task 2) for incoming-link counts.

**Files:**
- Create: `lib/entropy/lifecycle.js`
- Test: `tests/entropy/lifecycle.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/lifecycle.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { measureLifecycle } from '../../lib/entropy/lifecycle.js';

const NOW = new Date('2026-05-21T10:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400 * 1000);

const doc = ({
  filepath = '/v/notes/a.md',
  template = 'templates/note-template.md',
  frontmatter = {},
  mtime = NOW,
  created_at = NOW,
} = {}) => ({ filepath, template, frontmatter, mtime, created_at });

const defaultCfg = {
  default: {
    stale_after_days: 90,
    zombie_after_days: 30,
    orphan_grace_days: 14,
    zombie_status_set: ['in-progress', 'draft', 'wip'],
  },
  perTemplate: {},
};

describe('measureLifecycle — stale', () => {
  test('mtime older than threshold → stale', () => {
    const out = measureLifecycle(
      [doc({ mtime: daysAgo(100) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.stale_docs.length).toBe(1);
    expect(out.stale_docs[0].days_idle).toBe(100);
  });

  test('per-template override beats default', () => {
    const out = measureLifecycle(
      [doc({ template: 'templates/daily-note.md', mtime: daysAgo(10) })],
      new Map(),
      {
        default: defaultCfg.default,
        perTemplate: { 'templates/daily-note.md': { stale_after_days: 7 } },
      },
      NOW,
    );
    expect(out.stale_docs.length).toBe(1);
  });
});

describe('measureLifecycle — orphan', () => {
  test('zero incoming links past grace period → orphan', () => {
    const out = measureLifecycle(
      [doc({ filepath: '/v/notes/a.md', created_at: daysAgo(30) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.orphan_docs.length).toBe(1);
  });

  test('within grace period → not orphan', () => {
    const out = measureLifecycle(
      [doc({ created_at: daysAgo(5) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.orphan_docs.length).toBe(0);
  });

  test('one incoming link → not orphan', () => {
    const out = measureLifecycle(
      [doc({ filepath: '/v/notes/a.md', created_at: daysAgo(30) })],
      new Map([['/v/notes/a.md', 1]]),
      defaultCfg,
      NOW,
    );
    expect(out.orphan_docs.length).toBe(0);
  });
});

describe('measureLifecycle — zombie', () => {
  test('status in zombie set + stuck past threshold', () => {
    const out = measureLifecycle(
      [doc({ frontmatter: { status: 'in-progress' }, mtime: daysAgo(40) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.zombie_docs.length).toBe(1);
  });

  test('status not in zombie set → not zombie', () => {
    const out = measureLifecycle(
      [doc({ frontmatter: { status: 'done' }, mtime: daysAgo(40) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.zombie_docs.length).toBe(0);
  });
});

describe('measureLifecycle — decay_score', () => {
  test('dedupe across categories', () => {
    // 4 docs: 1 stale-only, 1 orphan-only, 1 zombie-only, 1 healthy
    // decay_score = 3 / 4
    const docs = [
      doc({ filepath: '/v/a.md', mtime: daysAgo(100), created_at: daysAgo(100) }),       // stale (also old enough to be orphan, but with backlink below)
      doc({ filepath: '/v/b.md', created_at: daysAgo(60) }),                              // orphan only
      doc({ filepath: '/v/c.md', frontmatter: { status: 'draft' }, mtime: daysAgo(40), created_at: daysAgo(40) }), // zombie only (with backlink so not orphan)
      doc({ filepath: '/v/d.md' }),                                                       // healthy
    ];
    const incoming = new Map([
      ['/v/a.md', 1], // remove a from orphan
      ['/v/c.md', 1], // remove c from orphan
    ]);
    const out = measureLifecycle(docs, incoming, defaultCfg, NOW);
    expect(out.decay_score).toBeCloseTo(3 / 4, 5);
  });

  test('empty vault → 0', () => {
    const out = measureLifecycle([], new Map(), defaultCfg, NOW);
    expect(out.decay_score).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy/lifecycle.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/lifecycle.js`**

```javascript
/**
 * lifecycle.js — stale / orphan / zombie detection.
 *
 * Inputs are pure data:
 *   - docs:    Array<{filepath, template, frontmatter, mtime, created_at}>
 *              (mtime/created_at are Date objects, supplied by caller from
 *               git log %at or fs.stat — this primitive never touches the FS)
 *   - incoming: Map<string, number>  filepath → incoming link count (Task 2)
 *   - lifecycleCfg: { default: {...}, perTemplate: {...} }  (Task 3)
 *   - now:    reference Date for "days since" math (testable)
 *
 * A doc may appear in multiple categories; decay_score counts each doc at
 * most once.
 */

const DAY_MS = 86400 * 1000;

export function measureLifecycle(docs, incoming, lifecycleCfg, now) {
  const stale_docs = [];
  const orphan_docs = [];
  const zombie_docs = [];
  const decayed = new Set();  // filepaths counted at least once

  for (const d of docs) {
    const thresholds = resolveThresholds(d.template, lifecycleCfg);

    // stale
    const daysIdle = Math.floor((now - d.mtime) / DAY_MS);
    if (daysIdle > thresholds.stale_after_days) {
      stale_docs.push({ path: d.filepath, days_idle: daysIdle, template: d.template });
      decayed.add(d.filepath);
    }

    // orphan
    const daysSinceCreated = Math.floor((now - d.created_at) / DAY_MS);
    const inCount = incoming.get(d.filepath) ?? 0;
    if (inCount === 0 && daysSinceCreated > thresholds.orphan_grace_days) {
      orphan_docs.push({
        path: d.filepath,
        incoming_links: 0,
        days_since_created: daysSinceCreated,
      });
      decayed.add(d.filepath);
    }

    // zombie
    const status = d.frontmatter?.status;
    if (
      typeof status === 'string' &&
      thresholds.zombie_status_set.includes(status) &&
      daysIdle > thresholds.zombie_after_days
    ) {
      zombie_docs.push({
        path: d.filepath,
        status_field: status,
        stuck_for_days: daysIdle,
      });
      decayed.add(d.filepath);
    }
  }

  const decay_score = docs.length === 0 ? 0 : decayed.size / docs.length;
  return { stale_docs, orphan_docs, zombie_docs, decay_score };
}

function resolveThresholds(templatePath, cfg) {
  const dflt = cfg.default;
  const override = (cfg.perTemplate ?? {})[templatePath] ?? {};
  return {
    stale_after_days: override.stale_after_days ?? dflt.stale_after_days,
    zombie_after_days: override.zombie_after_days ?? dflt.zombie_after_days,
    orphan_grace_days: override.orphan_grace_days ?? dflt.orphan_grace_days,
    zombie_status_set: override.zombie_status_set ?? dflt.zombie_status_set,
  };
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/entropy/lifecycle.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/lifecycle.js tests/entropy/lifecycle.test.js
git commit -m "feat(entropy): lifecycle primitive (stale/orphan/zombie)

Pure-function decay measurement. Caller supplies mtime/created_at Dates
(from git log or fs.stat) and incoming-link counts (from lib/vault-index).
Per-template thresholds override defaults. decay_score deduplicates docs
appearing in multiple categories.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: `lib/entropy/emergence.js` — non-template field / section candidates

**Why:** Positive entropy. Detects repeated fields and headings that documents are adding *outside* the template schema — strong signals that the template needs to grow.

**Files:**
- Create: `lib/entropy/emergence.js`
- Test: `tests/entropy/emergence.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/emergence.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { measureEmergence } from '../../lib/entropy/emergence.js';

const template = {
  path: 'templates/daily-note.md',
  fields: { date: { type: 'date' }, title: { type: 'string' } },
  sections: ['Reflections', 'Tasks'],
};

const doc = (fm, headings = []) => ({
  filepath: '/x.md',
  template: 'templates/daily-note.md',
  frontmatter: fm,
  body_headings: headings,
});

const cfg = { candidate_threshold: 0.30, min_template_docs: 10 };

describe('measureEmergence — field candidates', () => {
  test('field appearing in > threshold of docs is a candidate', () => {
    const docs = Array.from({ length: 30 }, () => doc({ date: '2026-05-21', mood: 'happy' }));
    // pad to 45 total with 15 docs lacking mood
    docs.push(...Array.from({ length: 15 }, () => doc({ date: '2026-05-21' })));
    const out = measureEmergence(docs, [template], cfg);
    const c = out.field_candidates.find((c) => c.field === 'mood');
    expect(c).toBeDefined();
    expect(c.appearances).toBe(30);
    expect(c.total_docs).toBe(45);
    expect(c.promote_confidence).toBeCloseTo(30 / 45, 5);
  });

  test('below threshold → no candidate', () => {
    const docs = [
      ...Array.from({ length: 2 }, () => doc({ date: '2026-05-21', mood: 'happy' })),
      ...Array.from({ length: 10 }, () => doc({ date: '2026-05-21' })),
    ];
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates.length).toBe(0);
  });

  test('template with < min_template_docs is skipped', () => {
    const docs = Array.from({ length: 5 }, () => doc({ date: '2026-05-21', mood: 'happy' }));
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates.length).toBe(0);
    expect(out.skipped).toContain('templates/daily-note.md');
  });

  test('suggested_primitive: enum for low-cardinality values', () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc({
      date: '2026-05-21',
      mood: i % 2 === 0 ? 'happy' : 'tired',
    }));
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates[0].suggested_primitive).toBe('enum');
    expect(out.field_candidates[0].value_samples.sort()).toEqual(['happy', 'tired']);
  });

  test('suggested_primitive: string for scattered values', () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc({
      date: '2026-05-21',
      note: `unique-${i}`,
    }));
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates[0].suggested_primitive).toBe('string');
  });
});

describe('measureEmergence — section candidates', () => {
  test('heading appearing in > threshold of docs is a candidate', () => {
    const docs = [
      ...Array.from({ length: 15 }, () => doc({ date: '2026-05-21' }, ['Reflections', 'Key Quotes'])),
      ...Array.from({ length: 5 }, () => doc({ date: '2026-05-21' }, ['Reflections'])),
    ];
    const out = measureEmergence(docs, [template], cfg);
    const c = out.section_candidates.find((c) => c.heading === 'Key Quotes');
    expect(c).toBeDefined();
    expect(c.appearances).toBe(15);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy/emergence.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/emergence.js`**

```javascript
/**
 * emergence.js — detect repeated patterns OUTSIDE the template schema.
 *
 * Inputs (pure):
 *   - docs: Array<{filepath, template, frontmatter, body_headings}>
 *           body_headings is an Array<string> of H2 heading texts in the
 *           document body (caller responsibility to extract).
 *   - templates: Array<{path, fields, sections}>
 *   - cfg: { candidate_threshold, min_template_docs }
 *
 * A field/section is a candidate when:
 *   - it is not declared in the template, AND
 *   - it appears in > candidate_threshold of that template's docs, AND
 *   - the template has ≥ min_template_docs documents.
 *
 * Templates with too few docs are listed in `skipped[]` so the report can
 * surface "I cannot tell yet".
 */

export function measureEmergence(docs, templates, cfg) {
  const byTemplate = new Map();
  for (const t of templates) byTemplate.set(t.path, t);

  /** template path → doc[] */
  const docsByTemplate = new Map();
  for (const d of docs) {
    if (!d.template || !byTemplate.has(d.template)) continue;
    if (!docsByTemplate.has(d.template)) docsByTemplate.set(d.template, []);
    docsByTemplate.get(d.template).push(d);
  }

  const field_candidates = [];
  const section_candidates = [];
  const skipped = [];

  for (const [templatePath, ds] of docsByTemplate) {
    if (ds.length < cfg.min_template_docs) {
      skipped.push(templatePath);
      continue;
    }
    const template = byTemplate.get(templatePath);
    const declaredFields = new Set(Object.keys(template.fields ?? {}));
    const declaredSections = new Set(template.sections ?? []);

    // Tally undeclared field appearances + value samples
    const fieldStats = new Map();  // fieldName → { count, values: Map<value, n> }
    for (const d of ds) {
      for (const [k, v] of Object.entries(d.frontmatter ?? {})) {
        if (declaredFields.has(k)) continue;
        if (v === null || v === undefined || v === '') continue;
        if (!fieldStats.has(k)) fieldStats.set(k, { count: 0, values: new Map() });
        const s = fieldStats.get(k);
        s.count++;
        const key = String(v);
        s.values.set(key, (s.values.get(key) ?? 0) + 1);
      }
    }
    for (const [fieldName, s] of fieldStats) {
      const ratio = s.count / ds.length;
      if (ratio <= cfg.candidate_threshold) continue;
      const uniqueRatio = s.values.size / s.count;
      const suggested_primitive = uniqueRatio < 0.5 ? 'enum' : 'string';
      const value_samples = [...s.values.keys()].slice(0, 10);
      field_candidates.push({
        template: templatePath,
        field: fieldName,
        appearances: s.count,
        total_docs: ds.length,
        value_samples,
        promote_confidence: ratio,
        suggested_primitive,
      });
    }

    // Tally undeclared body headings
    const headingStats = new Map();
    for (const d of ds) {
      for (const h of d.body_headings ?? []) {
        if (declaredSections.has(h)) continue;
        headingStats.set(h, (headingStats.get(h) ?? 0) + 1);
      }
    }
    for (const [heading, count] of headingStats) {
      const ratio = count / ds.length;
      if (ratio <= cfg.candidate_threshold) continue;
      section_candidates.push({
        template: templatePath,
        heading,
        appearances: count,
        total_docs: ds.length,
        promote_confidence: ratio,
      });
    }
  }

  return { field_candidates, section_candidates, skipped };
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/entropy/emergence.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/emergence.js tests/entropy/emergence.test.js
git commit -m "feat(entropy): emergence primitive (positive entropy)

Detects undeclared fields and H2 headings that appear in > 30% of a
template's docs — candidates for template promotion. Templates with fewer
than min_template_docs are skipped to avoid noisy promotion suggestions on
sparse data.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: `lib/entropy/distribution.js` — Gini + compression composite

**Why:** Detects monoculture (one template dominates), sprawl (no Pareto shape), AI slop (untemplated docs), and outlier docs whose frontmatter doesn't compress well relative to its template's baseline. Uses `node:zlib` (built-in).

**Files:**
- Create: `lib/entropy/distribution.js`
- Test: `tests/entropy/distribution.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/distribution.test.js`:

```javascript
import { describe, test, expect } from 'bun:test';
import { measureDistribution, gini } from '../../lib/entropy/distribution.js';

const doc = (template, fm = { a: 1, b: 2 }, folder = 'notes') => ({
  filepath: `/v/${folder}/${Math.random()}.md`,
  template,
  folder,
  frontmatter: fm,
});

describe('gini', () => {
  test('uniform distribution → 0', () => {
    expect(gini([1, 1, 1, 1])).toBeCloseTo(0, 5);
  });
  test('all in one bucket → close to 1 (n-1)/n', () => {
    // For 4 elements [4,0,0,0], classical Gini = 0.75
    expect(gini([4, 0, 0, 0])).toBeCloseTo(0.75, 2);
  });
  test('empty → null', () => {
    expect(gini([])).toBe(null);
  });
});

describe('measureDistribution', () => {
  test('template usage counts + gini', () => {
    const docs = [
      ...Array.from({ length: 20 }, () => doc('templates/daily.md')),
      ...Array.from({ length: 5 }, () => doc('templates/book.md')),
    ];
    const out = measureDistribution(docs);
    expect(out.template_usage.counts['templates/daily.md']).toBe(20);
    expect(out.template_usage.counts['templates/book.md']).toBe(5);
    expect(out.template_usage.gini).toBeGreaterThan(0);
  });

  test('untemplated count', () => {
    const docs = [doc(null), doc('templates/daily.md'), doc(null)];
    const out = measureDistribution(docs);
    expect(out.untemplated.count).toBe(2);
  });

  test('compression ratio computed', () => {
    const docs = Array.from({ length: 10 }, () => doc('templates/daily.md'));
    const out = measureDistribution(docs);
    expect(out.compression.global_ratio).toBeGreaterThan(0);
    expect(out.compression.global_ratio).toBeLessThan(1);
  });

  test('single template → gini null with verdict single_template', () => {
    const docs = Array.from({ length: 5 }, () => doc('templates/daily.md'));
    const out = measureDistribution(docs);
    expect(out.template_usage.gini).toBe(null);
    expect(out.template_usage.verdict).toBe('single_template');
  });

  test('empty corpus → safe nulls, distribution_score 0', () => {
    const out = measureDistribution([]);
    expect(out.template_usage.gini).toBe(null);
    expect(out.distribution_score).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy/distribution.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/distribution.js`**

```javascript
/**
 * distribution.js — Pareto/Gini + gzip compression composite.
 *
 * Three signals:
 *   - template_usage   Gini coefficient over docs-per-template.
 *   - folder_usage     Gini over docs-per-folder.
 *   - untemplated      Count of docs with frontmatter but no $template.
 *   - compression      gzip(frontmatter_corpus).length / corpus.length.
 *
 * distribution_score (0–1) composes them; the verdict labels are
 * informational for the skill layer.
 */

import { gzipSync } from 'node:zlib';

/**
 * @param {Array<{filepath, template, folder, frontmatter}>} docs
 */
export function measureDistribution(docs) {
  // Template usage
  const tCounts = new Map();
  let untemplated = 0;
  for (const d of docs) {
    if (!d.template) {
      untemplated++;
      continue;
    }
    tCounts.set(d.template, (tCounts.get(d.template) ?? 0) + 1);
  }
  const tValues = [...tCounts.values()];
  const tGini = tValues.length > 1 ? gini(tValues) : null;
  const tVerdict = templateUsageVerdict(tValues, tGini);

  // Folder usage
  const fCounts = new Map();
  for (const d of docs) {
    const f = d.folder ?? '';
    fCounts.set(f, (fCounts.get(f) ?? 0) + 1);
  }
  const fValues = [...fCounts.values()];
  const fGini = fValues.length > 1 ? gini(fValues) : null;

  // Compression
  const corpus = docs
    .map((d) => JSON.stringify(d.frontmatter ?? {}))
    .join('\n');
  let compression = { raw_bytes: 0, gzip_bytes: 0, global_ratio: null };
  if (corpus.length >= 100) {
    const raw = Buffer.byteLength(corpus, 'utf-8');
    const z = gzipSync(corpus).length;
    compression = { raw_bytes: raw, gzip_bytes: z, global_ratio: z / raw };
  }

  // distribution_score (0–1): combine Gini deviation from healthy band
  // [0.3, 0.7] plus untemplated ratio. Compression contributes only if
  // measurable.
  const giniPenalty = tGini === null ? 0 : Math.max(0, 0.3 - tGini) + Math.max(0, tGini - 0.7);
  const untemplatedRatio = docs.length === 0 ? 0 : untemplated / docs.length;
  const compressionPenalty =
    compression.global_ratio === null
      ? 0
      : Math.max(0, compression.global_ratio - 0.4); // healthy ≤ 0.4
  const distribution_score = clamp01(giniPenalty + untemplatedRatio + compressionPenalty);

  return {
    template_usage: {
      counts: Object.fromEntries(tCounts),
      gini: tGini,
      verdict: tVerdict,
    },
    folder_distribution: {
      counts: Object.fromEntries(fCounts),
      gini: fGini,
    },
    untemplated: { count: untemplated, ratio: untemplatedRatio },
    compression,
    distribution_score,
  };
}

/**
 * Gini coefficient on a non-empty array of non-negative numbers.
 *   G = sum_i sum_j |x_i − x_j|  /  (2 n sum_i x_i)
 * Returns null on empty input.
 */
export function gini(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const n = values.length;
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let absDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      absDiff += Math.abs(values[i] - values[j]);
    }
  }
  return absDiff / (2 * n * total);
}

function templateUsageVerdict(values, gini) {
  if (values.length === 0) return 'empty';
  if (values.length === 1) return 'single_template';
  if (gini === null) return 'unknown';
  if (gini < 0.3) return 'flat';            // every template same size
  if (gini > 0.7) return 'monoculture';     // one dominates
  return 'healthy_pareto';
}

function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/entropy/distribution.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/entropy/distribution.js tests/entropy/distribution.test.js
git commit -m "feat(entropy): distribution primitive (Gini + compression)

Gini coefficient on template and folder usage, untemplated doc count,
gzip compression ratio over frontmatter corpus. distribution_score
composes deviation from healthy Gini band [0.3, 0.7], untemplated ratio,
and compression penalty (healthy ≤ 0.4).

Uses node:zlib (built-in); no new dependency.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: `lib/entropy/measure.js` — orchestrator + barrel

**Why:** Stitches the primitives together. Reads vault config + templates from disk, runs all five primitives, aggregates the score, and returns the `EntropyReport`. The only file in `lib/entropy/` that touches the FS.

**Files:**
- Create: `lib/entropy/measure.js`
- Create: `lib/entropy/index.js`
- Test: `tests/entropy/measure.integration.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy/measure.integration.test.js`:

```javascript
/**
 * Integration test for measure.js — builds a tiny vault on disk and asserts
 * the EntropyReport shape end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureEntropy } from '../../lib/entropy/measure.js';

let tmp;
beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-measure-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const VK_CONFIG = JSON.stringify({
  vaultRoot: '.',
  vaultFolders: ['notes'],
  entropy: {},
});

const TEMPLATE = `---
template_path: templates/note-template.md
document_type: note
fields:
  title:
    type: string
    required: true
  status:
    type: string
    enum: [draft, review, done]
---

# Note template

\`\`\`yaml section-rules
required: false
\`\`\`

## Reflections
`;

function writeDoc(name, fm, body = '') {
  writeFileSync(
    join(tmp, 'notes', name),
    `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}`,
  );
}

describe('measureEntropy — integration', () => {
  test('returns full EntropyReport shape on a populated vault', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'vault-keeper.json'), VK_CONFIG);
    mkdirSync(join(tmp, 'templates'), { recursive: true });
    writeFileSync(join(tmp, 'templates', 'note-template.md'), TEMPLATE);
    mkdirSync(join(tmp, 'notes'), { recursive: true });

    writeDoc('a.md', { template: 'templates/note-template.md', title: 'A', status: 'draft' });
    writeDoc('b.md', { template: 'templates/note-template.md', title: 'B', status: 'done' });

    const report = await measureEntropy({ vaultRoot: tmp });

    expect(report.schema_version).toBe(1);
    expect(typeof report.measured_at).toBe('string');
    expect(report.vault_root).toBe(tmp);
    expect(typeof report.overall_score).toBe('number');
    expect(report.dimensions.schema).toBeDefined();
    expect(report.dimensions.vocab).toBeDefined();
    expect(report.dimensions.lifecycle).toBeDefined();
    expect(report.dimensions.distribution).toBeDefined();
    expect(Array.isArray(report.emergence.field_candidates)).toBe(true);
    expect(report.stats.total_docs).toBe(2);
  });

  test('empty vault → safe nulls', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'vault-keeper.json'), VK_CONFIG);
    mkdirSync(join(tmp, 'notes'), { recursive: true });

    const report = await measureEntropy({ vaultRoot: tmp });
    expect(report.stats.total_docs).toBe(0);
    expect(report.overall_score).toBe(null);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy/measure.integration.test.js`
Expected: module not found.

- [ ] **Step 3: Implement `lib/entropy/measure.js`**

```javascript
/**
 * measure.js — orchestrator that runs all entropy primitives over a vault.
 *
 * The only file in lib/entropy/ that does I/O. Steps:
 *   1. Load vault config (vault-folders, exclude patterns, entropy block).
 *   2. Walk vault, parse each .md via parseDocument.
 *   3. Load templates referenced by docs.
 *   4. Extract body H2 headings for emergence detection.
 *   5. Pull mtime + created_at from fs.stat (git timestamps are an
 *      optimization to add later — fs.stat is correct, just less precise
 *      on freshly-cloned repos).
 *   6. Count incoming links via lib/vault-index.
 *   7. Run schema-drift / vocab-drift / lifecycle / emergence / distribution
 *      in parallel.
 *   8. Aggregate via score.js.
 *   9. Return EntropyReport.
 */

import { stat, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from '../doc-io.js';
import { loadTemplateRules } from '../template-rules.js';
import { loadVaultConfig } from '../vault-config.js';
import { countIncomingLinks } from '../vault-index.js';
import { resolveEntropyConfig } from './defaults.js';
import { measureSchemaDrift } from './schema-drift.js';
import { measureVocabDrift } from './vocab-drift.js';
import { measureLifecycle } from './lifecycle.js';
import { measureEmergence } from './emergence.js';
import { measureDistribution } from './distribution.js';
import { aggregateScore, dimensionHealth } from './score.js';

const HEADING_RE = /^##\s+(.+?)\s*$/gm;
const SKIP_DIRS = new Set(['node_modules', '.git', '.omc', '.vault-keeper']);

/**
 * @param {{vaultRoot: string, now?: Date}} opts
 * @returns {Promise<object>} EntropyReport
 */
export async function measureEntropy(opts) {
  const start = Date.now();
  const vaultRoot = resolve(opts.vaultRoot);
  const now = opts.now ?? new Date();
  const measured_at = now.toISOString();
  const vaultCfg = loadVaultConfig(vaultRoot);
  const entropyCfg = resolveEntropyConfig(vaultCfg.entropy);

  // Walk vault folders for .md files
  const files = [];
  for (const folder of vaultCfg.vaultFolders) {
    const root = folder === '.' ? vaultRoot : join(vaultRoot, folder);
    files.push(...(await walkMarkdown(root)));
  }

  // Parse documents + collect mtime/ctime
  const docs = [];
  const templatePathsToLoad = new Set();
  for (const filepath of files) {
    const parsed = await parseDocument(filepath);
    if (parsed.error) continue;
    let mtime = now, created_at = now;
    try {
      const s = await stat(filepath);
      mtime = s.mtime;
      created_at = s.birthtime && s.birthtime.getTime() > 0 ? s.birthtime : s.mtime;
    } catch { /* leave defaults */ }
    const headings = extractHeadings(parsed.body ?? '');
    const folder = relativeFolder(vaultRoot, filepath);
    const templateRef = typeof parsed.frontmatter?.template === 'string'
      ? parsed.frontmatter.template
      : null;
    if (templateRef) templatePathsToLoad.add(templateRef);
    docs.push({
      filepath,
      template: templateRef,
      frontmatter: parsed.frontmatter ?? {},
      body: parsed.body ?? '',
      body_headings: headings,
      folder,
      mtime,
      created_at,
    });
  }

  // Load templates referenced by at least one doc
  const templates = [];
  for (const tp of templatePathsToLoad) {
    const rules = await loadTemplateRules(tp, vaultRoot);
    if (rules) {
      templates.push({
        path: tp,
        fields: rules.fields ?? {},
        sections: rules.sections ?? [],
      });
    }
  }

  // Incoming links
  const incoming = new Map();
  for (const folder of vaultCfg.vaultFolders) {
    const root = folder === '.' ? vaultRoot : join(vaultRoot, folder);
    const folderCounts = await countIncomingLinks(root);
    for (const [k, v] of folderCounts) {
      incoming.set(k, (incoming.get(k) ?? 0) + v);
    }
  }

  // Run primitives
  const schema = measureSchemaDrift(docs, templates);
  const vocab = measureVocabDrift(docs, entropyCfg.vocab);
  const lifecycle = measureLifecycle(docs, incoming, entropyCfg.lifecycle, now);
  const emergence = measureEmergence(docs, templates, entropyCfg.emergence);
  const distribution = measureDistribution(docs);

  const chaos = {
    schema: docs.length === 0 ? null : schema.global_drift_score,
    vocab: docs.length === 0 ? null : vocab.drift_score,
    lifecycle: docs.length === 0 ? null : lifecycle.decay_score,
    distribution: docs.length === 0 ? null : distribution.distribution_score,
  };
  const overall_score = aggregateScore(chaos, entropyCfg.weights);

  return {
    schema_version: 1,
    measured_at,
    vault_root: vaultRoot,
    git_head: getGitHead(vaultRoot),
    overall_score,
    dimensions: {
      schema:       { score: dimensionHealth(chaos.schema),       details: schema },
      vocab:        { score: dimensionHealth(chaos.vocab),        details: vocab },
      lifecycle:    { score: dimensionHealth(chaos.lifecycle),    details: lifecycle },
      distribution: { score: dimensionHealth(chaos.distribution), details: distribution },
    },
    emergence,
    stats: {
      total_docs: docs.length,
      total_templates: templates.length,
      scan_duration_ms: Date.now() - start,
    },
  };
}

async function walkMarkdown(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.specify') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}

function extractHeadings(body) {
  HEADING_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = HEADING_RE.exec(body)) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function relativeFolder(vaultRoot, filepath) {
  const rel = dirname(filepath).slice(vaultRoot.length).replace(/^\/+/, '');
  return rel || '.';
}

function getGitHead(vaultRoot) {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: vaultRoot,
      encoding: 'utf-8',
    });
    if (r.status === 0) return r.stdout.trim();
  } catch { /* git unavailable */ }
  return null;
}
```

- [ ] **Step 4: Implement `lib/entropy/index.js`**

```javascript
/**
 * Public barrel for the entropy engine. Stable external surface for both
 * the CLI subcommand and any future consumers.
 */

export { measureEntropy } from './measure.js';
export { writeSnapshot, readLatestSnapshot, listSnapshots, diffSnapshots } from './snapshot.js';
export { aggregateScore, dimensionHealth } from './score.js';
export { ENTROPY_DEFAULTS, resolveEntropyConfig } from './defaults.js';
```

- [ ] **Step 5: Verify integration test passes**

Run: `bun test tests/entropy/measure.integration.test.js`
Expected: both tests pass.

Also run the full entropy suite + full repo:

```
bun test tests/entropy 2>&1 | tail -10
bun test ./tests 2>&1 | tail -10
```

Expected: all previously-passing tests still pass; entropy tests all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/entropy/measure.js lib/entropy/index.js tests/entropy/measure.integration.test.js
git commit -m "feat(entropy): orchestrator + public barrel

measure.js is the only entropy file that does I/O — walks vault, parses
docs, loads referenced templates, counts incoming links, runs all five
primitives in parallel, aggregates the score, returns EntropyReport.

index.js re-exports the public surface (measureEntropy, snapshot helpers,
score helpers, defaults).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: `cli/entropy.js` + wire into `cli/main.js`

**Why:** Expose the engine as `vault-keeper entropy [--json] [--no-snapshot] [--diff] [--history] [--root <path>]`. Always exits 0 on successful measurement (gradient, not pass/fail).

**Files:**
- Create: `cli/entropy.js`
- Modify: `cli/main.js`
- Test: `tests/entropy-cli.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/entropy-cli.test.js`:

```javascript
/**
 * End-to-end test for `vault-keeper entropy` CLI.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let tmp;
const CLI = join(import.meta.dir, '..', 'cli', 'main.js');

beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-cli-ent-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function setupVault() {
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  writeFileSync(
    join(tmp, '.claude', 'vault-keeper.json'),
    JSON.stringify({ vaultRoot: '.', vaultFolders: ['notes'] }),
  );
  mkdirSync(join(tmp, 'templates'), { recursive: true });
  writeFileSync(
    join(tmp, 'templates', 'note-template.md'),
    `---
template_path: templates/note-template.md
document_type: note
fields:
  title: { type: string, required: true }
  status: { type: string, enum: [draft, done] }
---
# Note
\`\`\`yaml section-rules
required: false
\`\`\`
## Reflections
`,
  );
  mkdirSync(join(tmp, 'notes'), { recursive: true });
  writeFileSync(
    join(tmp, 'notes', 'a.md'),
    `---\ntemplate: templates/note-template.md\ntitle: A\nstatus: draft\n---\n# A\n`,
  );
  writeFileSync(
    join(tmp, 'notes', 'b.md'),
    `---\ntemplate: templates/note-template.md\ntitle: B\nstatus: done\n---\n# B\n`,
  );
}

describe('vault-keeper entropy', () => {
  test('--json emits valid EntropyReport, exit 0, writes snapshot', () => {
    setupVault();
    const r = spawnSync('node', [CLI, 'entropy', '--json', '--root', tmp], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.stats.total_docs).toBe(2);
    expect(existsSync(join(tmp, '.vault-keeper', 'snapshots', 'latest.json'))).toBe(true);
  });

  test('--no-snapshot does not persist', () => {
    setupVault();
    const r = spawnSync('node', [CLI, 'entropy', '--json', '--no-snapshot', '--root', tmp], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, '.vault-keeper'))).toBe(false);
  });

  test('human output without --json', () => {
    setupVault();
    const r = spawnSync('node', [CLI, 'entropy', '--root', tmp], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Overall health');
    expect(r.stdout).toContain('Schema drift');
    expect(r.stdout).toContain('Vocab drift');
  });

  test('--diff requires two snapshots', () => {
    setupVault();
    spawnSync('node', [CLI, 'entropy', '--json', '--root', tmp], { encoding: 'utf-8' });
    // Second measurement with a slightly delayed timestamp by adding a doc
    writeFileSync(join(tmp, 'notes', 'c.md'),
      `---\ntemplate: templates/note-template.md\ntitle: C\nstatus: done\n---\n# C\n`);
    spawnSync('node', [CLI, 'entropy', '--json', '--root', tmp], { encoding: 'utf-8' });

    const r = spawnSync('node', [CLI, 'entropy', '--diff', '--root', tmp], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Schema|Vocab|Lifecycle|Distribution/);
  });

  test('--history lists snapshots', () => {
    setupVault();
    spawnSync('node', [CLI, 'entropy', '--root', tmp], { encoding: 'utf-8' });
    const r = spawnSync('node', [CLI, 'entropy', '--history', '--root', tmp], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2026-/); // ISO timestamp in row
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/entropy-cli.test.js`
Expected: tests fail because `cli/entropy.js` does not exist and `cli/main.js` does not dispatch `entropy`.

- [ ] **Step 3: Implement `cli/entropy.js`**

```javascript
#!/usr/bin/env node
/**
 * cli/entropy.js — `vault-keeper entropy` subcommand.
 *
 * Always exits 0 on successful measurement; entropy is a gradient, CI gating
 * is the caller's responsibility (parse JSON + threshold check).
 */

import { resolve } from 'node:path';
import {
  measureEntropy,
  writeSnapshot,
  readLatestSnapshot,
  listSnapshots,
  diffSnapshots,
} from '../lib/entropy/index.js';

const USAGE = `vault-keeper entropy [options]

Measure vault entropy across 4 dimensions and write a snapshot.

Options:
  --root <path>     Vault project root (else CLAUDE_PROJECT_DIR, else cwd)
  --json            Emit EntropyReport JSON to stdout
  --no-snapshot     Do not persist a snapshot
  --diff[=<spec>]   Compare latest vs previous snapshot; print delta
                    (spec is reserved for future "14d" support)
  --history         List existing snapshots
  --help            Show this help

Exit code: always 0 on successful measurement. Entropy is a gradient — CI
gating is the caller's job (parse JSON, threshold against overall_score).
`;

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = args.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const vaultRoot = resolve(root);

  if (args.history) {
    return renderHistory(vaultRoot);
  }
  if (args.diff) {
    return renderDiff(vaultRoot);
  }

  const report = await measureEntropy({ vaultRoot });

  if (!args.noSnapshot) {
    writeSnapshot(report, vaultRoot);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(report) + '\n');
  }
  return 0;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-snapshot') out.noSnapshot = true;
    else if (a === '--history') out.history = true;
    else if (a === '--diff' || a.startsWith('--diff=')) out.diff = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
  }
  return out;
}

function renderHuman(report) {
  const lines = [];
  lines.push(`vault-keeper entropy — ${report.vault_root}`);
  lines.push(`Snapshot: ${report.measured_at}` + (report.git_head ? ` (git: ${report.git_head})` : ''));
  lines.push('');
  lines.push(`Overall health: ${formatScore(report.overall_score)}/100`);
  for (const dim of ['schema', 'vocab', 'lifecycle', 'distribution']) {
    const label = ({ schema: 'Schema drift', vocab: 'Vocab drift', lifecycle: 'Lifecycle decay', distribution: 'Distribution' })[dim];
    const score = report.dimensions[dim].score;
    lines.push(`  ${label.padEnd(16)} ${formatScore(score)}  ${verdict(score)}`);
  }
  const emergCount = report.emergence.field_candidates.length + report.emergence.section_candidates.length;
  lines.push(`  Pattern garden   ${emergCount} candidate${emergCount === 1 ? '' : 's'} emerging`);
  lines.push('');
  lines.push(`${report.stats.total_docs} docs · ${report.stats.total_templates} templates · scan ${report.stats.scan_duration_ms}ms`);
  return lines.join('\n');
}

function formatScore(s) {
  if (s === null || s === undefined) return ' --';
  return String(s).padStart(3, ' ');
}

function verdict(score) {
  if (score === null) return '— n/a';
  if (score >= 80) return '✓ healthy';
  if (score >= 60) return '⚠ moderate';
  return '✗ degraded';
}

function renderDiff(vaultRoot) {
  const snapshots = listSnapshots(vaultRoot);
  if (snapshots.length < 2) {
    process.stderr.write('Need at least 2 snapshots to diff. Run `vault-keeper entropy` twice.\n');
    return 0;
  }
  const after = snapshots[snapshots.length - 1];
  const before = snapshots[snapshots.length - 2];
  const delta = diffSnapshots(before, after);
  process.stdout.write(
    `Elapsed: ${delta.elapsed_days.toFixed(1)} days\n` +
    `Overall: ${before.overall_score} → ${after.overall_score} (${signed(delta.overall_delta)})\n` +
    Object.entries(delta.dimensions).map(([k, v]) =>
      `  ${k.padEnd(14)} ${v.before} → ${v.after} (${signed(v.delta)})`).join('\n') + '\n',
  );
  return 0;
}

function renderHistory(vaultRoot) {
  const snapshots = listSnapshots(vaultRoot);
  if (snapshots.length === 0) {
    process.stdout.write('No snapshots yet. Run `vault-keeper entropy` to create one.\n');
    return 0;
  }
  for (const s of snapshots) {
    process.stdout.write(`${s.measured_at}  score=${s.overall_score ?? 'null'}  docs=${s.stats.total_docs}\n`);
  }
  return 0;
}

function signed(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return ' n/a';
  return (n >= 0 ? '+' : '') + n;
}
```

- [ ] **Step 4: Wire dispatch into `cli/main.js`**

Open `cli/main.js`. Two edits:

(a) Update the top-of-file JSDoc subcommand list — append after `init [dir]`:
```
 *   entropy                      — measure vault entropy gradient (4 dims) + snapshot
```

(b) Append to `USAGE_MAIN` after the `init` line:
```
  entropy                      Measure vault entropy gradient + snapshot
```

(c) Add a `USAGE_SUB.entropy` entry next to the other usage strings:
```javascript
  entropy: `vault-keeper entropy [options]

Measure vault entropy across 4 dimensions (schema drift, vocab drift,
lifecycle decay, distribution health). Snapshots persist to
<vault>/.vault-keeper/snapshots/ for trend analysis.

Options:
  --root <path>     Vault root (else CLAUDE_PROJECT_DIR, else cwd)
  --json            Emit machine-readable EntropyReport
  --no-snapshot     Do not persist a snapshot
  --diff            Compare latest vs previous snapshot
  --history         List existing snapshots

Exit code: always 0 on successful measurement. Entropy is a gradient.
`,
```

(d) Inside the `switch (subcommand)` block, add a case before `default`:

```javascript
    case 'entropy': {
      const mod = await import('./entropy.js');
      return await mod.main(rest);
    }
```

- [ ] **Step 5: Verify CLI tests pass**

Run: `bun test tests/entropy-cli.test.js`
Expected: all 5 tests pass.

Also run the full suite to catch any regression in `cli-main.test.js`:

```
bun test ./tests 2>&1 | tail -15
```

Expected: all previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add cli/entropy.js cli/main.js tests/entropy-cli.test.js
git commit -m "feat(cli): vault-keeper entropy subcommand

New 'entropy' subcommand exposes the measurement engine with --json,
--no-snapshot, --diff, --history, --root flags. Always exits 0 on
successful measurement (gradient, not pass/fail). Snapshots persist to
<vault>/.vault-keeper/snapshots/ by default.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 13: Public API + `lib/index.js` re-export

**Why:** Power users may want to call the engine programmatically (`import { measureEntropy } from 'claude-code-vault-keeper'`). Add the named re-export to the public barrel and to `package.json` exports.

**Files:**
- Modify: `lib/index.js`
- Modify: `package.json`
- Test: `tests/public-api.test.js` (existing — append cases)

- [ ] **Step 1: Write the failing test**

Open `tests/public-api.test.js`. Append a `describe` block:

```javascript
describe('public API — entropy', () => {
  test('exports measureEntropy', async () => {
    const mod = await import('../lib/index.js');
    expect(typeof mod.measureEntropy).toBe('function');
  });

  test('exports ENTROPY_DEFAULTS', async () => {
    const mod = await import('../lib/index.js');
    expect(mod.ENTROPY_DEFAULTS).toBeDefined();
    expect(mod.ENTROPY_DEFAULTS.weights.schema).toBe(0.30);
  });

  test('exports snapshot helpers', async () => {
    const mod = await import('../lib/index.js');
    expect(typeof mod.writeSnapshot).toBe('function');
    expect(typeof mod.readLatestSnapshot).toBe('function');
    expect(typeof mod.diffSnapshots).toBe('function');
  });

  test('package.json exposes ./entropy entry', async () => {
    const pkg = JSON.parse(await Bun.file('package.json').text());
    expect(pkg.exports['./entropy']).toBe('./lib/entropy/index.js');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `bun test tests/public-api.test.js`
Expected: 4 new failures (named exports + package.json entry missing).

- [ ] **Step 3: Add re-exports in `lib/index.js`**

Open `lib/index.js`. Append a section before the package metadata block at the bottom:

```javascript
// ── Entropy engine ────────────────────────────────────────────────────────
export {
  measureEntropy,
  writeSnapshot,
  readLatestSnapshot,
  listSnapshots,
  diffSnapshots,
  aggregateScore,
  dimensionHealth,
  ENTROPY_DEFAULTS,
  resolveEntropyConfig,
} from "./entropy/index.js";
```

- [ ] **Step 4: Add `./entropy` exports entry in `package.json`**

In `package.json` `exports` block, after the `"./vault-config"` line, add:

```json
    "./entropy": "./lib/entropy/index.js",
```

- [ ] **Step 5: Verify pass**

Run: `bun test tests/public-api.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/index.js package.json tests/public-api.test.js
git commit -m "feat(api): expose entropy engine via public API

\`import { measureEntropy } from 'claude-code-vault-keeper'\` now works,
plus the snapshot helpers and ENTROPY_DEFAULTS. New \`./entropy\` deep
import for consumers that want only the engine.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 14: Skill `skills/vault.garden/SKILL.md`

**Why:** The user-facing entry point that orchestrates measure → suggest → approve → execute → remeasure. Markdown only — no code — so LLMs at runtime know exactly which steps to follow.

**Files:**
- Create: `skills/vault.garden/SKILL.md`

- [ ] **Step 1: Write the skill (no test — it's an LLM prompt, exercised by smoke)**

Create `skills/vault.garden/SKILL.md`:

````markdown
---
name: vault.garden
description: "Gardener-style vault maintenance — runs `vault-keeper entropy --json` to measure 4 chaos dimensions (schema drift, vocab drift, lifecycle decay, distribution health), surfaces emergence patterns, proposes context-aware pruning actions, applies per-batch with approval, remeasures to confirm entropy dropped. Closed loop. Modifies files (delegates deterministic edits to `/vault.fix`, performs semantic edits directly). Use when user says 'cắt tỉa vault', 'garden vault', 'prune vault', 'vault health gradient', 'vault entropy', 'cleanup drift', '/vault.garden'."
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

```
vault-keeper entropy --json --root "${CLAUDE_PROJECT_DIR:-$PWD}"
```

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
  "summary": "Merge #book + #books → #book (45 uses across 12 files)",
  "evidence": { ... },
  "actions": [ { "kind": "find_replace_tag", "from": "#books", "to": "#book", "files_affected": 12 } ],
  "confidence": 0.92,
  "reversibility": "reversible",
  "delegated_to": "vault.fix" | "skill_direct"
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

Per proposal, dispatch by `delegated_to`:

- `"vault.fix"` → run `vault-keeper fix --paths=<comma-joined-list>` (existing deterministic formatter).
- `"skill_direct"` → use the `Edit` / `Write` tool directly. Examples:
  - **prune** → move file to `<vault>/archive/<YYYY>/<basename>`.
  - **graft** → find-replace the canonical-vs-variant in body / frontmatter across the listed files.
  - **promote** → edit the template file's `fields:` block (add an optional entry).
  - **retire** → delete the template file (already confirmed zero usage).
  - **compost** → edit the doc's `status:` field.

Actions inside a batch run **serially**, not in parallel — one action may produce a file the next reads.

**Failure handling:** on any action failure within a batch, stop the batch, render the error, ask `[c]ontinue · [r]ollback batch · [q]uit`. Rollback uses the session log at `.vault-keeper/garden-session-<sessionId>.log` plus `git checkout -- <files>`. The pre-flight clean-vault check makes rollback safe.

## Phase 5 — Remeasure

Re-run:

```
vault-keeper entropy --json --root "${CLAUDE_PROJECT_DIR:-$PWD}"
```

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
````

- [ ] **Step 2: Smoke-check the skill via the existing `tests/skills-lint.test.js`**

Run: `bun test tests/skills-lint.test.js`
Expected: passes (the lint validates frontmatter shape; the new skill follows the same shape as `vault.health`).

If it fails because of an unknown skill name, open `tests/skills-lint.test.js` and check whether it has an allow-list of skill names. If yes, add `vault.garden` to it.

- [ ] **Step 3: Commit**

```bash
git add skills/vault.garden/SKILL.md
git commit -m "feat(skill): vault.garden — gardener-style maintenance loop

Closed-loop LLM-orchestrated skill: measure (calls vault-keeper entropy)
→ suggest (5 action verbs: prune/graft/promote/retire/compost) →
approve (batched per verb, most reversible first) → execute (delegate
to /vault.fix for deterministic edits, Edit directly for semantic) →
remeasure + delta.

Distinct from /vault.health (binary read-only). Modifies files but does
NOT auto-commit, push, or delete docs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 15: Documentation

**Why:** Without docs the new feature is invisible. Two updates: append an `Entropy gardener` section to `docs/architecture.md` (so future contributors understand the layer) + create `docs/vault-garden.md` (user-facing reference).

**Files:**
- Modify: `docs/architecture.md`
- Create: `docs/vault-garden.md`

- [ ] **Step 1: Append to `docs/architecture.md`**

Append at the end of `docs/architecture.md`:

````markdown

## Entropy gardener

The `vault-keeper entropy` subcommand (`cli/entropy.js`) measures the vault on
four chaos dimensions and persists snapshots; the `/vault.garden` skill consumes
that output and runs a gardener-style measure → suggest → execute → remeasure loop.

```
cli/entropy.js                  → vault-keeper entropy [--json|--diff|--history]
lib/entropy/                    pure deterministic measurement (no LLM)
  ├── measure.js                orchestrator (only file with I/O)
  ├── schema-drift.js           Shannon-entropy on frontmatter
  ├── vocab-drift.js            fuzzy cluster tags + wiki-links
  ├── lifecycle.js              stale / orphan / zombie detection
  ├── emergence.js              non-template field/section candidates
  ├── distribution.js           Gini + gzip compression composite
  ├── score.js                  weighted aggregation → 0–100
  ├── snapshot.js               read / write / diff snapshot JSON
  └── defaults.js               engine-side default thresholds
lib/vault-index.js              countIncomingLinks() — pure FN extracted
                                from server/vault-index.js so CLI can use it
skills/vault.garden/SKILL.md    LLM-orchestrated loop
<vault>/.vault-keeper/snapshots/  git-trackable snapshot history
```

The split mirrors the rest of the repo: deterministic logic lives in `lib/`,
judgment lives in the skill (where the LLM gets to reason). Snapshots live at
the vault root (artifact space) and never under `.claude/` (config space).

For the user-facing reference, see `docs/vault-garden.md`.
````

- [ ] **Step 2: Create `docs/vault-garden.md`**

```markdown
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

## Snapshots

Each run writes `<vault>/.vault-keeper/snapshots/<ISO-timestamp>.json` plus a
`latest.json` copy. The plugin does not auto-modify `.gitignore`; the
suggestion is to track snapshots in git so the antifragility story is
auditable.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/vault-garden.md
git commit -m "docs: entropy gardener — architecture section + user reference

architecture.md gets a new section explaining the engine split (pure
deterministic logic in lib/entropy/, LLM judgment in skills/vault.garden).
vault-garden.md is the user-facing reference covering the mental model,
CLI flags, skill loop, configuration shape, and snapshot model.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-review checklist (post-write)

After all 15 tasks are written, run this checklist:

- [ ] **Spec coverage:** every spec section (1–12) has at least one task implementing it. Section 5 (snapshot) → Task 4. Section 6 (skill) → Task 14. Section 9 (config) → Task 1. Section 10 (build sequence) is reflected in task ordering 2 → 3 → 4 → 5 → 6–10 → 11 → 12 → 14 → 15.
- [ ] **Placeholder scan:** every task has runnable test code, runnable implementation code, and concrete commit messages. No "TBD", "TODO", "similar to Task N".
- [ ] **Type consistency:** `measureEntropy({ vaultRoot })` shape consistent across Task 11 (definition) and Task 13 (public export test). Snapshot shape (`schema_version`, `measured_at`, `vault_root`, `git_head`, `overall_score`, `dimensions`, `emergence`, `stats`) consistent across snapshot.js (Task 4), measure.js (Task 11), and skill (Task 14).
- [ ] **CLI flag surface** in `cli/entropy.js` (Task 12) matches the documented options in `docs/vault-garden.md` (Task 15).

## Final verification (run after all tasks pass)

After Task 15 commits, run the full smoke + test pipeline:

```
bun test ./tests 2>&1 | tail -20
bun run smoke 2>&1 | tail -10
bun run build 2>&1 | tail -8 && ls -la server/main.bundled.cjs
```

Expected:
- All tests pass.
- Both smoke scripts pass.
- LSP bundle builds without size regression (≈ 1.5 MB).

Then exercise the CLI manually on the example vault:

```
cd examples/example
../../cli/main.js entropy
../../cli/main.js entropy --json | head -40
../../cli/main.js entropy --history
```

Expected: human report + JSON shape + history listing.
