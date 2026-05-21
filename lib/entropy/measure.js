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
