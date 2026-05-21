/**
 * Tests for the `formula` section-rule after the table-data extraction was
 * removed in feat(table)!. Formula now reads from frontmatter — references
 * inside the expression map directly to frontmatter keys.
 *
 * This is the documented migration path for vaults that used to declare a
 * `key_column` / `value_column` table-formula pair: lift the dimensions
 * to frontmatter and the formula reads them straight off.
 */

import { describe, test, expect } from "bun:test";
import { applyBodySchema } from "../lib/schema-engine.js";

const errs = (issues) => issues.filter((i) => i.level === "error");

function schemaWithFormula(expr) {
  return [{
    depth: 2,
    text: "Score",
    sectionRules: { formula: expr },
    children: [],
  }];
}

const SCORE_SECTION = "## Score\n\nThe RICE score derived from frontmatter.\n";

describe("formula on frontmatter", () => {
  test("passes when expression holds against frontmatter values", async () => {
    const issues = await applyBodySchema(
      schemaWithFormula("reach * impact * confidence / effort >= 5"),
      SCORE_SECTION,
      undefined,
      { reach: 8, impact: 3, confidence: 1, effort: 4 },
    );
    expect(errs(issues)).toHaveLength(0);
  });

  test("fires formula-violation when expression evaluates false", async () => {
    const issues = await applyBodySchema(
      schemaWithFormula("a + b == 10"),
      SCORE_SECTION,
      undefined,
      { a: 1, b: 2 },
    );
    expect(errs(issues).some((i) => i.error_type === "formula-violation")).toBe(true);
  });

  test("fires formula-violation when a referenced field is missing", async () => {
    const issues = await applyBodySchema(
      schemaWithFormula("score >= 5"),
      SCORE_SECTION,
      undefined,
      {}, // no score
    );
    expect(errs(issues).some((i) => i.error_type === "formula-violation")).toBe(true);
  });

  test("anchors formula-violation at the section heading line", async () => {
    const issues = await applyBodySchema(
      schemaWithFormula("score == 0"),
      SCORE_SECTION,
      undefined,
      { score: 5 },
    );
    const violation = errs(issues).find((i) => i.error_type === "formula-violation");
    expect(typeof violation.bodyLine).toBe("number");
  });
});
