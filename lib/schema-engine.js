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
    // `_value` is a ParsedTable | null.
    // `param` is { columns?, rows?, strict? }.
    //
    // columns accepts two shapes:
    //   - shorthand:  ["name", "role", "status"]
    //                 → each = { name: <x>, required: true }
    //   - expanded:   [{ name, required, values: { ... } }, ...]
    //                 → per-column header presence + per-cell constraints
    // Mixed arrays are rejected by meta-validation; runtime treats a
    // mixed input defensively (each element resolved on its own).
    //
    // rows  = { min?, max? } — row count (excluding header).
    // strict = true → reject any column the template did not declare.
    //
    // Per-cell constraints (values.required / pattern / enum / unique /
    // type / min / max) follow the deterministic order documented in the
    // template reference: presence → type → required → enum → pattern →
    // min/max → unique.
    const level = ctx.severity || "error";
    const field = ctx.field;

    if (!_value) {
      return [issue(level, field, ctx.message || "Expected a table but none found", "table-shape")];
    }

    const issues = [];
    const normalisedColumns = normaliseColumns(param.columns);

    // Per-column: header presence + per-cell values constraints.
    for (const col of normalisedColumns) {
      const headerKey = String(col.name).toLowerCase().trim();
      const headerIdx = _value.headers.indexOf(headerKey);
      const required = col.required !== false; // default true
      if (headerIdx === -1) {
        if (required) {
          issues.push(issue(level, field, ctx.message || `Table missing required column '${col.name}'`, "table-shape"));
        }
        continue;
      }
      if (col.values && typeof col.values === "object") {
        applyValueRulesToColumn(_value, headerIdx, col, ctx, issues);
      }
    }

    // Row-count cardinality.
    if (param.rows && typeof param.rows === "object") {
      const rowCount = _value.rows.length;
      const rmin = param.rows.min ?? 0;
      const rmax = param.rows.max ?? Infinity;
      if (rowCount < rmin) {
        issues.push(issue(level, field, ctx.message || `Table has ${rowCount} row(s), expected at least ${rmin}`, "table-shape"));
      }
      if (rowCount > rmax) {
        issues.push(issue(level, field, ctx.message || `Table has ${rowCount} row(s), expected at most ${rmax}`, "table-shape"));
      }
    }

    // Strict mode — reject columns the template did not declare.
    if (param.strict === true) {
      const declared = new Set(normalisedColumns.map((c) => String(c.name).toLowerCase().trim()));
      for (const header of _value.headers) {
        if (!declared.has(header)) {
          issues.push(issue(level, field, ctx.message || `Table contains undeclared column '${header}'`, "table-shape"));
        }
      }
    }

    return issues;
  },

  list(_value, param, ctx) {
    // `_value` is a ParsedList | null.
    // `param` is { items?: { required?, pattern?, enum? }, min?, max?, unique? }.
    //
    // List-level constraints (min/max/unique) operate on item count and
    // text values. Per-item constraints (items.required / pattern / enum)
    // run once per item; each violation produces one issue anchored at
    // that item's line.
    const level = ctx.severity || "error";
    const field = ctx.field;

    if (!_value) {
      return [issue(level, field, ctx.message || "Expected a list but none found", "list-item")];
    }

    const issues = [];
    const items = _value.items || [];

    // List-level cardinality.
    const min = param.min ?? 0;
    const max = param.max ?? Infinity;
    if (items.length < min) {
      issues.push(issue(level, field, ctx.message || `Expected at least ${min} list item(s), found ${items.length}`, "list-item"));
    }
    if (items.length > max) {
      issues.push(issue(level, field, ctx.message || `Expected at most ${max} list item(s), found ${items.length}`, "list-item"));
    }

    // List-level uniqueness on item text.
    if (param.unique) {
      const seen = new Map();
      for (const item of items) {
        const key = item.text;
        if (seen.has(key)) {
          const dup = issue(level, field, ctx.message || `Duplicate list item '${key}'`, "unique-violation");
          dup.bodyLine = item.line;
          issues.push(dup);
        } else {
          seen.set(key, item);
        }
      }
    }

    // Per-item constraints.
    if (param.items && typeof param.items === "object") {
      const itemRules = param.items;
      let re = null;
      if (itemRules.pattern) {
        try {
          re = new RegExp(itemRules.pattern);
        } catch {
          re = null; // unparseable regex — meta-validation surfaces this
        }
      }
      const allowedEnum = Array.isArray(itemRules.enum) ? itemRules.enum.map((v) => String(v)) : null;
      for (const item of items) {
        if (itemRules.required && (!item.text || !item.text.trim())) {
          const i = issue(level, field, ctx.message || `List item is empty`, "list-item");
          i.bodyLine = item.line;
          issues.push(i);
          continue;
        }
        if (re && !re.test(item.text)) {
          const i = issue(level, field, ctx.message || `List item '${item.text}' does not match pattern '${itemRules.pattern}'`, "list-item");
          i.bodyLine = item.line;
          issues.push(i);
        }
        if (allowedEnum && !allowedEnum.includes(item.text)) {
          const i = issue(level, field, ctx.message || `List item '${item.text}' is not in allowed values: [${allowedEnum.join(", ")}]`, "list-item");
          i.bodyLine = item.line;
          issues.push(i);
        }
      }
    }

    return issues;
  },

  code(_value, param, ctx) {
    // `_value` is CodeFence[] (from findCodeFences).
    // `param` is { lang?, min?, max?, content?: { pattern? } }.
    //
    // Semantics:
    //  - When `lang` is set, every constraint targets fences of that lang.
    //  - `min` defaults to 1 (≥ 1 fence expected). Use `min: 0` to allow
    //    zero matching fences — useful when the section is optional.
    //  - `max` defaults to Infinity (no cap).
    //  - `content.pattern` is applied per-fence; one issue per failing
    //    fence, each anchored at that fence's line.
    const level = ctx.severity || "error";
    const field = ctx.field;
    const fences = Array.isArray(_value) ? _value : [];
    const issues = [];

    const filtered = param.lang
      ? fences.filter((f) => f.lang && f.lang.toLowerCase() === param.lang.toLowerCase())
      : fences;

    const what = param.lang ? `'${param.lang}' code fence(s)` : "code fence(s)";
    const min = param.min ?? 1;
    const max = param.max ?? Infinity;

    if (filtered.length < min) {
      issues.push(issue(
        level,
        field,
        ctx.message || (filtered.length === 0
          ? `Expected ${min === 1 ? "a" : `at least ${min}`} ${what} but none found`
          : `Expected at least ${min} ${what}, found ${filtered.length}`),
        "code-missing",
      ));
    }
    if (filtered.length > max) {
      issues.push(issue(
        level,
        field,
        ctx.message || `Expected at most ${max} ${what}, found ${filtered.length}`,
        "code-missing",
      ));
    }

    if (param.content && param.content.pattern) {
      let re;
      try {
        re = new RegExp(param.content.pattern);
      } catch {
        return issues; // unparseable regex — meta-validation will flag at template level
      }
      for (const fence of filtered) {
        if (!re.test(fence.value)) {
          const i = issue(
            level,
            field,
            ctx.message || `Code fence at line ${fence.line} does not match content.pattern '${param.content.pattern}'`,
            "code-content-mismatch",
            `Must match: ${param.content.pattern}`,
          );
          i.bodyLine = fence.line;
          issues.push(i);
        }
      }
    }

    return issues;
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

/**
 * Normalise a `columns:` array into a uniform shape regardless of which
 * form the template used.
 *
 *   ["name", "role"]                 → [{name: "name", required: true},
 *                                       {name: "role", required: true}]
 *   [{name: "name", values: {...}}]  → unchanged
 *
 * Non-string / non-object entries are dropped (meta-validation flags
 * them — runtime stays defensive). Mixed arrays are tolerated at runtime
 * (each entry resolved independently); meta-validation rejects them.
 */
function normaliseColumns(columns) {
  if (!Array.isArray(columns)) return [];
  const out = [];
  for (const c of columns) {
    if (typeof c === "string") {
      out.push({ name: c, required: true });
    } else if (c && typeof c === "object" && typeof c.name === "string") {
      out.push(c);
    }
  }
  return out;
}

/**
 * Apply a `values:` constraint set to every cell in a single table
 * column. Order of evaluation is fixed and documented:
 *
 *   presence → type → required (non-empty) → enum → pattern → min/max → unique
 *
 * `column.values` is opaque to the runtime — we only pick the keys we
 * understand; unknown keys are flagged by meta-validation.
 *
 * @param {ParsedTable} table
 * @param {number} headerIdx - index of this column in `table.headers`
 * @param {object} column - normalised column descriptor
 * @param {object} ctx - validation context with severity / message
 * @param {Array} issues - sink for diagnostics
 */
function applyValueRulesToColumn(table, headerIdx, column, ctx, issues) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const rules = column.values;
  const name = column.name;

  // Pre-compile regex; an unparseable pattern is meta-validation's job.
  let re = null;
  if (rules.pattern) {
    try { re = new RegExp(rules.pattern); } catch { re = null; }
  }
  const enumSet = Array.isArray(rules.enum) ? rules.enum.map((v) => String(v)) : null;
  const seen = new Map(); // for `unique`

  for (let r = 0; r < table.rows.length; r++) {
    const cell = (table.rows[r][headerIdx] ?? "").trim();
    const cellField = `${field} [col '${name}' row ${r + 1}]`;

    // 1. Required / non-empty.
    if (rules.required && !cell) {
      issues.push(issue(level, cellField, ctx.message || `Cell in column '${name}' (row ${r + 1}) is empty`, "table-cell"));
      continue;
    }
    if (!cell) continue; // optional + empty → skip remaining checks

    // 2. Type coercion / parseability.
    if (rules.type && cellTypeMismatch(cell, rules.type)) {
      issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' is not a ${rules.type}`, "table-cell"));
      continue;
    }

    // 3. Enum.
    if (enumSet && !enumSet.includes(cell)) {
      issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' is not in allowed values: [${enumSet.join(", ")}]`, "table-cell"));
    }

    // 4. Pattern.
    if (re && !re.test(cell)) {
      issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' does not match pattern '${rules.pattern}'`, "table-cell"));
    }

    // 5. min / max — interpreted under the declared type.
    if (rules.min !== undefined || rules.max !== undefined) {
      const target = resolveCellMinMaxTarget(cell, rules.type);
      if (target !== undefined) {
        if (rules.min !== undefined && target < rules.min) {
          issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' is below minimum ${rules.min}`, "table-cell"));
        }
        if (rules.max !== undefined && target > rules.max) {
          issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' exceeds maximum ${rules.max}`, "table-cell"));
        }
      }
    }

    // 6. Unique across rows.
    if (rules.unique) {
      if (seen.has(cell)) {
        issues.push(issue(level, cellField, ctx.message || `Duplicate cell value '${cell}' in column '${name}'`, "table-cell"));
      } else {
        seen.set(cell, r);
      }
    }
  }
}

