/**
 * Constraint shorthand / expanded-form normalization (spec §4.4) plus
 * the modifier-key set shared by every primitive that accepts an
 * expanded constraint.
 *
 * "Shorthand" = the raw value sits directly on the constraint key
 * (`pattern: "^x"`, `enum: [a, b]`).
 * "Expanded"  = the constraint key holds an object with `value` and
 * optional `when` / `severity` / `message` modifiers.
 *
 * `normalizeConstraint` collapses the two forms to a single expanded
 * shape so every primitive can read `.value`, `.when`, `.severity`,
 * `.message` uniformly.
 */

/** Reserved modifier keys allowed inside an expanded-form constraint. */
export const MODIFIER_KEYS = new Set(["value", "when", "severity", "message"]);

/**
 * Collapse a constraint to the expanded shape
 * `{ value, when?, severity?, message? }`.
 *
 * Special case: `required: { when: "..." }` defaults `value` to `true`
 * so authors don't have to write `required: { value: true, when: "..." }`.
 *
 * @param {string} primitiveName - constraint key (e.g. "enum", "min")
 * @param {*} raw - raw value from the template field entry
 * @returns {{ value: *, when?: string, severity?: string, message?: string }}
 */
export function normalizeConstraint(primitiveName, raw) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    if ("value" in raw) return raw;
    if (primitiveName === "required") {
      return { value: true, ...raw };
    }
  }
  return { value: raw };
}

/**
 * Classify a thrown error from `conditionalEvaluate` as a syntax-level
 * problem (template author error) vs a runtime missing-field
 * (which is OK during meta-validation against an empty frontmatter).
 *
 * Used by `validateTemplateSchema` to decide whether to surface a
 * `template-schema-invalid` for a malformed `when` expression without
 * false-positiving on the empty-context probe.
 *
 * @param {Error} e
 * @returns {boolean}
 */
export function isSyntaxError(e) {
  const msg = e.message || "";
  return (
    msg.includes("Unexpected") ||
    msg.includes("Expected") ||
    msg.includes("Unterminated") ||
    msg.includes("Unknown") ||
    msg.includes("at index")
  );
}
