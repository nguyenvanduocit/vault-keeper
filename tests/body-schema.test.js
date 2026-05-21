/**
 * Tests for body schema validation (applyBodySchema + validateBodyTemplateSchema).
 * Pure tests — no I/O.
 *
 * Covers: non-repeatable required/optional sections, repeatable cardinality,
 *         heading pattern/enum matching, table columns + key/value extraction,
 *         formula evaluation (RICE-like), list item pattern, code fence lang,
 *         nested heading recursion, body meta-validation, edge cases.
 *
 * 100% generic — no domain words in assertion logic.
 */

import { describe, test, expect } from "bun:test";
import {
  PRIMITIVES,
  applyBodySchema,
  validateBodyTemplateSchema,
} from "../lib/schema-engine.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a BodySchemaNode from a compact description.
 * @param {number} depth
 * @param {string} text
 * @param {object|null} sectionRules
 * @param {object[]} children
 * @returns {object}
 */
function node(depth, text, sectionRules = null, children = []) {
  return { depth, text, sectionRules, children };
}

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — required non-repeatable sections
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — required non-repeatable", () => {
  test("required section present → no issues", () => {
    const schema = [node(2, "Overview", { required: true })];
    const body = "## Overview\n\nSome content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("required section missing → required-missing", () => {
    const schema = [node(2, "Overview", { required: true })];
    const body = "## Other Section\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
    expect(issues[0].field).toContain("Overview");
  });

  test("required section — case-insensitive matching", () => {
    const schema = [node(2, "Overview", { required: true })];
    const body = "## overview\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("optional section missing → no issues", () => {
    const schema = [node(2, "Notes", null)];
    const body = "## Something Else\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("optional section with rules, missing → no issues (not required)", () => {
    const schema = [node(2, "Notes", { table: { columns: ["a", "b"] } })];
    const body = "## Other\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("multiple required sections — all present → no issues", () => {
    const schema = [
      node(2, "Alpha", { required: true }),
      node(2, "Beta", { required: true }),
    ];
    const body = "## Alpha\n\nA content.\n\n## Beta\n\nB content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("multiple required sections — one missing → one error", () => {
    const schema = [
      node(2, "Alpha", { required: true }),
      node(2, "Beta", { required: true }),
    ];
    const body = "## Alpha\n\nA content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toContain("Beta");
  });

  test("severity override in section-rules", () => {
    const schema = [node(2, "Hints", { required: true, severity: "warning" })];
    const body = "## Other\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — conditional required (when gate) on non-repeatable sections
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — conditional required (non-repeatable)", () => {
  test("when condition true + section missing → required-missing", () => {
    const schema = [node(2, "Timeline", { required: { when: "status in ['approved', 'shipped']" } })];
    const body = "## Other\n\nContent.";
    const fm = { status: "approved" };
    const issues = applyBodySchema(schema, body, {}, fm);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
    expect(issues[0].field).toContain("Timeline");
  });

  test("when condition false + section missing → no issues", () => {
    const schema = [node(2, "Timeline", { required: { when: "status in ['approved', 'shipped']" } })];
    const body = "## Other\n\nContent.";
    const fm = { status: "draft" };
    const issues = applyBodySchema(schema, body, {}, fm);
    expect(issues).toHaveLength(0);
  });

  test("when condition true + section present → no issues", () => {
    const schema = [node(2, "Timeline", { required: { when: "status in ['approved']" } })];
    const body = "## Timeline\n\nDone by next week.";
    const fm = { status: "approved" };
    const issues = applyBodySchema(schema, body, {}, fm);
    expect(issues).toHaveLength(0);
  });

  test("unconditional required still works (no when)", () => {
    const schema = [node(2, "Overview", { required: true })];
    const body = "## Other\n\nContent.";
    const issues = applyBodySchema(schema, body, {}, {});
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("no frontmatter passed → when gate defaults to false (safe)", () => {
    const schema = [node(2, "Timeline", { required: { when: "status in ['approved']" } })];
    const body = "## Other\n\nContent.";
    // No frontmatter arg — defaults to {}
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — conditional required (when gate) on repeatable sections
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — conditional required (repeatable)", () => {
  test("when true + 0 matches → cardinality error", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "<item>", { repeatable: true, required: { when: "phase in ['active']" } }),
    ])];
    const body = "## Parent\n\nNo items.";
    const fm = { phase: "active" };
    const issues = applyBodySchema(schema, body, {}, fm);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("cardinality");
  });

  test("when false + 0 matches → no issues", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "<item>", { repeatable: true, required: { when: "phase in ['active']" } }),
    ])];
    const body = "## Parent\n\nNo items.";
    const fm = { phase: "planning" };
    const issues = applyBodySchema(schema, body, {}, fm);
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — repeatable sections
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — repeatable sections", () => {
  test("repeatable with 0 matches and no min → no issues", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "<item>", { repeatable: true }),
    ])];
    const body = "## Parent\n\nSome content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("repeatable with required: true and 0 matches → cardinality error", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "<item>", { repeatable: true, required: true }),
    ])];
    const body = "## Parent\n\nSome content but no H3s.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("cardinality");
  });

  test("repeatable with min: 2 and only 1 match → cardinality error", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "<item>", { repeatable: true, min: 2 }),
    ])];
    const body = "## Parent\n\n### Item One\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("cardinality");
    expect(issues[0].message).toContain("2");
  });

  test("repeatable with max: 2 and 3 matches → cardinality error", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "<item>", { repeatable: true, max: 2 }),
    ])];
    const body = "## Parent\n\n### A\n\n### B\n\n### C\n\n";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("cardinality");
    expect(issues[0].message).toContain("2");
  });

  test("repeatable with heading pattern — matching items pass", () => {
    const schema = [node(2, "Items", { required: true }, [
      node(3, "<item>", { repeatable: true, heading: { pattern: "^ITEM-\\d+" } }),
    ])];
    const body = "## Items\n\n### ITEM-001\n\nContent.\n\n### ITEM-002\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("repeatable with heading pattern — non-matching item → heading-mismatch", () => {
    const schema = [node(2, "Items", { required: true }, [
      node(3, "<item>", { repeatable: true, heading: { pattern: "^ITEM-\\d+" } }),
    ])];
    const body = "## Items\n\n### ITEM-001\n\nOK.\n\n### BadName\n\nFail.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("heading-mismatch");
    expect(issues[0].field).toContain("BadName");
  });

  test("repeatable cardinality + heading pattern — both checked", () => {
    const schema = [node(2, "Criteria", { required: true }, [
      node(3, "<item>", { repeatable: true, min: 1, heading: { pattern: "^CR\\d+" } }),
    ])];
    // No H3 items → cardinality error
    const body = "## Criteria\n\nSome prose.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("cardinality");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — table primitive
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — table primitive", () => {
  test("table with required columns — all present → no issues", () => {
    const schema = [node(2, "Data", { required: true, table: { columns: ["name", "value"] } })];
    const body = "## Data\n\n| Name | Value |\n|---|---|\n| a | 1 |";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("table with required columns — missing column → table-shape", () => {
    const schema = [node(2, "Data", { required: true, table: { columns: ["name", "score"] } })];
    const body = "## Data\n\n| Name | Value |\n|---|---|\n| a | 1 |";
    const issues = applyBodySchema(schema, body);
    expect(issues.some((i) => i.error_type === "table-shape")).toBe(true);
  });

  test("table expected but no table in section → table-shape", () => {
    const schema = [node(2, "Data", { required: true, table: { columns: ["a"] } })];
    const body = "## Data\n\nJust a paragraph.";
    const issues = applyBodySchema(schema, body);
    expect(issues.some((i) => i.error_type === "table-shape")).toBe(true);
  });

  test("table with no columns constraint — any table passes", () => {
    const schema = [node(2, "Info", { required: true, table: {} })];
    const body = "## Info\n\n| X |\n|---|\n| 1 |";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — table + formula (RICE-like scenario)
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — table + formula", () => {
  test("formula passes with correct values", () => {
    const schema = [node(2, "Score", {
      required: true,
      table: { key_column: "Dimension", value_column: "Value" },
      formula: "score == reach * impact * confidence / effort",
    })];
    const body = [
      "## Score",
      "",
      "| Dimension | Value |",
      "|---|---|",
      "| Reach | 8 |",
      "| Impact | 3 |",
      "| Confidence | 1 |",
      "| Effort | 4 |",
      "| Score | 6 |",
    ].join("\n");

    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("formula fails with wrong values → formula-violation", () => {
    const schema = [node(2, "Score", {
      required: true,
      table: { key_column: "Dimension", value_column: "Value" },
      formula: "total == a + b",
    })];
    const body = [
      "## Score",
      "",
      "| Dimension | Value |",
      "|---|---|",
      "| A | 10 |",
      "| B | 20 |",
      "| Total | 99 |",
    ].join("\n");

    const issues = applyBodySchema(schema, body);
    expect(issues.some((i) => i.error_type === "formula-violation")).toBe(true);
  });

  test("formula with non-numeric value → formula-violation", () => {
    const schema = [node(2, "Score", {
      required: true,
      table: { key_column: "Key", value_column: "Val" },
      formula: "x + y == z",
    })];
    const body = [
      "## Score",
      "",
      "| Key | Val |",
      "|---|---|",
      "| X | ten |",
      "| Y | 5 |",
      "| Z | 15 |",
    ].join("\n");

    const issues = applyBodySchema(schema, body);
    expect(issues.some((i) => i.error_type === "formula-violation")).toBe(true);
  });

  test("formula with epsilon tolerance (float arithmetic)", () => {
    const schema = [node(2, "Calc", {
      required: true,
      table: { key_column: "Var", value_column: "Num" },
      formula: "c == a + b",
    })];
    // 0.1 + 0.2 = 0.30000000000000004 in JS, but epsilon should handle it
    const body = [
      "## Calc",
      "",
      "| Var | Num |",
      "|---|---|",
      "| A | 0.1 |",
      "| B | 0.2 |",
      "| C | 0.3 |",
    ].join("\n");

    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("table key normalization: spaces → underscores, lowercased", () => {
    const schema = [node(2, "Metrics", {
      required: true,
      table: { key_column: "Metric Name", value_column: "Score" },
      formula: "metric_name_a + metric_name_b == total_val",
    })];
    const body = [
      "## Metrics",
      "",
      "| Metric Name | Score |",
      "|---|---|",
      "| Metric Name A | 10 |",
      "| Metric Name B | 20 |",
      "| Total Val | 30 |",
    ].join("\n");

    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — list primitive
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — list primitive", () => {
  test("list present, no item pattern → passes", () => {
    const schema = [node(2, "Tasks", { required: true, list: {} })];
    const body = "## Tasks\n\n- Task 1\n- Task 2";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("list missing → list-item error", () => {
    const schema = [node(2, "Tasks", { required: true, list: {} })];
    const body = "## Tasks\n\nJust prose.";
    const issues = applyBodySchema(schema, body);
    expect(issues.some((i) => i.error_type === "list-item")).toBe(true);
  });

  test("list with item pattern — all match → pass", () => {
    const schema = [node(2, "Steps", { required: true, list: { item: { pattern: "^Step \\d+" } } })];
    const body = "## Steps\n\n- Step 1 do this\n- Step 2 do that";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("list with item pattern — non-matching item → list-item error", () => {
    const schema = [node(2, "Steps", { required: true, list: { item: { pattern: "^Step \\d+" } } })];
    const body = "## Steps\n\n- Step 1 ok\n- Bad item";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("list-item");
    expect(issues[0].message).toContain("Bad item");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — code primitive
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — code primitive", () => {
  test("code fence with correct lang → pass", () => {
    const schema = [node(2, "Spec", { required: true, code: { lang: "gherkin" } })];
    const body = "## Spec\n\n```gherkin\nGiven something\n```";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("code fence with wrong lang → code-missing", () => {
    const schema = [node(2, "Spec", { required: true, code: { lang: "gherkin" } })];
    const body = "## Spec\n\n```yaml\nkey: val\n```";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("code-missing");
  });

  test("code fence expected but no fence → code-missing", () => {
    const schema = [node(2, "Spec", { required: true, code: { lang: "yaml" } })];
    const body = "## Spec\n\nJust text.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("code-missing");
  });

  test("code fence with no lang constraint — any fence passes", () => {
    const schema = [node(2, "Code", { required: true, code: {} })];
    const body = "## Code\n\n```\nsome code\n```";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("code lang matching is case-insensitive", () => {
    const schema = [node(2, "Block", { required: true, code: { lang: "YAML" } })];
    const body = "## Block\n\n```yaml\nk: v\n```";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — nested heading recursion
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — nested recursion", () => {
  test("H2 > required H3 — H3 present → no issues", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "Child", { required: true }),
    ])];
    const body = "## Parent\n\n### Child\n\nChild content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("H2 > required H3 — H3 missing → required-missing", () => {
    const schema = [node(2, "Parent", { required: true }, [
      node(3, "Child", { required: true }),
    ])];
    const body = "## Parent\n\nJust parent content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
    expect(issues[0].field).toContain("Child");
    expect(issues[0].field).toContain("Parent");
  });

  test("H2 > H3 > H4 — deep nesting validates correctly", () => {
    const schema = [node(2, "A", { required: true }, [
      node(3, "B", { required: true }, [
        node(4, "C", { required: true }),
      ]),
    ])];
    const body = "## A\n\n### B\n\n#### C\n\nDeep content.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("nested repeatable under non-repeatable", () => {
    const schema = [node(2, "Container", { required: true }, [
      node(3, "<entry>", { repeatable: true, min: 1, heading: { pattern: "^E\\d+" } }),
    ])];
    const body = "## Container\n\n### E1\n\nFirst.\n\n### E2\n\nSecond.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("issue field carries full heading path", () => {
    const schema = [node(2, "Section", { required: true }, [
      node(3, "Sub", { required: true }),
    ])];
    const body = "## Section\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("## Section › ### Sub");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("applyBodySchema — edge cases", () => {
  test("empty schema → no issues", () => {
    const issues = applyBodySchema([], "## Anything\n\nContent.");
    expect(issues).toHaveLength(0);
  });

  test("null schema → no issues", () => {
    const issues = applyBodySchema(null, "## Content\n\nBody.");
    expect(issues).toHaveLength(0);
  });

  test("empty body against required section → required-missing", () => {
    const schema = [node(2, "Required", { required: true })];
    const issues = applyBodySchema(schema, "");
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("null body → required-missing for required sections", () => {
    const schema = [node(2, "Required", { required: true })];
    const issues = applyBodySchema(schema, null);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("schema node without sectionRules → section match attempted, no content validation", () => {
    const schema = [node(2, "Present", null)];
    const body = "## Present\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(0);
  });

  test("body line is present on heading-mismatch issues", () => {
    const schema = [node(2, "Group", { required: true }, [
      node(3, "<item>", { repeatable: true, heading: { pattern: "^X-\\d+" } }),
    ])];
    const body = "## Group\n\n### BadHeading\n\nContent.";
    const issues = applyBodySchema(schema, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].bodyLine).toBeDefined();
    expect(typeof issues[0].bodyLine).toBe("number");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Structural primitives — direct unit tests
// ────────────────────────────────────────────────────────────────────────────

describe("structural primitives — direct", () => {
  test("heading primitive — pattern pass", () => {
    const issues = PRIMITIVES.heading("AC01 — Test", { pattern: "^AC\\d+" }, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("heading primitive — pattern fail", () => {
    const issues = PRIMITIVES.heading("BadText", { pattern: "^AC\\d+" }, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("heading-mismatch");
  });

  test("heading primitive — enum pass", () => {
    const issues = PRIMITIVES.heading("Alpha", { enum: ["Alpha", "Beta"] }, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("heading primitive — enum fail", () => {
    const issues = PRIMITIVES.heading("Gamma", { enum: ["Alpha", "Beta"] }, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("heading-mismatch");
  });

  test("heading primitive — enum case-insensitive", () => {
    const issues = PRIMITIVES.heading("alpha", { enum: ["Alpha"] }, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("table primitive — null value → table-shape", () => {
    const issues = PRIMITIVES.table(null, { columns: ["a"] }, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("table-shape");
  });

  test("table primitive — valid table with correct columns → pass", () => {
    const table = { headers: ["name", "value"], rows: [["a", "1"]] };
    const issues = PRIMITIVES.table(table, { columns: ["name", "value"] }, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("table primitive — missing column → table-shape", () => {
    const table = { headers: ["name"], rows: [["a"]] };
    const issues = PRIMITIVES.table(table, { columns: ["name", "score"] }, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("table-shape");
  });

  test("list primitive — null value → list-item", () => {
    const issues = PRIMITIVES.list(null, {}, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("list-item");
  });

  test("list primitive — items matching pattern → pass", () => {
    const list = { items: [{ text: "Step 1", line: 1 }, { text: "Step 2", line: 2 }] };
    const issues = PRIMITIVES.list(list, { item: { pattern: "^Step \\d+" } }, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("code primitive — matching lang → pass", () => {
    const fences = [{ lang: "yaml", value: "k: v", line: 1 }];
    const issues = PRIMITIVES.code(fences, { lang: "yaml" }, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("code primitive — wrong lang → code-missing", () => {
    const fences = [{ lang: "js", value: "code", line: 1 }];
    const issues = PRIMITIVES.code(fences, { lang: "yaml" }, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("code-missing");
  });

  test("code primitive — empty fences → code-missing", () => {
    const issues = PRIMITIVES.code([], {}, { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("code-missing");
  });

  test("repeatable primitive — marker only, always empty", () => {
    const issues = PRIMITIVES.repeatable(null, true, { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("formula primitive — correct → pass", () => {
    const issues = PRIMITIVES.formula({ a: 3, b: 4, c: 7 }, "c == a + b", { field: "test" });
    expect(issues).toHaveLength(0);
  });

  test("formula primitive — incorrect → formula-violation", () => {
    const issues = PRIMITIVES.formula({ a: 3, b: 4, c: 99 }, "c == a + b", { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("formula-violation");
  });

  test("formula primitive — missing identifier → formula-violation", () => {
    const issues = PRIMITIVES.formula({ a: 3 }, "a + b == 7", { field: "test" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("formula-violation");
  });

  test("formula primitive — severity/message override", () => {
    const issues = PRIMITIVES.formula(
      { a: 1, b: 1, c: 99 },
      "c == a + b",
      { field: "test", severity: "warning", message: "Custom msg" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].message).toBe("Custom msg");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateBodyTemplateSchema — meta-validation
// ════════════════════════════════════════════════════════════════════════════

describe("validateBodyTemplateSchema", () => {
  test("valid schema → no issues", () => {
    const schema = [
      node(2, "Overview", { required: true }),
      node(2, "Items", { required: true }, [
        node(3, "<item>", { repeatable: true, min: 1, heading: { pattern: "^IT-\\d+" } }),
      ]),
      node(2, "Data", { table: { columns: ["a", "b"], key_column: "a", value_column: "b" }, formula: "x + y == z" }),
    ];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues).toHaveLength(0);
  });

  test("unknown section-rules key → template-schema-invalid", () => {
    const schema = [node(2, "Section", { required: true, foobar: true })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("foobar"))).toBe(true);
  });

  test("invalid heading pattern regex → template-schema-invalid", () => {
    const schema = [node(2, "Section", { heading: { pattern: "[invalid(" } })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("regex"))).toBe(true);
  });

  test("heading enum not an array → template-schema-invalid", () => {
    const schema = [node(2, "Section", { heading: { enum: "not-array" } })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("enum"))).toBe(true);
  });

  test("heading enum empty array → template-schema-invalid", () => {
    const schema = [node(2, "Section", { heading: { enum: [] } })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid")).toBe(true);
  });

  test("table not an object → template-schema-invalid", () => {
    const schema = [node(2, "Section", { table: "string" })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("table"))).toBe(true);
  });

  test("list not an object → template-schema-invalid", () => {
    const schema = [node(2, "Section", { list: 42 })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("list"))).toBe(true);
  });

  test("list.item.pattern invalid regex → template-schema-invalid", () => {
    const schema = [node(2, "Section", { list: { item: { pattern: "[bad(" } } })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("regex"))).toBe(true);
  });

  test("code not an object → template-schema-invalid", () => {
    const schema = [node(2, "Section", { code: true })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("code"))).toBe(true);
  });

  test("formula not a string → template-schema-invalid", () => {
    const schema = [node(2, "Section", { formula: 42 })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("formula"))).toBe(true);
  });

  test("formula with invalid expression → template-schema-invalid", () => {
    const schema = [node(2, "Section", { formula: "a ++ b" })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("formula"))).toBe(true);
  });

  test("min not a number → template-schema-invalid", () => {
    const schema = [node(2, "Section", { repeatable: true, min: "two" })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("min"))).toBe(true);
  });

  test("max not a number → template-schema-invalid", () => {
    const schema = [node(2, "Section", { repeatable: true, max: "five" })];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.message.includes("max"))).toBe(true);
  });

  test("null schema → no issues (graceful)", () => {
    expect(validateBodyTemplateSchema(null)).toHaveLength(0);
  });

  test("never throws — always returns issues array", () => {
    expect(() => validateBodyTemplateSchema(undefined)).not.toThrow();
    expect(() => validateBodyTemplateSchema(42)).not.toThrow();
    expect(() => validateBodyTemplateSchema([{ depth: 2, text: "X", sectionRules: { formula: "[(" }, children: [] }])).not.toThrow();
  });

  test("nested schema validation — deep issues reported", () => {
    const schema = [node(2, "Outer", null, [
      node(3, "Inner", { formula: "++" }),
    ])];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.error_type === "template-schema-invalid" && i.field.includes("Inner"))).toBe(true);
  });

  test("issue field carries heading path", () => {
    const schema = [node(2, "Parent", null, [
      node(3, "Child", { foobar: true }),
    ])];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("## Parent › ### Child");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Zero domain-word branching — structural assertions
// ────────────────────────────────────────────────────────────────────────────

describe("zero domain-word branching", () => {
  test("PRIMITIVES registry contains exactly the expected keys", () => {
    const keys = Object.keys(PRIMITIVES).sort();
    const expected = [
      "after", "before", "code", "description", "enum", "exists",
      "formula", "heading", "list", "max", "min", "pattern",
      "repeatable", "required", "table", "type", "uniqueItems",
    ].sort();
    expect(keys).toEqual(expected);
  });

  test("all structural primitives are functions", () => {
    for (const name of ["heading", "table", "list", "code", "repeatable", "formula"]) {
      expect(typeof PRIMITIVES[name]).toBe("function");
    }
  });
});