/**
 * Meta-validate a `table.columns` declaration.
 *
 * Accepts a homogeneous array of either:
 *   - string  (shorthand: column header only)
 *   - object  (expanded: { name, required?, values? })
 *
 * Mixed arrays are rejected — they make error reporting and tooling
 * fuzzy. Per-column shape is checked recursively (inner keys against
 * TABLE_COLUMN_INNER_KEYS, then values constraints against
 * TABLE_VALUES_INNER_KEYS, with the values.pattern regex compiled).
 */
function validateTableColumns(columns, path, issues) {
  if (!Array.isArray(columns)) {
    issues.push(issue(
      "error",
      path,
      `'table.columns' in '${path}' must be an array`,
      "template-schema-invalid",
    ));
    return;
  }
  let sawString = false;
  let sawObject = false;
  for (let idx = 0; idx < columns.length; idx++) {
    const c = columns[idx];
    if (typeof c === "string") {
      sawString = true;
      continue;
    }
    if (c && typeof c === "object" && !Array.isArray(c)) {
      sawObject = true;
      if (typeof c.name !== "string" || !c.name.trim()) {
        issues.push(issue(
          "error",
          path,
          `'table.columns[${idx}]' in '${path}' must declare a 'name' string`,
          "template-schema-invalid",
        ));
        continue;
      }
      for (const key of Object.keys(c)) {
        if (!TABLE_COLUMN_INNER_KEYS.has(key)) {
          issues.push(issue(
            "error",
            path,
            `Unknown key '${key}' in 'table.columns[${idx}]' (${c.name}) at '${path}'.${didYouMean(key, TABLE_COLUMN_INNER_KEYS)}`,
            "template-schema-invalid",
            `Allowed keys: ${[...TABLE_COLUMN_INNER_KEYS].join(", ")}`,
          ));
        }
      }
      if (c.values && typeof c.values === "object") {
        for (const key of Object.keys(c.values)) {
          if (!TABLE_VALUES_INNER_KEYS.has(key)) {
            issues.push(issue(
              "error",
              path,
              `Unknown key '${key}' in 'table.columns[${idx}].values' (${c.name}) at '${path}'.${didYouMean(key, TABLE_VALUES_INNER_KEYS)}`,
              "template-schema-invalid",
              `Allowed keys: ${[...TABLE_VALUES_INNER_KEYS].join(", ")}`,
            ));
          }
        }
        if (c.values.pattern) {
          try { new RegExp(c.values.pattern); }
          catch {
            issues.push(issue(
              "error",
              path,
              `Invalid regex in table.columns[${idx}].values.pattern (${c.name}) of '${path}': ${c.values.pattern}`,
              "template-schema-invalid",
            ));
          }
        }
        if (c.values.enum !== undefined && !Array.isArray(c.values.enum)) {
          issues.push(issue(
            "error",
            path,
            `'table.columns[${idx}].values.enum' (${c.name}) at '${path}' must be an array`,
            "template-schema-invalid",
          ));
        }
        if (c.values.type !== undefined && !VALID_TYPES.has(c.values.type)) {
          issues.push(issue(
            "error",
            path,
            `Invalid type '${c.values.type}' on table.columns[${idx}].values (${c.name}) of '${path}'. Allowed: ${[...VALID_TYPES].join(", ")}.${didYouMean(String(c.values.type), VALID_TYPES)}`,
            "template-schema-invalid",
          ));
        }
      }
      continue;
    }
    issues.push(issue(
      "error",
      path,
      `'table.columns[${idx}]' in '${path}' must be a string or an object`,
      "template-schema-invalid",
    ));
  }
  if (sawString && sawObject) {
    issues.push(issue(
      "error",
      path,
      `'table.columns' in '${path}' mixes string shorthand and object form — pick one`,
      "template-schema-invalid",
    ));
  }
}

