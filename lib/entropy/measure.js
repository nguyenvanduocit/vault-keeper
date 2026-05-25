/**
 * measure.js — orchestrator that runs all entropy primitives over a vault.
 *
 * The only file in lib/entropy/ that does I/O. Steps:
 *   1. Load vault config (vault-folders, exclude patterns, entropy block).
 *   2. Walk vault, parse each .md via parseDocument.
 *   3. Load templates referenced by docs.
 *   4. Extract body H2 headings for emergence detection.
 *   5. Pull mtime + created_at from git commit history (committer dates):
 *      mtime = last commit touching the file, created_at = first commit that
 *      added it. fs.stat mtime/birthtime is wrong on git repos and fresh
 *      clones (every file shares the clone time), so git is the source of
 *      truth; fs.stat is the fallback only for untracked paths / non-git roots.
 *   6. Count incoming links via lib/vault-index.
 *   7. Run schema-drift / vocab-drift / lifecycle / emergence / distribution
 *      in parallel.
 *   8. Aggregate via score.js.
 *   9. Return EntropyReport.
 */

import { stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from '../doc-io.js';
import { loadTemplateRules } from '../template-rules.js';
import { loadVaultConfig } from '../vault-config.js';
import { countIncomingLinks } from '../vault-index.js';
import { walkVaultMarkdown } from '../walk-vault.js';
import { resolveEntropyConfig } from './defaults.js';
import { measureSchemaDrift } from './schema-drift.js';
import { measureVocabDrift } from './vocab-drift.js';
import { measureLifecycle } from './lifecycle.js';
import { measureEmergence } from './emergence.js';
import { measureDistribution } from './distribution.js';
import { aggregateScore, dimensionHealth } from './score.js';

const HEADING_RE = /^##\s+(.+?)\s*$/gm;

/**
 * @param {{vaultRoot: string, now?: Date, getDocDates?: function}} opts
 *   getDocDates(absPath) → {mtime: Date, created_at: Date} — injectable for
 *   tests; defaults to a single-pass git-log lookup with fs.stat fallback.
 * @returns {Promise<object>} EntropyReport
 */
export async function measureEntropy(opts) {
  const start = Date.now();
  const vaultRoot = resolve(opts.vaultRoot);
  const now = opts.now ?? new Date();
  const getDocDates = opts.getDocDates ?? makeGitDateLookup(vaultRoot, now);
  const measured_at = now.toISOString();
  const vaultCfg = loadVaultConfig(vaultRoot);
  const entropyCfg = resolveEntropyConfig(vaultCfg.entropy);

  const files = [];
  for (const folder of vaultCfg.vaultFolders) {
    const root = folder === '.' ? vaultRoot : join(vaultRoot, folder);
    files.push(...(await walkVaultMarkdown(root, {
      excludePatterns: vaultCfg.excludePatterns,
    })));
  }

  const docs = [];
  const templatePathsToLoad = new Set();
  for (const filepath of files) {
    const parsed = await parseDocument(filepath);
    if (parsed.error) continue;
    const { mtime, created_at } = await getDocDates(filepath);
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

  const templates = [];
  const missingTemplates = new Set();
  for (const tp of templatePathsToLoad) {
    const rules = await loadTemplateRules(tp, vaultRoot);
    if (rules) {
      templates.push({
        path: tp,
        fields: rules.fields ?? {},
        sections: rules.sections ?? [],
      });
    } else {
      // Doc references a template file that doesn't exist or fails to load.
      // Surface as a health flag (not a dimension score adjustment) so the
      // gardener can raise the alarm — silent drop would let a vault with
      // broken refs score 100 because schema-drift sees no template.
      missingTemplates.add(tp);
    }
  }

  const incoming = new Map();
  for (const folder of vaultCfg.vaultFolders) {
    const root = folder === '.' ? vaultRoot : join(vaultRoot, folder);
    const folderCounts = await countIncomingLinks(root, {
      excludePatterns: vaultCfg.excludePatterns,
    });
    for (const [k, v] of folderCounts) {
      incoming.set(k, (incoming.get(k) ?? 0) + v);
    }
  }

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
    health_flags: {
      missing_templates: [...missingTemplates].sort(),
    },
  };
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

/**
 * Build a `getDocDates(absPath)` lookup backed by a SINGLE git-log pass.
 *
 * `git log --format='C%ct' --name-only` emits, newest→oldest, a `C<ct>` line
 * per commit followed by the paths it touched (committer epoch seconds). We
 * walk that stream once and, per file, record:
 *   - last_ct  = the FIRST time we see the path (newest commit touching it)
 *   - first_ct = the LAST time we see it (oldest commit that added it)
 * Git paths are repo-relative; we key the map by `join(gitRoot, relPath)` so
 * it matches the absolute `filepath` measure.js holds. gitRoot comes from
 * `git rev-parse --show-toplevel` (the vault may be a subdir of the repo).
 *
 * Falls back to fs.stat ONLY when the path is not tracked by git, or when the
 * root is not a git repo at all (a genuine environment condition — fresh
 * unversioned scratch dir, e.g. the integration tests' mkdtemp vault).
 */
function makeGitDateLookup(vaultRoot, now) {
  const gitRoot = resolveGitRoot(vaultRoot);
  const dates = gitRoot ? buildGitDateMap(gitRoot) : null;

  return async function getDocDates(absPath) {
    const hit = dates?.get(absPath);
    if (hit) {
      return {
        mtime: new Date(hit.last_ct * 1000),
        created_at: new Date(hit.first_ct * 1000),
      };
    }
    return statDates(absPath, now);
  };
}

function resolveGitRoot(vaultRoot) {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: vaultRoot,
      encoding: 'utf-8',
    });
    if (r.status === 0 && r.stdout.trim()) return resolve(r.stdout.trim());
  } catch { /* git unavailable */ }
  return null;
}

/** Single git-log pass → Map<absPath, {first_ct, last_ct}>. */
function buildGitDateMap(gitRoot) {
  const map = new Map();
  let out;
  try {
    const r = spawnSync(
      'git',
      ['-C', gitRoot, 'log', '--format=C%ct', '--name-only', '--no-renames'],
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 256 },
    );
    if (r.status !== 0 || typeof r.stdout !== 'string') return map;
    out = r.stdout;
  } catch {
    return map;
  }

  let currentCt = null;
  for (const line of out.split('\n')) {
    if (line === '') continue;
    if (line[0] === 'C' && /^C\d+$/.test(line)) {
      currentCt = Number(line.slice(1));
      continue;
    }
    if (currentCt === null) continue;
    const abs = join(gitRoot, line);
    const existing = map.get(abs);
    if (existing) {
      // Walking newest→oldest: keep the newest as last_ct (set on first
      // sighting), keep overwriting first_ct so it ends as the oldest.
      existing.first_ct = currentCt;
    } else {
      map.set(abs, { last_ct: currentCt, first_ct: currentCt });
    }
  }
  return map;
}

async function statDates(absPath, now) {
  try {
    const s = await stat(absPath);
    return {
      mtime: s.mtime,
      created_at: s.birthtime && s.birthtime.getTime() > 0 ? s.birthtime : s.mtime,
    };
  } catch {
    return { mtime: now, created_at: now };
  }
}
