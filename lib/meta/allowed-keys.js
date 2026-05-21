/**
 * Top-level section-rules key contract.
 *
 * Per codex's review, this file holds ONLY the global keys that aren't
 * owned by any single primitive (the "envelope" of a section-rules
 * block). Each compound primitive (`table`, `list`, `code`, `heading`)
 * declares its own inner-key allow-list next to its runtime in
 * `lib/primitives/<name>.js` — that way adding a new nested key
 * touches one file, not three.
 */

/** Keys allowed at the top of a section-rules block. */
export const SECTION_RULES_KEYS = new Set([
  "required", "repeatable", "heading", "table", "list", "code", "formula",
  "min", "max", "severity", "message",
]);
