/**
 * Heading-path helpers used by the body-schema engine to build the
 * `field` string on each issue (e.g. `## Section › ### Sub`).
 *
 * Kept tiny and dependency-free so anything that needs to construct or
 * inspect heading paths — orchestrator, meta-validator, primitive
 * spec — can reach for these without dragging in the full engine.
 */

/**
 * Build a heading path string for issue `field`.
 * Joins ancestor heading labels with the standard separator.
 *
 * @param {string[]} ancestors - ancestor heading texts (with `##` prefix)
 * @param {string} current - current heading text (with `##` prefix)
 * @returns {string}
 */
export function headingPath(ancestors, current) {
  return [...ancestors, current].join(" › ");
}

/**
 * Build a heading label with a `#`-prefix at the requested depth.
 *
 * @param {number} depth
 * @param {string} text
 * @returns {string}
 */
export function headingLabel(depth, text) {
  return `${"#".repeat(depth)} ${text}`;
}
