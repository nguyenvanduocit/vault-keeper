/**
 * Meta-validation for a template's `fields:` schema.
 *
 * Runs once at template-load time and surfaces `template-schema-invalid`
 * issues for malformed declarations BEFORE any document hits them —
 * uncompilable regex, non-array enum, unknown primitive, unknown
 * modifier, `min`/`max` without a declared type, `before`/`after`
 * applied to a non-chronological type, …
 *
 * The walker queries the primitive registry for known primitives, the
 * fuzzy helper for "did you mean?" suggestions, and the chronological
 * primitive specs for per-key meta-validation. Inner-key allow-lists
 * inside compound primitives are owned by the primitive modules — not
 * duplicated here.
 */

import { issue } from "../helpers/issue.js";
import { didYouMean } from "../fuzzy-suggest.js";
import {
  MODIFIER_KEYS,
  normalizeConstraint,
  isSyntaxError,
} from "../helpers/constraint.js";
import {
  PRIMITIVES,
  VALID_TYPES,
  beforePrimitive,
  afterPrimitive,
} from "../primitives/index.js";
import { evaluate as conditionalEvaluate } from "../conditional-eval.js";

/** Keys we recognise on a field entry. Derived from PRIMITIVES insertion order. */
const KNOWN_FIELD_KEYS = new Set([
  ...Object.keys(PRIMITIVES),
  // Modifiers that can appear at the field level when using expanded form
  // are inside the constraint object, not at the field level — but
  // `description` is a recognized primitive (metadata-only).
]);

/** Primitives allowed on synthetic ($-prefixed) fields. */
const SYNTHETIC_ALLOWED_PRIMITIVES = new Set(["pattern", "enum"]);

/**
 * Extract the primitive value from a field spec entry, handling both
 * shorthand and expanded forms. Private — used by the meta-validator
 * to resolve `type:` (needed before any other per-primitive check).
 */
function extractPrimitiveValue(fieldSpec, primitiveName) {
  const raw = fieldSpec[primitiveName];
  if (raw === undefined) return undefined;
  const norm = normalizeConstraint(primitiveName, raw);
  return norm.value;
}

/**
 * Meta-validate a `fields:` schema. Returns Issue[] describing template
 * problems (never throws).
 *
 * @param {Record<string, object>} fieldsSchema - the `fields:` block
 * @returns {Array<{ level, field, message, fix?, error_type }>}
 */
export function validateTemplateSchema(fieldsSchema) {
  const issues = [];
  if (!fieldsSchema || typeof fieldsSchema !== "object") return issues;

  for (const [fieldName, fieldSpec] of Object.entries(fieldsSchema)) {
    if (!fieldSpec || typeof fieldSpec !== "object") {
      issues.push(issue(
        "error",
        fieldName,
        `Field '${fieldName}' must be an object with constraint declarations`,
        "template-schema-invalid",
      ));
      continue;
    }

    const isSynthetic = fieldName.startsWith("$");
    const declaredType = extractPrimitiveValue(fieldSpec, "type");

    for (const [key, rawConstraint] of Object.entries(fieldSpec)) {
      // Check for unknown primitive keys
      if (!(key in PRIMITIVES)) {
        issues.push(issue(
          "error",
          fieldName,
          `Unknown primitive '${key}' on field '${fieldName}'.${didYouMean(key, Object.keys(PRIMITIVES))}`,
          "template-schema-invalid",
          `Known primitives: ${Object.keys(PRIMITIVES).join(", ")}`,
        ));
        continue;
      }

      // Synthetic fields may only use pattern/enum (plus description metadata)
      if (isSynthetic && !SYNTHETIC_ALLOWED_PRIMITIVES.has(key) && key !== "description") {
        issues.push(issue(
          "error",
          fieldName,
          `Synthetic field '${fieldName}' may only use 'pattern' or 'enum', not '${key}'`,
          "template-schema-invalid",
        ));
        continue;
      }

      const norm = normalizeConstraint(key, rawConstraint);

      // Validate expanded-form modifier keys
      if (rawConstraint !== null && typeof rawConstraint === "object" && !Array.isArray(rawConstraint)) {
        for (const modKey of Object.keys(rawConstraint)) {
          if (!MODIFIER_KEYS.has(modKey) && modKey !== key) {
            // Allow the constraint value to appear at the same level for
            // primitives but flag unknown modifier keys.
            if (!(modKey in PRIMITIVES)) {
              issues.push(issue(
                "error",
                fieldName,
                `Unknown modifier '${modKey}' in expanded constraint '${key}' on field '${fieldName}'.${didYouMean(modKey, MODIFIER_KEYS)}`,
                "template-schema-invalid",
                `Allowed modifiers: value, when, severity, message`,
              ));
            }
          }
        }
      }

      // Per-primitive validation
      switch (key) {
        case "type": {
          if (!VALID_TYPES.has(norm.value)) {
            issues.push(issue(
              "error",
              fieldName,
              `Invalid type '${norm.value}' on field '${fieldName}'. Allowed: ${[...VALID_TYPES].join(", ")}.${didYouMean(String(norm.value), VALID_TYPES)}`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "pattern": {
          try {
            new RegExp(norm.value);
          } catch {
            issues.push(issue(
              "error",
              fieldName,
              `Invalid regex pattern on field '${fieldName}': ${norm.value}`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "enum": {
          if (!Array.isArray(norm.value) || norm.value.length === 0) {
            issues.push(issue(
              "error",
              fieldName,
              `'enum' on field '${fieldName}' must be a non-empty array`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "min":
        case "max": {
          if (typeof norm.value !== "number" || Number.isNaN(norm.value)) {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' on field '${fieldName}' must be a number`,
              "template-schema-invalid",
            ));
          }
          if (!declaredType) {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' on field '${fieldName}' requires a declared 'type'`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "before":
        case "after": {
          // Delegate template-time validation to the primitive spec —
          // the meta logic (chronological-type required, bound must
          // parse) lives next to the runtime in
          // lib/primitives/chronological.js.
          const spec = key === "before" ? beforePrimitive : afterPrimitive;
          issues.push(...spec.validateConfig(norm.value, declaredType, fieldName));
          break;
        }
        case "required": {
          // Validate the `when` string if present.
          if (norm.when) {
            try {
              conditionalEvaluate(norm.when, {});
            } catch (e) {
              if (isSyntaxError(e)) {
                issues.push(issue(
                  "error",
                  fieldName,
                  `Invalid 'when' condition on field '${fieldName}': ${e.message}`,
                  "template-schema-invalid",
                ));
              }
            }
          }
          break;
        }
        // description, exists, uniqueItems — no template-level validation needed
        default:
          break;
      }

      // Validate `when` on any constraint (not just required)
      if (key !== "required" && norm.when) {
        try {
          conditionalEvaluate(norm.when, {});
        } catch (e) {
          if (isSyntaxError(e)) {
            issues.push(issue(
              "error",
              fieldName,
              `Invalid 'when' condition on '${key}' constraint of field '${fieldName}': ${e.message}`,
              "template-schema-invalid",
            ));
          }
        }
      }
    }
  }

  return issues;
}

export { KNOWN_FIELD_KEYS };
