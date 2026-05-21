/**
 * Frontmatter validation orchestrator (spec §5).
 *
 * Walks a template's `fields:` schema and applies every declared
 * constraint to the parsed frontmatter. Synthetic `$`-prefixed fields
 * resolve via `SYNTHETIC_RESOLVERS`; non-synthetic fields look up
 * `frontmatter[name]` via `getField` (supports dotted nested keys).
 *
 * The orchestrator handles `required` (with conditional `when` gating)
 * before any other primitive — a missing required value short-circuits
 * the remaining constraints for that field. Strict mode produces an
 * `undeclared-field` diagnostic for every frontmatter key not declared
 * in the schema.
 */

import { issue } from "../helpers/issue.js";
import { didYouMean } from "../fuzzy-suggest.js";
import { normalizeConstraint } from "../helpers/constraint.js";
import { PRIMITIVES } from "../primitives/index.js";
import { evaluate as conditionalEvaluate, getField } from "../conditional-eval.js";
import { SYNTHETIC_RESOLVERS } from "./synthetic.js";

/**
 * Private — resolve a constraint to its underlying value regardless of
 * shorthand vs expanded form. Mirrors the meta-side helper.
 */
function extractPrimitiveValue(fieldSpec, primitiveName) {
  const raw = fieldSpec[primitiveName];
  if (raw === undefined) return undefined;
  const norm = normalizeConstraint(primitiveName, raw);
  return norm.value;
}

/**
 * Validate frontmatter against a `fields:` schema.
 *
 * @param {{ fields: Record<string, object>, strict?: boolean }} schema
 * @param {object} frontmatter - parsed frontmatter data
 * @param {object} [docMeta] - `{ repoRelativePath, fileExists? }`
 * @returns {Array<{ level, field, message, fix?, error_type }>}
 */
export function applyFieldSchema({ fields, strict }, frontmatter, docMeta) {
  const issues = [];
  if (!fields || typeof fields !== "object") return issues;

  const declaredFields = new Set(Object.keys(fields));

  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    if (!fieldSpec || typeof fieldSpec !== "object") continue;

    // 1. Resolve value
    const value = fieldName.startsWith("$")
      ? SYNTHETIC_RESOLVERS[fieldName]?.(docMeta)
      : getField(frontmatter, fieldName);

    // Determine the field's declared type (needed by min/max)
    const declaredType = extractPrimitiveValue(fieldSpec, "type");

    // 2. Handle `required`
    if ("required" in fieldSpec) {
      const norm = normalizeConstraint("required", fieldSpec.required);
      const isRequired = norm.value === true || norm.value === undefined;

      if (isRequired) {
        // Evaluate `when` gate
        let gatePass = true;
        if (norm.when) {
          try {
            gatePass = conditionalEvaluate(norm.when, frontmatter);
          } catch {
            gatePass = false;
          }
        }

        if (gatePass && (value === undefined || value === null || value === "")) {
          const level = norm.severity || "error";
          issues.push(issue(
            level,
            fieldName,
            norm.message || `Required field '${fieldName}' is missing`,
            "required-missing",
            `Add '${fieldName}' to frontmatter`,
          ));
          // Skip remaining constraints — value is missing
          continue;
        }
      }
    }

    // If value is missing (and not required, or required gate didn't fire), skip constraints
    if (value === undefined || value === null) continue;

    // 3. Run each constraint primitive
    for (const [key, rawConstraint] of Object.entries(fieldSpec)) {
      if (key === "required") continue;
      if (!(key in PRIMITIVES)) continue;

      const norm = normalizeConstraint(key, rawConstraint);

      // Evaluate `when` gate
      if (norm.when) {
        try {
          if (!conditionalEvaluate(norm.when, frontmatter)) continue;
        } catch {
          continue;
        }
      }

      const ctx = {
        field: fieldName,
        type: declaredType,
        severity: norm.severity,
        message: norm.message,
        fileExists: docMeta?.fileExists,
      };

      const primitiveIssues = PRIMITIVES[key](value, norm.value, ctx);
      issues.push(...primitiveIssues);
    }
  }

  // 4. Strict mode — undeclared frontmatter keys
  if (strict && frontmatter && typeof frontmatter === "object") {
    for (const key of Object.keys(frontmatter)) {
      if (!declaredFields.has(key)) {
        issues.push(issue(
          "error",
          key,
          `Undeclared field '${key}' is not in the schema.${didYouMean(key, declaredFields)}`,
          "undeclared-field",
          `Remove '${key}' or declare it in the template fields`,
        ));
      }
    }
  }

  return issues;
}
