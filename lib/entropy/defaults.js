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
    // minimatch glob patterns matched against raw tag values AND wiki-link
    // targets; any match is excluded from ALL vocab analysis (clusters,
    // fuzzy_suggestions, drift_score). Default empty = no assumptions.
    ignore: Object.freeze([]),
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

/**
 * Deep freeze an object and all nested objects recursively.
 * Leaves primitives and non-objects untouched.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}
