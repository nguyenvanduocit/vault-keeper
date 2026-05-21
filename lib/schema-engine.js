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
import { evaluate as formulaEvaluate, parse as formulaParse } from "./expression-eval.js";
import { parseHeadingTree, parseTable, parseList, findCodeFences } from "./body-shapes.js";
import { didYouMean } from "./fuzzy-suggest.js";

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

const VALID_TYPES = new Set([
  "string", "integer", "number", "boolean",
  "date", "datetime", "time",
  "array",
]);

/**
 * `time` regex — 24-hour HH:MM or HH:MM:SS, no timezone.
 * `datetime` regex — ISO 8601 / RFC 3339 with a `T` separator, optional
 * sub-second precision, optional `Z` or `±HH:MM` offset.
 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse a date/datetime/time value into a comparable numeric value.
 * Returns null when the value cannot be parsed under the requested type.
 *
 * - `time`        → seconds since 00:00:00
 * - everything    → milliseconds since epoch (via Date.parse)
 *
 * Pure helper used by `before` / `after` primitives — no side effects.
 *
 * @param {unknown} value
 * @param {string} [type]
 * @returns {number|null}
 */
function toComparableTime(value, type) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== "string") return null;
  if (type === "time") {
    const m = value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
    if (!m) return null;
    const [, h, mi, s] = m;
    return Number(h) * 3600 + Number(mi) * 60 + Number(s || 0);
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Render a date-like value for an error message.
 * Date instances → ISO string; everything else → String(value).
 */
function formatDateLike(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return String(value);
}

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
        // Date instances are accepted: gray-matter coerces unquoted YAML
        // date literals (e.g. `created: 2026-04-01`) into JS Date objects.
        // The original value was a string in the YAML source, so rejecting
        // it here would be a false positive.  Downstream primitives (e.g.
        // `pattern`) already normalise Date → ISO string for matching.
        if (typeof value !== "string" && !(value instanceof Date)) {
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
      case "datetime":
        // gray-matter coerces ISO datetime literals into Date instances.
        // ISO 8601 strings (timestamp + 'T' separator) are accepted too;
        // bare YYYY-MM-DD (no time) is NOT a datetime — use `type: date`.
        if (value instanceof Date) {
          if (Number.isNaN(value.getTime())) {
            return [issue(level, field, ctx.message || `Expected type 'datetime', got Invalid Date`, "type-mismatch")];
          }
        } else if (typeof value !== "string"
                   || !DATETIME_RE.test(value)
                   || Number.isNaN(Date.parse(value))) {
          return [issue(level, field, ctx.message || `Expected type 'datetime' (ISO 8601), got '${formatDateLike(value)}'`, "type-mismatch")];
        }
        break;
      case "time":
        // YAML does not auto-coerce HH:MM(:SS) to a Date — it stays a
        // string. We validate 24-hour syntax only; no timezone.
        if (typeof value !== "string" || !TIME_RE.test(value)) {
          return [issue(level, field, ctx.message || `Expected type 'time' (HH:MM or HH:MM:SS), got '${formatDateLike(value)}'`, "type-mismatch")];
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
    if (!Array.isArray(param)) return [];
    if (!param.includes(value)) {
      return [issue(level, field, ctx.message || `Value '${value}' is not in allowed values: [${param.join(", ")}]`, "enum-violation", `Use one of: ${param.join(", ")}`)];
    }
    return [];
  },

  pattern(value, param, ctx) {
    const level = ctx.severity || "error";
    const field = ctx.field;
    // Date instances (from gray-matter parsing unquoted YAML dates) produce
    // locale-dependent strings via String(). Convert to ISO date form so
    // YYYY-MM-DD patterns match reliably. Generic — no domain knowledge.
    const str = value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString().slice(0, 10)
      : String(value);
    let re;
    try {
      re = new RegExp(param);
    } catch {
      return [];
    }
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

  before(value, param, ctx) {
    // Date/datetime/time chronological upper bound (exclusive).
    // `value` and `param` are both parsed via toComparableTime under the
    // resolved `ctx.type`. Unparseable inputs are skipped — `type:` is the
    // primitive responsible for surfacing those.
    const level = ctx.severity || "error";
    const field = ctx.field;
    const lv = toComparableTime(value, ctx.type);
    const rv = toComparableTime(param, ctx.type);
    if (lv === null || rv === null) return [];
    if (!(lv < rv)) {
      return [issue(level, field, ctx.message || `Value '${formatDateLike(value)}' is not before '${param}'`, "before-violation")];
    }
    return [];
  },

  after(value, param, ctx) {
    // Chronological lower bound (exclusive). Mirror of `before`.
    const level = ctx.severity || "error";
    const field = ctx.field;
    const lv = toComparableTime(value, ctx.type);
    const rv = toComparableTime(param, ctx.type);
    if (lv === null || rv === null) return [];
    if (!(lv > rv)) {
      return [issue(level, field, ctx.message || `Value '${formatDateLike(value)}' is not after '${param}'`, "after-violation")];
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

  // ── Structural primitives (body only, spec §4.2) ──────────────────────

  heading(_value, param, ctx) {
    // `param` is { pattern?, enum? }. Validates a heading's text.
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
  },

  table(_value, param, ctx) {
    // `_value` is a ParsedTable | null. `param` is { columns?, key_column?, value_column? }.
    const level = ctx.severity || "error";
    const field = ctx.field;

    if (!_value) {
      return [issue(level, field, ctx.message || "Expected a table but none found", "table-shape")];
    }

    const issues = [];
    if (param.columns) {
      const expected = param.columns.map((c) => c.toLowerCase().trim());
      for (const col of expected) {
        if (!_value.headers.includes(col)) {
          issues.push(issue(level, field, ctx.message || `Table missing required column '${col}'`, "table-shape"));
        }
      }
    }
    return issues;
  },

  list(_value, param, ctx) {
    // `_value` is a ParsedList | null. `param` is { item?: { pattern? } }.
    const level = ctx.severity || "error";
    const field = ctx.field;

    if (!_value) {
      return [issue(level, field, ctx.message || "Expected a list but none found", "list-item")];
    }

    const issues = [];
    if (param.item && param.item.pattern) {
      let re;
      try {
        re = new RegExp(param.item.pattern);
      } catch {
        return [];
      }
      for (const item of _value.items) {
        if (!re.test(item.text)) {
          issues.push(issue(level, field, ctx.message || `List item '${item.text}' does not match pattern '${param.item.pattern}'`, "list-item"));
        }
      }
    }
    return issues;
  },

  code(_value, param, ctx) {
    // `_value` is CodeFence[] (from findCodeFences). `param` is { lang? }.
    const level = ctx.severity || "error";
    const field = ctx.field;
    const fences = Array.isArray(_value) ? _value : [];

    if (param.lang) {
      const target = param.lang.toLowerCase();
      const found = fences.some((f) => f.lang && f.lang.toLowerCase() === target);
      if (!found) {
        return [issue(level, field, ctx.message || `Expected a '${param.lang}' code fence but none found`, "code-missing")];
      }
    } else {
      // Just require at least one code fence
      if (fences.length === 0) {
        return [issue(level, field, ctx.message || "Expected a code fence but none found", "code-missing")];
      }
    }
    return [];
  },

  repeatable(_value, _param, _ctx) {
    // Marker primitive — cardinality logic handled by applyBodySchema.
    // Included in registry so meta-validation recognizes it.
    return [];
  },

  formula(_value, param, ctx) {
    // `_value` is a Record<string, number> (extracted from table key→value map).
    // `param` is the expression string.
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
          `Undeclared field '${key}' is not in the schema.${didYouMean(key, declaredFields)}`,
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
          `Unknown primitive '${key}' on field '${fieldName}'.${didYouMean(key, Object.keys(PRIMITIVES))}`,
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
          // Only meaningful on chronological types. Require a declared
          // `type:` and a value that parses under it (caught at template
          // time, before any document hits the constraint).
          if (!declaredType) {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' on field '${fieldName}' requires a declared 'type' of date, datetime, or time`,
              "template-schema-invalid",
            ));
          } else if (declaredType !== "date" && declaredType !== "datetime" && declaredType !== "time") {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' on field '${fieldName}' is only valid with type 'date', 'datetime', or 'time' — got '${declaredType}'`,
              "template-schema-invalid",
            ));
          } else if (toComparableTime(norm.value, declaredType) === null) {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' value '${norm.value}' on field '${fieldName}' is not a parseable ${declaredType}`,
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

// ────────────────────────────────────────────────────────────────────────────
// Body schema types and helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} SectionRules
 * @property {boolean}  [required]   - section must exist
 * @property {boolean}  [repeatable] - heading at this level is a pattern-placeholder
 * @property {object}   [heading]    - { pattern?, enum? } constraining heading text
 * @property {object}   [table]      - { columns?, key_column?, value_column? }
 * @property {object}   [list]       - { item?: { pattern? } }
 * @property {object}   [code]       - { lang? }
 * @property {string}   [formula]    - expression over extracted table values
 * @property {number}   [min]        - min cardinality (repeatable)
 * @property {number}   [max]        - max cardinality (repeatable)
 * @property {string}   [severity]   - override default severity
 * @property {string}   [message]    - override default message
 */

/**
 * @typedef {object} BodySchemaNode
 * @property {number} depth       - heading depth (1-6, or 0 for root)
 * @property {string} text        - heading text from template
 * @property {SectionRules|null} sectionRules - parsed section-rules, or null
 * @property {BodySchemaNode[]} children - nested deeper-depth schema nodes
 */

/**
 * @typedef {object} BodyIssue
 * @property {string} level      - "error" | "warning"
 * @property {string} field      - heading path (e.g. "## Section › ### Sub")
 * @property {string} message
 * @property {string} error_type
 * @property {string} [fix]
 * @property {number} [bodyLine] - 1-indexed body-relative line
 */

/**
 * Build a heading path string for issue `field`.
 * @param {string[]} ancestors - ancestor heading texts (with ## prefix)
 * @param {string} current - current heading text (with ## prefix)
 * @returns {string}
 */
function headingPath(ancestors, current) {
  return [...ancestors, current].join(" › ");
}

/**
 * Build a heading label with depth prefix.
 * @param {number} depth
 * @param {string} text
 * @returns {string}
 */
function headingLabel(depth, text) {
  return `${"#".repeat(depth)} ${text}`;
}

/**
 * Normalize a string for heading matching: lowercase, trimmed.
 * @param {string} s
 * @returns {string}
 */
function normalizeHeading(s) {
  return (s || "").toLowerCase().trim();
}

/**
 * Normalize a table key for formula identifier: lowercase, trimmed, spaces → underscores.
 * @param {string} s
 * @returns {string}
 */
function normalizeTableKey(s) {
  return (s || "").toLowerCase().trim().replace(/\s+/g, "_");
}

/**
 * Extract a key→value map from a parsed table using key_column and value_column.
 * Values are parsed as numbers; non-numeric values result in NaN.
 * @param {import('./body-shapes.js').ParsedTable} table
 * @param {string} keyCol - header name of the key column (lowercased)
 * @param {string} valCol - header name of the value column (lowercased)
 * @returns {{ map: Record<string, number>, nonNumeric: string[] }}
 */
function extractTableMap(table, keyCol, valCol) {
  const keyIdx = table.headers.indexOf(keyCol.toLowerCase().trim());
  const valIdx = table.headers.indexOf(valCol.toLowerCase().trim());
  const map = {};
  const nonNumeric = [];

  if (keyIdx === -1 || valIdx === -1) return { map, nonNumeric };

  for (const row of table.rows) {
    const rawKey = row[keyIdx] || "";
    const rawVal = row[valIdx] || "";
    const key = normalizeTableKey(rawKey);
    if (!key) continue;
    const num = Number(rawVal);
    if (Number.isNaN(num)) {
      nonNumeric.push(rawKey);
    }
    map[key] = num;
  }
  return { map, nonNumeric };
}

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — body validation (spec §6)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate a markdown document body against a body schema.
 *
 * The body schema is an array of BodySchemaNode (the template heading tree's
 * children, each optionally carrying `sectionRules`). The document body is
 * raw markdown (frontmatter stripped).
 *
 * @param {BodySchemaNode[]} templateBodySchema - template heading tree children
 * @param {string} docMarkdownBody - raw document body markdown
 * @param {object} [docMeta] - additional context (unused in Phase 2, reserved for Phase 3)
 * @param {object} [frontmatter={}] - parsed document frontmatter, passed to `when` evaluation
 * @returns {BodyIssue[]}
 */
export function applyBodySchema(templateBodySchema, docMarkdownBody, docMeta, frontmatter = {}) {
  if (!Array.isArray(templateBodySchema) || templateBodySchema.length === 0) {
    return [];
  }

  const docTree = parseHeadingTree(docMarkdownBody || "");
  const issues = [];

  // Templates typically have a single H1 title heading that wraps all H2
  // section definitions. Documents also have an H1 title (their own name).
  // The H1 text will never match (template title ≠ document title), so we
  // unwrap: use the H1's children as the effective schema and match them
  // against the document's H1 children.  This is purely structural — no
  // domain knowledge.
  let effectiveSchema = templateBodySchema;
  let effectiveDocNodes = docTree.children;
  let effectiveContentNodes = docTree.contentNodes;

  if (
    effectiveSchema.length === 1 &&
    effectiveSchema[0].depth === 1 &&
    effectiveDocNodes.length === 1 &&
    effectiveDocNodes[0].depth === 1
  ) {
    effectiveSchema = effectiveSchema[0].children || [];
    effectiveContentNodes = effectiveDocNodes[0].contentNodes || [];
    effectiveDocNodes = effectiveDocNodes[0].children || [];
  }

  validateChildren(effectiveSchema, effectiveDocNodes, effectiveContentNodes, [], issues, frontmatter);

  return issues;
}

/**
 * Recursively validate document heading children against template schema children.
 *
 * @param {BodySchemaNode[]} schemaNodes - template schema children at this level
 * @param {import('./body-shapes.js').HeadingNode[]} docNodes - document heading children at this level
 * @param {import('mdast').Content[]} parentContentNodes - content nodes of the parent (for root-level content)
 * @param {string[]} ancestorPath - ancestor heading labels for issue field
 * @param {BodyIssue[]} issues - mutable issues accumulator
 * @param {object} frontmatter - parsed document frontmatter for `when` evaluation
 */
function validateChildren(schemaNodes, docNodes, parentContentNodes, ancestorPath, issues, frontmatter) {
  // Separate repeatable vs non-repeatable schema nodes
  const repeatableSchemas = schemaNodes.filter((s) => s.sectionRules?.repeatable);
  const nonRepeatableSchemas = schemaNodes.filter((s) => !s.sectionRules?.repeatable);

  // Track which doc nodes are claimed by non-repeatable matches
  const claimedDocIndices = new Set();

  // 1. Process non-repeatable schema nodes
  for (const schema of nonRepeatableSchemas) {
    const normalizedSchemaText = normalizeHeading(schema.text);
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);

    // Find the matching doc heading
    const matchIdx = docNodes.findIndex(
      (d, idx) => !claimedDocIndices.has(idx) && d.depth === schema.depth && normalizeHeading(d.text) === normalizedSchemaText
    );

    if (matchIdx === -1) {
      // Missing section — evaluate `required` with optional `when` gate
      if (schema.sectionRules?.required != null) {
        const norm = normalizeConstraint("required", schema.sectionRules.required);
        const isRequired = norm.value === true || norm.value === undefined;

        if (isRequired) {
          let gatePass = true;
          if (norm.when) {
            try {
              gatePass = conditionalEvaluate(norm.when, frontmatter);
            } catch {
              gatePass = false;
            }
          }

          if (gatePass) {
            const severity = norm.severity || schema.sectionRules.severity || "error";
            issues.push({
              level: severity,
              field: path,
              message: norm.message || schema.sectionRules.message || `Required section '${label}' is missing`,
              error_type: "required-missing",
            });
          }
        }
      }
      continue;
    }

    claimedDocIndices.add(matchIdx);
    const docNode = docNodes[matchIdx];

    // Validate this section's content
    validateSection(schema, docNode, ancestorPath, issues, frontmatter);
  }

  // 2. Process repeatable schema nodes
  for (const schema of repeatableSchemas) {
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);
    const rules = schema.sectionRules || {};

    // A repeatable schema claims all unclaimed doc headings at the same depth
    const matchingDocNodes = [];
    for (let i = 0; i < docNodes.length; i++) {
      if (!claimedDocIndices.has(i) && docNodes[i].depth === schema.depth) {
        claimedDocIndices.add(i);
        matchingDocNodes.push(docNodes[i]);
      }
    }

    // Cardinality checks — evaluate `when` gate on `required` if present
    let requiredEffective = false;
    if (rules.required != null) {
      const norm = normalizeConstraint("required", rules.required);
      const isRequired = norm.value === true || norm.value === undefined;
      if (isRequired) {
        let gatePass = true;
        if (norm.when) {
          try {
            gatePass = conditionalEvaluate(norm.when, frontmatter);
          } catch {
            gatePass = false;
          }
        }
        requiredEffective = gatePass;
      }
    }
    const minCount = rules.min ?? (requiredEffective ? 1 : 0);
    const maxCount = rules.max ?? Infinity;
    const severity = rules.severity || "error";

    // Anchor cardinality issues at the first matched section when at least
    // one exists. When zero match (count < min and minCount > 0) there is no
    // body location to point at — bodyLine is omitted.
    const cardinalityAnchor = matchingDocNodes[0]?.line ?? undefined;
    if (matchingDocNodes.length < minCount) {
      issues.push({
        level: severity,
        field: path,
        message: rules.message || `Expected at least ${minCount} '${label}' section(s), found ${matchingDocNodes.length}`,
        error_type: "cardinality",
        bodyLine: cardinalityAnchor,
      });
    }
    if (matchingDocNodes.length > maxCount) {
      issues.push({
        level: severity,
        field: path,
        message: rules.message || `Expected at most ${maxCount} '${label}' section(s), found ${matchingDocNodes.length}`,
        error_type: "cardinality",
        bodyLine: cardinalityAnchor,
      });
    }

    // Validate each matching doc node against the repeatable schema's rules
    for (const docNode of matchingDocNodes) {
      const itemLabel = headingLabel(docNode.depth, docNode.text);
      const itemPath = headingPath(ancestorPath, itemLabel);

      // heading pattern/enum check
      if (rules.heading) {
        const ctx = { field: itemPath, severity: rules.severity, message: rules.message };
        const headingIssues = PRIMITIVES.heading(docNode.text, rules.heading, ctx);
        for (const hi of headingIssues) {
          hi.bodyLine = docNode.line;
          issues.push(hi);
        }
      }

      // Validate nested children recursively
      if (schema.children && schema.children.length > 0) {
        validateChildren(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, itemLabel], issues, frontmatter);
      }

      // Validate section content (table, list, code, formula)
      validateSectionContent(rules, docNode, itemPath, issues);
    }
  }
}

