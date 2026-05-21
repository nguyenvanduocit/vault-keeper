/**
 * Issue construction helper — the canonical shape every primitive
 * emits. Pure: no imports, no side effects.
 *
 * @typedef {object} Issue
 * @property {"error"|"warning"} level
 * @property {string} field            - field name, section path, or `body`
 * @property {string} message          - human-readable diagnostic
 * @property {string} error_type       - stable machine-readable kind
 * @property {string} [fix]            - optional one-line remediation hint
 * @property {number} [bodyLine]       - 1-indexed body-relative line; the LSP
 *                                       wrapper translates to a document line
 */

/**
 * Build an Issue object. The `fix` field is omitted when not provided so
 * downstream consumers can use `if (issue.fix)` without an explicit
 * undefined check.
 *
 * @param {"error"|"warning"} level
 * @param {string} field
 * @param {string} message
 * @param {string} errorType
 * @param {string} [fix]
 * @returns {Issue}
 */
export function issue(level, field, message, errorType, fix) {
  const i = { level, field, message, error_type: errorType };
  if (fix) i.fix = fix;
  return i;
}
