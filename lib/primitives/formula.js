/**
 * `formula` primitive — evaluates an arithmetic / comparison
 * expression. The caller decides which value map to feed it; for body
 * section-rules the orchestrator passes `frontmatter`, so references
 * inside the expression map directly to frontmatter field names.
 *
 * Imported `formulaEvaluate` is the pure expression interpreter from
 * `lib/expression-eval.js`.
 */

import { issue } from "../helpers/issue.js";
import { evaluate as formulaEvaluate } from "../expression-eval.js";

function validate(_value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const values = _value && typeof _value === "object" ? _value : {};

  try {
    const result = formulaEvaluate(param, values);
    if (result === false) {
      return [issue(level, field, ctx.message || `Formula '${param}' evaluated to false`, "formula-violation")];
    }
    return [];
  } catch (e) {
    return [issue(level, field, ctx.message || `Formula '${param}' failed: ${e.message}`, "formula-violation")];
  }
}

export const formulaPrimitive = {
  name: "formula",
  validate,
};