/**
 * Validate a non-repeatable matched section's content and children.
 */
function validateSection(schema, docNode, ancestorPath, issues, frontmatter) {
  const label = headingLabel(schema.depth, schema.text);
  const path = headingPath(ancestorPath, label);
  const rules = schema.sectionRules || {};

  // Validate section content (table, list, code, formula)
  validateSectionContent(rules, docNode, path, issues);

  // Recurse into children
  if (schema.children && schema.children.length > 0) {
    validateChildren(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, label], issues, frontmatter);
  }
}

/**
 * Validate section content against section-rules primitives (table, list, code, formula).
 */
function validateSectionContent(rules, docNode, path, issues) {
  const severity = rules.severity || "error";

  // table primitive
  if (rules.table) {
    const tableNode = docNode.contentNodes.find((n) => n.type === "table");
    const parsedTable = tableNode ? parseTable(tableNode) : null;
    const ctx = { field: path, severity, message: rules.message };
    const tableIssues = PRIMITIVES.table(parsedTable, rules.table, ctx);
    for (const ti of tableIssues) {
      if (tableNode) ti.bodyLine = tableNode.position?.start?.line ?? undefined;
      issues.push(ti);
    }

    // formula primitive — consumes table's key→value map
    if (rules.formula && parsedTable && rules.table.key_column && rules.table.value_column) {
      const { map, nonNumeric } = extractTableMap(
        parsedTable,
        rules.table.key_column,
        rules.table.value_column,
      );

      // Report non-numeric values.
      // NOTE: These issues use a hardcoded message rather than ctx.message because
      // the non-numeric diagnostic is an infrastructure concern (value extraction
      // failed), not a domain-level formula violation that the template author
      // would want to customize.
      for (const key of nonNumeric) {
        issues.push({
          level: severity,
          field: path,
          message: `Table key '${key}' has a non-numeric value — cannot evaluate formula`,
          error_type: "formula-violation",
          bodyLine: tableNode?.position?.start?.line ?? undefined,
        });
      }

      // Only evaluate formula if all values are numeric
      if (nonNumeric.length === 0) {
        const ctx2 = { field: path, severity, message: rules.message };
        const formulaIssues = PRIMITIVES.formula(map, rules.formula, ctx2);
        for (const fi of formulaIssues) {
          fi.bodyLine = tableNode?.position?.start?.line ?? undefined;
          issues.push(fi);
        }
      }
    }
  }

  // list primitive
  if (rules.list) {
    const listNode = docNode.contentNodes.find((n) => n.type === "list");
    const parsedList = listNode ? parseList(listNode) : null;
    const ctx = { field: path, severity, message: rules.message };
    const listIssues = PRIMITIVES.list(parsedList, rules.list, ctx);
    for (const li of listIssues) {
      if (listNode) li.bodyLine = listNode.position?.start?.line ?? undefined;
      issues.push(li);
    }
  }

  // code primitive
  if (rules.code) {
    const fences = findCodeFences(docNode.contentNodes);
    const ctx = { field: path, severity, message: rules.message };
    const codeIssues = PRIMITIVES.code(fences, rules.code, ctx);
    // Anchor at the first fence inside this section, falling back to the
    // section heading line when no fence is present (the "expected a code
    // fence but none found" case).
    const codeAnchorLine =
      fences?.[0]?.position?.start?.line ?? docNode.line ?? undefined;
    for (const ci of codeIssues) {
      ci.bodyLine = codeAnchorLine;
      issues.push(ci);
    }
  }

  // standalone formula (without table — uses empty map, will likely fail)
  if (rules.formula && !rules.table) {
    const ctx = { field: path, severity, message: rules.message };
    const formulaIssues = PRIMITIVES.formula({}, rules.formula, ctx);
    for (const fi of formulaIssues) {
      fi.bodyLine = docNode.line ?? undefined;
      issues.push(fi);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// validateBodyTemplateSchema — meta-validation for body section-rules (spec §8)
// ────────────────────────────────────────────────────────────────────────────

/** Keys allowed in a section-rules block. */
const SECTION_RULES_KEYS = new Set([
  "required", "repeatable", "heading", "table", "list", "code", "formula",
  "min", "max", "severity", "message",
]);

/**
 * Meta-validate a body schema — checks the template's section-rules blocks.
 * Returns Issue[] describing problems in the template (never throws).
 *
 * @param {BodySchemaNode[]} bodySchema - template heading tree children with sectionRules
 * @returns {BodyIssue[]}
 */
export function validateBodyTemplateSchema(bodySchema) {
  const issues = [];
  if (!Array.isArray(bodySchema)) return issues;

  function walk(nodes, ancestors) {
    for (const node of nodes) {
      const label = headingLabel(node.depth, node.text);
      const path = headingPath(ancestors, label);
      const rules = node.sectionRules;

      if (rules && typeof rules === "object") {
        // Check for unknown keys
        for (const key of Object.keys(rules)) {
          if (!SECTION_RULES_KEYS.has(key)) {
            issues.push(issue(
              "error",
              path,
              `Unknown section-rules key '${key}' in '${path}'.${didYouMean(key, SECTION_RULES_KEYS)}`,
              "template-schema-invalid",
              `Allowed keys: ${[...SECTION_RULES_KEYS].join(", ")}`,
            ));
          }
        }

        // Validate heading pattern compiles
        if (rules.heading && rules.heading.pattern) {
          try {
            new RegExp(rules.heading.pattern);
          } catch {
            issues.push(issue(
              "error",
              path,
              `Invalid regex in heading.pattern of '${path}': ${rules.heading.pattern}`,
              "template-schema-invalid",
            ));
          }
        }

        // Validate heading enum is array
        if (rules.heading && rules.heading.enum) {
          if (!Array.isArray(rules.heading.enum) || rules.heading.enum.length === 0) {
            issues.push(issue(
              "error",
              path,
              `heading.enum in '${path}' must be a non-empty array`,
              "template-schema-invalid",
            ));
          }
        }

        // Validate table shape
        if (rules.table && typeof rules.table !== "object") {
          issues.push(issue(
            "error",
            path,
            `'table' in '${path}' must be an object`,
            "template-schema-invalid",
          ));
        }

        // Validate list shape
        if (rules.list) {
          if (typeof rules.list !== "object") {
            issues.push(issue(
              "error",
              path,
              `'list' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else if (rules.list.item && rules.list.item.pattern) {
            try {
              new RegExp(rules.list.item.pattern);
            } catch {
              issues.push(issue(
                "error",
                path,
                `Invalid regex in list.item.pattern of '${path}': ${rules.list.item.pattern}`,
                "template-schema-invalid",
              ));
            }
          }
        }

        // Validate code shape
        if (rules.code && typeof rules.code !== "object") {
          issues.push(issue(
            "error",
            path,
            `'code' in '${path}' must be an object`,
            "template-schema-invalid",
          ));
        }

        // Validate formula parses
        if (rules.formula) {
          if (typeof rules.formula !== "string") {
            issues.push(issue(
              "error",
              path,
              `'formula' in '${path}' must be a string expression`,
              "template-schema-invalid",
            ));
          } else {
            try {
              formulaParse(rules.formula);
            } catch (e) {
              issues.push(issue(
                "error",
                path,
                `Invalid formula expression in '${path}': ${e.message}`,
                "template-schema-invalid",
              ));
            }
          }
        }

        // Validate min/max are numbers
        if (rules.min !== undefined && (typeof rules.min !== "number" || Number.isNaN(rules.min))) {
          issues.push(issue(
            "error",
            path,
            `'min' in '${path}' must be a number`,
            "template-schema-invalid",
          ));
        }
        if (rules.max !== undefined && (typeof rules.max !== "number" || Number.isNaN(rules.max))) {
          issues.push(issue(
            "error",
            path,
            `'max' in '${path}' must be a number`,
            "template-schema-invalid",
          ));
        }
      }

      // Recurse into children
      if (Array.isArray(node.children)) {
        walk(node.children, [...ancestors, label]);
      }
    }
  }

  walk(bodySchema, []);
  return issues;
}