/**
 * Return true when `cell` (a trimmed string from a markdown table) does
 * NOT parse under the declared type. `string` always passes; other types
 * apply a lenient check sufficient for human-authored documents.
 */
function cellTypeMismatch(cell, type) {
  switch (type) {
    case "string":  return false;
    case "integer": return !/^-?\d+$/.test(cell);
    case "number":  return !/^-?\d+(?:\.\d+)?$/.test(cell);
    case "boolean": return !/^(true|false)$/i.test(cell);
    case "date":    return Number.isNaN(Date.parse(cell)) || !/^\d{4}-\d{2}-\d{2}/.test(cell);
    case "datetime": return Number.isNaN(Date.parse(cell)) || !DATETIME_RE.test(cell);
    case "time":    return !TIME_RE.test(cell);
    default:        return false;
  }
}

/**
 * Resolve a comparable value for `min`/`max` on a table cell. Mirrors
 * resolveMinMaxTarget but operates on the raw string text.
 *   string  → length
 *   number/integer → numeric value
 *   undefined type → numeric value if parseable, else length
 */
function resolveCellMinMaxTarget(cell, type) {
  if (type === "string") return cell.length;
  if (type === "integer" || type === "number") {
    const n = Number(cell);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === undefined) {
    const n = Number(cell);
    return Number.isFinite(n) ? n : cell.length;
  }
  return undefined;
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
 * @property {object}   [table]      - { columns?, rows?, strict? }
 * @property {object}   [list]       - { items?, min?, max?, unique? }
 * @property {object}   [code]       - { lang?, min?, max?, content? }
 * @property {string}   [formula]    - arithmetic / comparison expression over frontmatter values
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
    const tableAnchorLine = tableNode?.position?.start?.line ?? undefined;
    for (const ti of tableIssues) {
      if (ti.bodyLine == null) ti.bodyLine = tableAnchorLine;
      issues.push(ti);
    }
  }

  // list primitive
  if (rules.list) {
    const listNode = docNode.contentNodes.find((n) => n.type === "list");
    const parsedList = listNode ? parseList(listNode) : null;
    const ctx = { field: path, severity, message: rules.message };
    const listIssues = PRIMITIVES.list(parsedList, rules.list, ctx);
    // Anchor list-level issues (cardinality, list-missing) at the list
    // node. Per-item issues keep their own item.line set by the primitive.
    const listAnchorLine = listNode?.position?.start?.line ?? undefined;
    for (const li of listIssues) {
      if (li.bodyLine == null) li.bodyLine = listAnchorLine;
      issues.push(li);
    }
  }

  // code primitive
  if (rules.code) {
    const fences = findCodeFences(docNode.contentNodes);
    const ctx = { field: path, severity, message: rules.message };
    const codeIssues = PRIMITIVES.code(fences, rules.code, ctx);
    // Anchor cardinality issues at the first fence inside this section,
    // falling back to the section heading line when no fence is present.
    // The `code-content-mismatch` issues already carry their own per-fence
    // bodyLine — do NOT overwrite those.
    const codeAnchorLine = fences?.[0]?.line ?? docNode.line ?? undefined;
    for (const ci of codeIssues) {
      if (ci.bodyLine == null) ci.bodyLine = codeAnchorLine;
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

// ── Inner-key allow-lists per compound primitive ────────────────────────
// Centralised so meta-validation can surface unknown nested keys with a
// `did you mean?` fuzzy suggestion. Each set is the closed contract of
// what that primitive understands at one nesting level.

const LIST_INNER_KEYS = new Set(["items", "min", "max", "unique"]);
const LIST_ITEMS_INNER_KEYS = new Set(["required", "pattern", "enum"]);

const CODE_INNER_KEYS = new Set(["lang", "min", "max", "content"]);
const CODE_CONTENT_INNER_KEYS = new Set(["pattern"]);

const TABLE_INNER_KEYS = new Set(["columns", "rows", "strict"]);
const TABLE_COLUMN_INNER_KEYS = new Set(["name", "required", "values"]);
const TABLE_VALUES_INNER_KEYS = new Set([
  "required", "pattern", "enum", "unique", "type", "min", "max",
]);
const TABLE_ROWS_INNER_KEYS = new Set(["min", "max"]);

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

        // Validate table shape — inner keys, columns array shape, rows
        // and per-column values constraints.
        if (rules.table) {
          if (typeof rules.table !== "object") {
            issues.push(issue(
              "error",
              path,
              `'table' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else {
            for (const key of Object.keys(rules.table)) {
              if (!TABLE_INNER_KEYS.has(key)) {
                issues.push(issue(
                  "error",
                  path,
                  `Unknown key '${key}' in 'table' at '${path}'.${didYouMean(key, TABLE_INNER_KEYS)}`,
                  "template-schema-invalid",
                  `Allowed keys: ${[...TABLE_INNER_KEYS].join(", ")}`,
                ));
              }
            }
            if (rules.table.columns !== undefined) {
              validateTableColumns(rules.table.columns, path, issues);
            }
            if (rules.table.rows && typeof rules.table.rows === "object") {
              for (const key of Object.keys(rules.table.rows)) {
                if (!TABLE_ROWS_INNER_KEYS.has(key)) {
                  issues.push(issue(
                    "error",
                    path,
                    `Unknown key '${key}' in 'table.rows' at '${path}'.${didYouMean(key, TABLE_ROWS_INNER_KEYS)}`,
                    "template-schema-invalid",
                    `Allowed keys: ${[...TABLE_ROWS_INNER_KEYS].join(", ")}`,
                  ));
                }
              }
            }
          }
        }

        // Validate list shape — inner keys and regex.
        // Allowed keys inside `list:` (top), inside `list.items:`, and
        // (legacy) inside `list.item:` so a clear migration error fires.
        if (rules.list) {
          if (typeof rules.list !== "object") {
            issues.push(issue(
              "error",
              path,
              `'list' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else {
            for (const key of Object.keys(rules.list)) {
              if (!LIST_INNER_KEYS.has(key)) {
                issues.push(issue(
                  "error",
                  path,
                  `Unknown key '${key}' in 'list' at '${path}'.${didYouMean(key, LIST_INNER_KEYS)}`,
                  "template-schema-invalid",
                  `Allowed keys: ${[...LIST_INNER_KEYS].join(", ")}`,
                ));
              }
            }
            if (rules.list.items && typeof rules.list.items === "object") {
              for (const key of Object.keys(rules.list.items)) {
                if (!LIST_ITEMS_INNER_KEYS.has(key)) {
                  issues.push(issue(
                    "error",
                    path,
                    `Unknown key '${key}' in 'list.items' at '${path}'.${didYouMean(key, LIST_ITEMS_INNER_KEYS)}`,
                    "template-schema-invalid",
                    `Allowed keys: ${[...LIST_ITEMS_INNER_KEYS].join(", ")}`,
                  ));
                }
              }
              if (rules.list.items.pattern) {
                try {
                  new RegExp(rules.list.items.pattern);
                } catch {
                  issues.push(issue(
                    "error",
                    path,
                    `Invalid regex in list.items.pattern of '${path}': ${rules.list.items.pattern}`,
                    "template-schema-invalid",
                  ));
                }
              }
              if (rules.list.items.enum !== undefined && !Array.isArray(rules.list.items.enum)) {
                issues.push(issue(
                  "error",
                  path,
                  `'list.items.enum' in '${path}' must be an array`,
                  "template-schema-invalid",
                ));
              }
            }
          }
        }

        // Validate code shape — inner keys and content.pattern regex.
        if (rules.code) {
          if (typeof rules.code !== "object") {
            issues.push(issue(
              "error",
              path,
              `'code' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else {
            for (const key of Object.keys(rules.code)) {
              if (!CODE_INNER_KEYS.has(key)) {
                issues.push(issue(
                  "error",
                  path,
                  `Unknown key '${key}' in 'code' at '${path}'.${didYouMean(key, CODE_INNER_KEYS)}`,
                  "template-schema-invalid",
                  `Allowed keys: ${[...CODE_INNER_KEYS].join(", ")}`,
                ));
              }
            }
            if (rules.code.content && typeof rules.code.content === "object") {
              for (const key of Object.keys(rules.code.content)) {
                if (!CODE_CONTENT_INNER_KEYS.has(key)) {
                  issues.push(issue(
                    "error",
                    path,
                    `Unknown key '${key}' in 'code.content' at '${path}'.${didYouMean(key, CODE_CONTENT_INNER_KEYS)}`,
                    "template-schema-invalid",
                    `Allowed keys: ${[...CODE_CONTENT_INNER_KEYS].join(", ")}`,
                  ));
                }
              }
              if (rules.code.content.pattern) {
                try {
                  new RegExp(rules.code.content.pattern);
                } catch {
                  issues.push(issue(
                    "error",
                    path,
                    `Invalid regex in code.content.pattern of '${path}': ${rules.code.content.pattern}`,
                    "template-schema-invalid",
                  ));
                }
              }
            }
          }
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
