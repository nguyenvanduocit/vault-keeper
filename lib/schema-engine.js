/**
 * Composable schema validation engine.
 *
 * A closed registry of rule primitives. Each primitive is a pure function
 * `(value, param, ctx) => Issue[]`. The engine is 100% generic — zero
 * domain knowledge (no field names, status values, section types, etc.).
 *
 * Spec references: §4 (primitives), §5 (frontmatter), §7 (engine), §8 (meta).
 */

import { evaluate as conditionalEvaluate, getField } from "./conditional-eval.js";

// ────────────────────────────────────────────────────────────────────────────
// Issue helpers
// ────────────────────────────────────────────────────────────────────────────

function issue(level, field, message, errorType, fix) {
  const i = { level, field, message, error_type: errorType };
  if (fix) i.fix = fix;
  return i;
}

// ────────────────────────────────────────────────────────────────────────────
// Scalar primitives registry (spec §4.1)
// ────────────────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set(["string", "integer", "number", "boolean", "date", "array"]);

/**
 * PRIMITIVES — registry: primitive name → pure function (value, param, ctx) => Issue[]
 *
 * `ctx` carries: { field, type, severity, message, fileExists }
 * `severity` and `message` may override defaults from expanded-form modifiers.
 */
export const PRIMITIVES = {
  type(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;

    switch (param) {
      case "string":
        if (typeof value !== "string") {
          return [issue(level, field, ctx.message || `Expected type 'string', got '${typeof value}'`, "type-mismatch")];
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          return [issue(level, field, ctx.message || `Expected type 'integer', got '${typeof value === "number" ? "non-integer number" : typeof value}'`, "type-mismatch")];
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          return [issue(level, field, ctx.message || `Expected type 'number', got '${typeof value}'`, "type-mismatch")];
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          return [issue(level, field, ctx.message || `Expected type 'boolean', got '${typeof value}'`, "type-mismatch")];
        }
        break;
      case "date":
        if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
          return [issue(level, field, ctx.message || `Expected type 'date', got '${typeof value}'`, "type-mismatch")];
        }
        break;
      case "array":
        if (!Array.isArray(value)) {
          return [issue(level, field, ctx.message || `Expected type 'array', got '${typeof value}'`, "type-mismatch")];
        }
        break;
    }
    return [];
  },

  required(_value, _param, _ctx) {
    // Handled specially in applyFieldSchema — never called as a normal primitive.
    // Included in the registry so meta-validation recognizes it.
    return [];
  },

  enum(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    if (!param.includes(value)) {
      return [issue(level, field, ctx.message || `Value '${value}' is not in allowed values: [${param.join(", ")}]`, "enum-violation", `Use one of: ${param.join(", ")}`)];
    }
    return [];
  },

  pattern(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    const str = String(value);
    const re = new RegExp(param);
    if (!re.test(str)) {
      return [issue(level, field, ctx.message || `Value '${str}' does not match pattern '${param}'`, "pattern-mismatch", `Must match: ${param}`)];
    }
    return [];
  },

  min(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    const actual = resolveMinMaxTarget(value, ctx.type);
    if (actual === undefined) return [];
    if (actual < param) {
      const label = minMaxLabel(ctx.type);
      return [issue(level, field, ctx.message || `${label} ${actual} is less than minimum ${param}`, "min-violation")];
    }
    return [];
  },

  max(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    const actual = resolveMinMaxTarget(value, ctx.type);
    if (actual === undefined) return [];
    if (actual > param) {
      const label = minMaxLabel(ctx.type);
      return [issue(level, field, ctx.message || `${label} ${actual} exceeds maximum ${param}`, "max-violation")];
    }
    return [];
  },

  uniqueItems(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    if (!param || !Array.isArray(value)) return [];
    const seen = new Set();
    const dupes = [];
    for (const item of value) {
      const key = typeof item === "object" ? JSON.stringify(item) : String(item);
      if (seen.has(key)) dupes.push(item);
      seen.add(key);
    }
    if (dupes.length > 0) {
      return [issue(level, field, ctx.message || `Array contains duplicate items: ${dupes.join(", ")}`, "unique-violation")];
    }
    return [];
  },

  exists(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    if (!param || typeof value !== "string") return [];
    const resolver = ctx.fileExists || (() => true);
    if (!resolver(value)) {
      return [issue(level, field, ctx.message || `Referenced file '${value}' does not exist`, "exists-missing", `Create or fix the path: ${value}`)];
    }
    return [];
  },

  description(_value, _param, _ctx) {
    // Metadata only — emits nothing.
    return [];
  },
};

/**
 * Resolve the comparable target for min/max based on the field's declared type.
 * string → length, number/integer → value, array → element count.
 */
function resolveMinMaxTarget(value, type) {
  if (type === "string" && typeof value === "string") return value.length;
  if ((type === "number" || type === "integer") && typeof value === "number") return value;
  if (type === "array" && Array.isArray(value)) return value.length;
  // Fallback: if type is not declared but value is a number, use it as-is.
  if (type === undefined && typeof value === "number") return value;
  return undefined;
}

