/**
 * Tests for the redesigned `table` primitive:
 *  - shorthand `columns: [string]` (backward compat: required column)
 *  - expanded `columns: [{ name, required?, values? }]`
 *  - per-column `values:` constraints (required, pattern, enum, unique,
 *    type, min, max) in the documented evaluation order
 *  - table-level `rows: { min, max }` cardinality
 *  - table-level `strict: true` rejecting undeclared columns
 *  - inner-key meta-validation: unknown nested keys produce a fuzzy
 *    suggestion (`coluns` → `columns`, `vlues` → `values`, etc.)
 *  - mixed-shape `columns:` arrays are rejected by meta-validation
 *  - `key_column` / `value_column` are no longer recognised
 */

import { describe, test, expect } from "bun:test";
import {
  applyBodySchema,
  validateBodyTemplateSchema,
} from "../lib/schema-engine.js";

const errs = (issues) => issues.filter((i) => i.level === "error");

function schemaWithTable(rules) {
  return [{
    depth: 2,
    text: "Data",
    sectionRules: { table: rules },
    children: [],
  }];
}

const TABLE_NAME_ROLE_STATUS = [
  "## Data",
  "",
  "| Name | Role | Status |",
  "|---|---|---|",
  "| alice | author | done |",
  "| bob   | reviewer | doing |",
  "| carol | author | todo |",
  "",
].join("\n");

describe("table primitive — shorthand columns", () => {
  test("required header missing → table-shape", () => {
    const issues = errs(applyBodySchema(
      schemaWithTable({ columns: ["name", "role", "missing_col"] }),
      TABLE_NAME_ROLE_STATUS,
    ));
    expect(issues.some((i) => i.message.includes("missing_col"))).toBe(true);
  });

  test("all required headers present → pass", () => {
    expect(errs(applyBodySchema(
      schemaWithTable({ columns: ["name", "role", "status"] }),
      TABLE_NAME_ROLE_STATUS,
    ))).toHaveLength(0);
  });
});

describe("table primitive — per-column values constraints", () => {
  test("values.required flags an empty cell", () => {
    const body = [
      "## Data",
      "",
      "| Name | Role |",
      "|---|---|",
      "| alice |  |",
      "| bob   | reviewer |",
      "",
    ].join("\n");
    const issues = errs(applyBodySchema(
      schemaWithTable({ columns: [{ name: "Name", required: true }, { name: "Role", required: true, values: { required: true } }] }),
      body,
    ));
    expect(issues.some((i) => i.message.includes("empty"))).toBe(true);
  });

  test("values.enum rejects out-of-set cell", () => {
    const issues = errs(applyBodySchema(
      schemaWithTable({
        columns: [
          { name: "name", required: true },
          { name: "status", required: true, values: { enum: ["done", "doing"] } },
        ],
      }),
      TABLE_NAME_ROLE_STATUS, // contains "todo" not in enum
    ));
    expect(issues.some((i) => i.message.includes("todo"))).toBe(true);
  });

  test("values.unique flags duplicate cell across rows", () => {
    const issues = errs(applyBodySchema(
      schemaWithTable({
        columns: [
          { name: "name", required: true },
          { name: "role", required: true, values: { unique: true } },
        ],
      }),
      TABLE_NAME_ROLE_STATUS, // role "author" repeats (alice, carol)
    ));
    expect(issues.some((i) => i.message.includes("author"))).toBe(true);
  });

  test("values.pattern + values.type can combine", () => {
    const body = [
      "## Data",
      "",
      "| name | count |",
      "|---|---|",
      "| alice | 5  |",
      "| bob   | NaN |",
      "",
    ].join("\n");
    const issues = errs(applyBodySchema(
      schemaWithTable({
        columns: [
          { name: "name", required: true },
          { name: "count", required: true, values: { type: "integer" } },
        ],
      }),
      body,
    ));
    expect(issues.some((i) => i.message.includes("NaN"))).toBe(true);
  });
});

describe("table primitive — rows cardinality", () => {
  test("rows.min: 5 fires on 3-row table", () => {
    const issues = errs(applyBodySchema(
      schemaWithTable({ columns: ["name", "role", "status"], rows: { min: 5 } }),
      TABLE_NAME_ROLE_STATUS,
    ));
    expect(issues.some((i) => i.message.includes("at least 5"))).toBe(true);
  });

  test("rows.max: 2 fires on 3-row table", () => {
    const issues = errs(applyBodySchema(
      schemaWithTable({ columns: ["name", "role", "status"], rows: { max: 2 } }),
      TABLE_NAME_ROLE_STATUS,
    ));
    expect(issues.some((i) => i.message.includes("at most 2"))).toBe(true);
  });
});

describe("table primitive — strict mode", () => {
  test("strict: true rejects an undeclared header", () => {
    const issues = errs(applyBodySchema(
      schemaWithTable({ columns: ["name", "role"], strict: true }),
      TABLE_NAME_ROLE_STATUS, // also has "status"
    ));
    expect(issues.some((i) => i.message.includes("undeclared column 'status'"))).toBe(true);
  });

  test("strict: false (default) keeps undeclared headers silent", () => {
    expect(errs(applyBodySchema(
      schemaWithTable({ columns: ["name", "role"] }),
      TABLE_NAME_ROLE_STATUS,
    ))).toHaveLength(0);
  });
});

describe("table primitive — meta-validation rejects bad shape", () => {
  const node = (rules) => ({ depth: 2, text: "Data", sectionRules: rules, children: [] });

  test("unknown table-level key → fuzzy 'columns'", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { coluns: ["a"] } }),
    ]);
    const bad = issues.find((i) => i.message.includes("Unknown key 'coluns' in 'table'"));
    expect(bad.message).toContain("Did you mean 'columns'?");
  });

  test("legacy key_column → unknown-key (no fuzzy because no close match)", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { columns: ["a"], key_column: "a" } }),
    ]);
    expect(issues.some((i) => i.message.includes("Unknown key 'key_column'"))).toBe(true);
  });

  test("mixed array (string + object) → mixes-form error", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { columns: ["a", { name: "b", values: { type: "string" } }] } }),
    ]);
    expect(issues.some((i) => i.message.includes("mixes string shorthand and object form"))).toBe(true);
  });

  test("unknown values key → fuzzy 'pattern'", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { columns: [{ name: "x", values: { patern: "^x" } }] } }),
    ]);
    const bad = issues.find((i) => i.message.includes("Unknown key 'patern' in 'table.columns[0].values'"));
    expect(bad.message).toContain("Did you mean 'pattern'?");
  });

  test("invalid type on values → fuzzy on type", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { columns: [{ name: "x", values: { type: "strring" } }] } }),
    ]);
    const bad = issues.find((i) => i.message.includes("Invalid type 'strring'"));
    expect(bad.message).toContain("Did you mean 'string'?");
  });

  test("invalid regex in values.pattern → template-schema-invalid", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { columns: [{ name: "x", values: { pattern: "[bad(" } }] } }),
    ]);
    expect(issues.some((i) => i.message.includes("Invalid regex"))).toBe(true);
  });

  test("rows is not an object → unknown-key under table.rows", () => {
    const issues = validateBodyTemplateSchema([
      node({ table: { columns: ["a"], rows: { mn: 1 } } }),
    ]);
    const bad = issues.find((i) => i.message.includes("Unknown key 'mn' in 'table.rows'"));
    expect(bad.message).toContain("Did you mean 'min'?");
  });
});
