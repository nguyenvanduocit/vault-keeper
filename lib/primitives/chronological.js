/**
 * Chronological primitives — `before` and `after` — plus the shared
 * date/datetime/time parsing utilities (`toComparableTime`,
 * `formatDateLike`) and canonical regexes (`TIME_RE`, `DATETIME_RE`)
 * used by both the scalar `type:` primitive and these two bounds.
 *
 * Each exported primitive follows the spec-object shape:
 *
 *   {
 *     name:           string,
 *     validate:       (value, param, ctx) => Issue[],
 *     validateConfig: (normValue, declaredType, fieldName) => Issue[],
 *   }
 *
 * `validate` runs against a document value; `validateConfig` runs at
 * template load time and surfaces template-schema-invalid issues
 * before any document hits the constraint (e.g. before/after declared
 * with the wrong `type:`).
 */

import { issue } from "../helpers/issue.js";

/** 24-hour `HH:MM` or `HH:MM:SS`, no timezone. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * ISO 8601 / RFC 3339 with a `T` separator, optional sub-second
 * precision, optional `Z` or `±HH:MM` offset.
 */
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/** Types for which `before` / `after` are meaningful. */
const CHRONOLOGICAL_TYPES = new Set(["date", "datetime", "time"]);

/**
 * Parse a date/datetime/time value into a comparable numeric value.
 * Returns null when the value cannot be parsed under the requested type.
 *
 * - `time`        → seconds since 00:00:00
 * - everything    → milliseconds since epoch (via Date.parse)
 *
 * @param {unknown} value
 * @param {string} [type]
 * @returns {number|null}
 */
export function toComparableTime(value, type) {
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
export function formatDateLike(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return String(value);
}

/**
 * Shared template-time validator for `before` / `after`. Reports:
 *  - missing declared `type:`
 *  - non-chronological declared type
 *  - bound that doesn't parse under the declared type
 */
function chronologicalBoundConfig(name, normValue, declaredType, fieldName) {
  const issues = [];
  if (!declaredType) {
    issues.push(issue(
      "error",
      fieldName,
      `'${name}' on field '${fieldName}' requires a declared 'type' of date, datetime, or time`,
      "template-schema-invalid",
    ));
  } else if (!CHRONOLOGICAL_TYPES.has(declaredType)) {
    issues.push(issue(
      "error",
      fieldName,
      `'${name}' on field '${fieldName}' is only valid with type 'date', 'datetime', or 'time' — got '${declaredType}'`,
      "template-schema-invalid",
    ));
  } else if (toComparableTime(normValue, declaredType) === null) {
    issues.push(issue(
      "error",
      fieldName,
      `'${name}' value '${normValue}' on field '${fieldName}' is not a parseable ${declaredType}`,
      "template-schema-invalid",
    ));
  }
  return issues;
}

function beforeValidate(value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const lv = toComparableTime(value, ctx.type);
  const rv = toComparableTime(param, ctx.type);
  if (lv === null || rv === null) return [];
  if (!(lv < rv)) {
    return [issue(level, field, ctx.message || `Value '${formatDateLike(value)}' is not before '${param}'`, "before-violation")];
  }
  return [];
}

function afterValidate(value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const lv = toComparableTime(value, ctx.type);
  const rv = toComparableTime(param, ctx.type);
  if (lv === null || rv === null) return [];
  if (!(lv > rv)) {
    return [issue(level, field, ctx.message || `Value '${formatDateLike(value)}' is not after '${param}'`, "after-violation")];
  }
  return [];
}

export const beforePrimitive = {
  name: "before",
  validate: beforeValidate,
  validateConfig(normValue, declaredType, fieldName) {
    return chronologicalBoundConfig("before", normValue, declaredType, fieldName);
  },
};

export const afterPrimitive = {
  name: "after",
  validate: afterValidate,
  validateConfig(normValue, declaredType, fieldName) {
    return chronologicalBoundConfig("after", normValue, declaredType, fieldName);
  },
};