function minMaxLabel(type) {
  if (type === "string") return "Length";
  if (type === "array") return "Count";
  return "Value";
}

// ────────────────────────────────────────────────────────────────────────────
// Synthetic field resolvers (spec §5.2)
// ────────────────────────────────────────────────────────────────────────────

export const SYNTHETIC_RESOLVERS = {
  $path: (docMeta) => docMeta.repoRelativePath,
};

// ────────────────────────────────────────────────────────────────────────────
// Constraint normalization — shorthand vs expanded (spec §4.4)
// ────────────────────────────────────────────────────────────────────────────

const MODIFIER_KEYS = new Set(["value", "when", "severity", "message"]);

/**
 * Normalize a constraint to expanded form: { value, when?, severity?, message? }
 * @param {string} primitiveName - the primitive key (e.g. "enum", "min")
 * @param {*} raw - the raw value from the template field entry
 * @returns {{ value: *, when?: string, severity?: string, message?: string }}
 */
function normalizeConstraint(primitiveName, raw) {
  // Expanded form: a plain object with a `value` key, OR for `required` any
  // plain object (defaults value to true).
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    if ("value" in raw) {
      return raw;
    }
    // `required: { when: "..." }` — value defaults to true
    if (primitiveName === "required") {
      return { value: true, ...raw };
    }
  }
  // Shorthand: raw IS the value
  return { value: raw };
}

// ────────────────────────────────────────────────────────────────────────────
// applyFieldSchema — frontmatter validation (spec §5)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate frontmatter against a fields schema.
 *
 * @param {{ fields: Record<string, object>, strict?: boolean }} schema
 * @param {object} frontmatter - parsed frontmatter data
 * @param {object} docMeta - { repoRelativePath, fileExists? }
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
      // Skip `required` (already handled above) and non-primitive keys
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
          `Undeclared field '${key}' is not in the schema`,
          "undeclared-field",
          `Remove '${key}' or declare it in the template fields`,
        ));
      }
    }
  }

  return issues;
}

/**
 * Extract the primitive value from a field spec entry, handling both
 * shorthand and expanded forms.
 */
function extractPrimitiveValue(fieldSpec, primitiveName) {
  const raw = fieldSpec[primitiveName];
  if (raw === undefined) return undefined;
  const norm = normalizeConstraint(primitiveName, raw);
  return norm.value;
}

// ────────────────────────────────────────────────────────────────────────────
// validateTemplateSchema — meta-validation (spec §8)
// ────────────────────────────────────────────────────────────────────────────

const KNOWN_FIELD_KEYS = new Set([
  ...Object.keys(PRIMITIVES),
  // Modifiers that can appear at the field level when using expanded form
  // are inside the constraint object, not at the field level — but
  // `description` is a recognized primitive (metadata-only).
]);

// Primitives allowed on synthetic ($-prefixed) fields
const SYNTHETIC_ALLOWED_PRIMITIVES = new Set(["pattern", "enum"]);

/**
 * Meta-validate a `fields:` schema — checks the template itself.
 * Returns Issue[] describing problems in the template (never throws).
 *
 * @param {Record<string, object>} fieldsSchema - the `fields:` block from a template
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
          `Unknown primitive '${key}' on field '${fieldName}'`,
          "template-schema-invalid",
          `Known primitives: ${Object.keys(PRIMITIVES).join(", ")}`,
        ));
        continue;
      }

      // Synthetic fields may only use pattern/enum
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
            // Allow the constraint value to appear at the same level for primitives
            // but flag unknown modifier keys
            if (!(modKey in PRIMITIVES)) {
              issues.push(issue(
                "error",
                fieldName,
                `Unknown modifier '${modKey}' in expanded constraint '${key}' on field '${fieldName}'`,
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
              `Invalid type '${norm.value}' on field '${fieldName}'. Allowed: ${[...VALID_TYPES].join(", ")}`,
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
        case "required": {
          // Validate the `when` string if present
          if (norm.when) {
            try {
              conditionalEvaluate(norm.when, {});
            } catch (e) {
              // Distinguish syntax error from runtime missing-field (which is OK)
              // conditionalEvaluate throws on syntax errors; missing fields return false
              // Re-parse to check: a syntax-level error message indicates a malformed expression
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

/**
 * Determine if an error from conditionalEvaluate is a syntax error
 * vs a runtime "field not found" error (which is expected during meta-validation
 * since we pass an empty context).
 *
 * Syntax errors mention tokens, characters, unexpected things.
 * Runtime field-not-found: conditionalEvaluate returns false for missing fields,
 * but it does throw for structural issues like "Expected token 'in'".
 */
function isSyntaxError(e) {
  const msg = e.message || "";
  return (
    msg.includes("Unexpected") ||
    msg.includes("Expected") ||
    msg.includes("Unterminated") ||
    msg.includes("Unknown") ||
    msg.includes("at index")
  );
}
