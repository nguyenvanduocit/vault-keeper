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

  const fCounts = new Map();
  for (const d of docs) {
    const f = d.folder ?? '';
    fCounts.set(f, (fCounts.get(f) ?? 0) + 1);
  }
  const fValues = [...fCounts.values()];
  const fGini = fValues.length > 1 ? gini(fValues) : null;

  const corpus = docs
    .map((d) => JSON.stringify(d.frontmatter ?? {}))
    .join('\n');
  let compression = { raw_bytes: 0, gzip_bytes: 0, global_ratio: null };
  if (corpus.length >= 100) {
    const raw = Buffer.byteLength(corpus, 'utf-8');
    const z = gzipSync(corpus).length;
    compression = { raw_bytes: raw, gzip_bytes: z, global_ratio: z / raw };
  }

  const giniPenalty = tGini === null ? 0 : Math.max(0, 0.3 - tGini) + Math.max(0, tGini - 0.7);
  const untemplatedRatio = docs.length === 0 ? 0 : untemplated / docs.length;
  const compressionPenalty =
    compression.global_ratio === null
      ? 0
      : Math.max(0, compression.global_ratio - 0.4);
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
  if (gini < 0.3) return 'flat';
  if (gini > 0.7) return 'monoculture';
  return 'healthy_pareto';
}

function clamp01(x) {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
