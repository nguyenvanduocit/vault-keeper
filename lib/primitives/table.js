/**
 * `table` primitive — validates a markdown GFM table against three
 * layers of constraint, each living in the same file as the runtime
 * that enforces it:
 *
 *   table-level   → `rows: {min,max}`, `strict: true`
 *   column-level  → `columns: [{name, required?}]`
 *   cell-level    → `columns: [{name, values: {...}}]`
 *
 * Inner-key allow-lists (TABLE_INNER_KEYS / TABLE_COLUMN_INNER_KEYS /
 * TABLE_VALUES_INNER_KEYS / TABLE_ROWS_INNER_KEYS) and the template-
 * time `validateColumns` walker are co-located so meta-validation can
 * ask the primitive for the closed contract instead of duplicating
 * constants elsewhere.
 */

import { issue } from "../helpers/issue.js";
import { didYouMean } from "../fuzzy-suggest.js";
import { checkUnknownKeys } from "../helpers/unknown-keys.js";
import { VALID_TYPES } from "./scalar.js";
import { TIME_RE, DATETIME_RE } from "./chronological.js";

// ── Inner-key allow-lists ───────────────────────────────────────────────

export const TABLE_INNER_KEYS = new Set(["columns", "rows", "strict"]);
export const TABLE_COLUMN_INNER_KEYS = new Set(["name", "required", "values"]);
export const TABLE_VALUES_INNER_KEYS = new Set([
  "required", "pattern", "enum", "unique", "type", "min", "max",
]);
export const TABLE_ROWS_INNER_KEYS = new Set(["min", "max"]);

// ── Runtime helpers (private) ───────────────────────────────────────────

/**
 * Normalise a `columns:` array into a uniform shape regardless of
 * which form the template used. Mixed arrays are tolerated at runtime
 * — meta-validation rejects them.
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
 * Lenient type check for a trimmed cell string. `string` always
 * passes; numeric / boolean / chronological types apply a syntax-only
 * check sufficient for human-authored documents.
 */
function cellTypeMismatch(cell, type) {
  switch (type) {
    case "string":   return false;
    case "integer":  return !/^-?\d+$/.test(cell);
    case "number":   return !/^-?\d+(?:\.\d+)?$/.test(cell);
    case "boolean":  return !/^(true|false)$/i.test(cell);
    case "date":     return Number.isNaN(Date.parse(cell)) || !/^\d{4}-\d{2}-\d{2}/.test(cell);
    case "datetime": return Number.isNaN(Date.parse(cell)) || !DATETIME_RE.test(cell);
    case "time":     return !TIME_RE.test(cell);
    default:         return false;
  }
}

/**
 * Comparable value for cell-level `min` / `max`. Mirrors scalar
 * `resolveMinMaxTarget` but operates on raw cell text and skips
 * declared types that don't make numeric / length sense.
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

/**
 * Apply a column's `values:` constraints to every cell in that
 * column. Order of evaluation is fixed and documented:
 *
 *   presence → type → required (non-empty) → enum → pattern → min/max → unique
 */
function applyValueRulesToColumn(table, headerIdx, column, ctx, issues) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const rules = column.values;
  const name = column.name;

  let re = null;
  if (rules.pattern) {
    try { re = new RegExp(rules.pattern); } catch { re = null; }
  }
  const enumSet = Array.isArray(rules.enum) ? rules.enum.map((v) => String(v)) : null;
  const seen = new Map();

  for (let r = 0; r < table.rows.length; r++) {
    const cell = (table.rows[r][headerIdx] ?? "").trim();
    const cellField = `${field} [col '${name}' row ${r + 1}]`;

    if (rules.required && !cell) {
      issues.push(issue(level, cellField, ctx.message || `Cell in column '${name}' (row ${r + 1}) is empty`, "table-cell"));
      continue;
    }
    if (!cell) continue;

    if (rules.type && cellTypeMismatch(cell, rules.type)) {
      issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' is not a ${rules.type}`, "table-cell"));
      continue;
    }

    if (enumSet && !enumSet.includes(cell)) {
      issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' is not in allowed values: [${enumSet.join(", ")}]`, "table-cell"));
    }

    if (re && !re.test(cell)) {
      issues.push(issue(level, cellField, ctx.message || `Cell '${cell}' in column '${name}' does not match pattern '${rules.pattern}'`, "table-cell"));
    }

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

    if (rules.unique) {
      if (seen.has(cell)) {
        issues.push(issue(level, cellField, ctx.message || `Duplicate cell value '${cell}' in column '${name}'`, "table-cell"));
      } else {
        seen.set(cell, r);
      }
    }
  }
}

// ── Runtime ────────────────────────────────────────────────────────────

function validate(_value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;

  if (!_value) {
    return [issue(level, field, ctx.message || "Expected a table but none found", "table-shape")];
  }

  const issues = [];
  const normalisedColumns = normaliseColumns(param.columns);

  for (const col of normalisedColumns) {
    const headerKey = String(col.name).toLowerCase().trim();
    const headerIdx = _value.headers.indexOf(headerKey);
    const required = col.required !== false;
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

  if (param.strict === true) {
    const declared = new Set(normalisedColumns.map((c) => String(c.name).toLowerCase().trim()));
    for (const header of _value.headers) {
      if (!declared.has(header)) {
        issues.push(issue(level, field, ctx.message || `Table contains undeclared column '${header}'`, "table-shape"));
      }
    }
  }

  return issues;
}

// ── Template-time meta-validation for `table.columns` ───────────────────

/**
 * Walk a `columns:` declaration and report shape errors before any
 * document hits it. Mixed (string + object) arrays are rejected; per-
 * column inner keys and nested `values:` constraints are checked
 * against the allow-lists above.
 */
export function validateColumns(columns, path, issues) {
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
      checkUnknownKeys(c, TABLE_COLUMN_INNER_KEYS, `'table.columns[${idx}]' (${c.name})`, path, issues);
      if (c.values && typeof c.values === "object") {
        checkUnknownKeys(c.values, TABLE_VALUES_INNER_KEYS, `'table.columns[${idx}].values' (${c.name})`, path, issues);
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

export function validateConfig(param, path, issues) {
  if (param.columns !== undefined) {
    validateColumns(param.columns, path, issues);
  }
  if (param.rows && typeof param.rows === "object") {
    checkUnknownKeys(param.rows, TABLE_ROWS_INNER_KEYS, "'table.rows'", path, issues);
  }
}

export const tablePrimitive = {
  name: "table",
  ruleType: "object",
  innerKeys: TABLE_INNER_KEYS,
  columnInnerKeys: TABLE_COLUMN_INNER_KEYS,
  valuesInnerKeys: TABLE_VALUES_INNER_KEYS,
  rowsInnerKeys: TABLE_ROWS_INNER_KEYS,
  select({ docNode, parseTable }) {
    const tableNode = docNode.contentNodes.find((n) => n.type === "table");
    return {
      value: tableNode ? parseTable(tableNode) : null,
      anchorLine: tableNode?.position?.start?.line ?? undefined,
    };
  },
  validate,
  validateColumns,
  validateConfig,
};
