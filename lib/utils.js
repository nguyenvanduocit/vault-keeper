/**
 * utils.js — Shared utilities for the vault tooling lib/server/cli layers.
 *
 * Keep this module dependency-free. Anything that needs filesystem, YAML,
 * markdown, or vocab access lives in a more specific module.
 */

/**
 * Recursively freeze an object tree so consumers cannot mutate cached config
 * objects (vocab, template rules, enforcement schedule). Idempotent — safe to
 * call on already-frozen subtrees.
 */
export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
