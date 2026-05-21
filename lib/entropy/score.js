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
