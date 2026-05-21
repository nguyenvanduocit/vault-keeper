/**
 * Scalar primitives — primitives that take a single value and a
 * constraint param, returning Issue[].
 *
 *   type, required, enum, pattern, min, max, uniqueItems, exists,
 *   description
 *
 * `before` / `after` live in `chronological.js`; the structural
 * primitives (`heading`, `table`, `list`, `code`, `formula`,
 * `repeatable`) live in their own files.
 *
 * The scalar `type` primitive is the only one that needs the
 * chronological vocabulary (for `type: date` / `datetime` / `time`)
 * — it imports the regexes + format helper, but the `before` / `after`
 * runtime is opaque to it.
 */

import { issue } from "../helpers/issue.js";
import {
  TIME_RE,
  DATETIME_RE,
  formatDateLike,
} from "./chronological.js";

/** Canonical type tokens allowed on `type:`. */
export const VALID_TYPES = new Set([
  "string", "integer", "number", "boolean",
  "date", "datetime", "time",
  "array",
]);

/**
 * Resolve the comparable target for `min` / `max` based on the field's
 * declared `type`.
 *
 *   string                → value.length
 *   number / integer      → value
 *   array                 → value.length
 *   (no declared type)    → numeric value if the value itself is a number
 */
function resolveMinMaxTarget(value, type) {
  if (type === "string" && typeof value === "string") return value.length;
  if ((type === "number" || type === "integer") && typeof value === "number") return value;
  if (type === "array" && Array.isArray(value)) return value.length;
  if (type === undefined && typeof value === "number") return value;
  return undefined;
}

/** Friendly label for min/max messages: "Length" vs "Count" vs "Value". */
function minMaxLabel(type) {
  if (type === "string") return "Length";
  if (type === "array") return "Count";
  return "Value";
}

// ────────────────────────────────────────────────────────────────────────────
// Scalar primitive implementations
// ────────────────────────────────────────────────────────────────────────────

function type(value, param, ctx) {
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
}

function required(_value, _param, _ctx) {
  // Handled specially in applyFieldSchema — never called as a normal
  // primitive. Registered so meta-validation recognizes it.
  return [];
}

function enumPrim(value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  if (!Array.isArray(param)) return [];
  if (!param.includes(value)) {
    return [issue(level, field, ctx.message || `Value '${value}' is not in allowed values: [${param.join(", ")}]`, "enum-violation", `Use one of: ${param.join(", ")}`)];
  }
  return [];
}

function pattern(value, param, ctx) {
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
}

function min(value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const actual = resolveMinMaxTarget(value, ctx.type);
  if (actual === undefined) return [];
  if (actual < param) {
    const label = minMaxLabel(ctx.type);
    return [issue(level, field, ctx.message || `${label} ${actual} is less than minimum ${param}`, "min-violation")];
  }
  return [];
}

function max(value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const actual = resolveMinMaxTarget(value, ctx.type);
  if (actual === undefined) return [];
  if (actual > param) {
    const label = minMaxLabel(ctx.type);
    return [issue(level, field, ctx.message || `${label} ${actual} exceeds maximum ${param}`, "max-violation")];
  }
  return [];
}

function uniqueItems(value, param, ctx) {
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
}

function exists(value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  if (!param || typeof value !== "string") return [];
  const resolver = ctx.fileExists || (() => true);
  if (!resolver(value)) {
    return [issue(level, field, ctx.message || `Referenced file '${value}' does not exist`, "exists-missing", `Create or fix the path: ${value}`)];
  }
  return [];
}

function description(_value, _param, _ctx) {
  // Metadata only — emits nothing.
  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// Public surface — runtime functions used to register in PRIMITIVES.
// ────────────────────────────────────────────────────────────────────────────

export const scalarPrimitives = {
  type,
  required,
  enum: enumPrim,
  pattern,
  min,
  max,
  uniqueItems,
  exists,
  description,
};
