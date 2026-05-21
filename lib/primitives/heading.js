/**
 * `heading` primitive — validates a heading's text against a
 * `{ pattern?, enum? }` constraint. Used by repeatable section schemas
 * to enforce a naming convention on each claimed heading.
 *
 * Inner-key allow-list lives next to the runtime so meta-validation
 * can ask the spec what's legal without duplicating constants.
 */

import { issue } from "../helpers/issue.js";

/** Keys allowed inside the `heading:` block. */
export const HEADING_INNER_KEYS = new Set(["pattern", "enum"]);

function validate(_value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const text = String(_value);

  if (param.pattern) {
    let re;
    try {
      re = new RegExp(param.pattern);
    } catch {
      return [];
    }
    if (!re.test(text)) {
      return [issue(level, field, ctx.message || `Heading '${text}' does not match pattern '${param.pattern}'`, "heading-mismatch")];
    }
  }
  if (param.enum) {
    const normalized = text.toLowerCase().trim();
    const allowed = param.enum.map((v) => String(v).toLowerCase().trim());
    if (!allowed.includes(normalized)) {
      return [issue(level, field, ctx.message || `Heading '${text}' is not in allowed values: [${param.enum.join(", ")}]`, "heading-mismatch")];
    }
  }
  return [];
}

export const headingPrimitive = {
  name: "heading",
  innerKeys: HEADING_INNER_KEYS,
  validate,
};
