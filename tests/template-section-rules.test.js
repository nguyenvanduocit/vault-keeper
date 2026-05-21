/**
 * Tests for template-section-rules.js — Phase 3a (LOADER layer).
 *
 * Coverage:
 *   parseBodySchema():
 *     - empty/null/whitespace body → []
 *     - heading without section-rules → sectionRules: null
 *     - heading with valid section-rules → parsed SectionRules
 *     - multiple headings with rules
 *     - nested headings (H2 → H3) → children tree
 *     - invalid YAML in code block → sectionRules: null (silent skip)
 *     - wrong code block lang → sectionRules: null
 *     - wrong code block meta → sectionRules: null
 *     - only first section-rules block per heading is used
 *     - all value types: string, array, boolean, number, object
 *     - deeply nested heading tree (H2 → H3 → H4)
 *     - repeatable + heading pattern in section-rules
 *
 *   findSectionRuleBlocks():
 *     - preserved exactly from previous implementation
 */

import { describe, test, expect } from "bun:test";
import {
  parseBodySchema,
  findSectionRuleBlocks,
} from "../lib/template-section-rules.js";

// ────────────────────────────────────────────────────────────────────────────
// parseBodySchema — empty / null / whitespace
// ────────────────────────────────────────────────────────────────────────────

describe("parseBodySchema — empty/null cases", () => {
  test("null → empty array", () => {
    expect(parseBodySchema(null)).toEqual([]);
  });

  test("undefined → empty array", () => {
    expect(parseBodySchema(undefined)).toEqual([]);
  });

  test("empty string → empty array", () => {
    expect(parseBodySchema("")).toEqual([]);
  });

  test("non-string input → empty array", () => {
    expect(parseBodySchema(42)).toEqual([]);
    expect(parseBodySchema({})).toEqual([]);
  });

  test("whitespace-only body → empty array (no headings)", () => {
    expect(parseBodySchema("   \n\n  ")).toEqual([]);
  });

  test("body with only prose (no headings) → empty array", () => {
    expect(parseBodySchema("Just some text.\n\nAnother paragraph.\n")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseBodySchema — heading without section-rules
// ────────────────────────────────────────────────────────────────────────────

describe("parseBodySchema — headings without section-rules", () => {
  test("single H2 with no code block → sectionRules: null", () => {
    const body = "## My Section\n\nSome content.\n";
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      depth: 2,
      text: "My Section",
      sectionRules: null,
      children: [],
    });
  });

  test("heading with non-section-rules code block → sectionRules: null", () => {
    const body = [
      "## Code Example",
      "",
      "```javascript",
      "console.log('hello');",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].sectionRules).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseBodySchema — valid section-rules extraction
// ────────────────────────────────────────────────────────────────────────────

describe("parseBodySchema — section-rules extraction", () => {
  test("H2 with valid section-rules → parsed SectionRules object", () => {
    const body = [
      "## Criteria",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(2);
    expect(result[0].text).toBe("Criteria");
    expect(result[0].sectionRules).toEqual({ required: true });
    expect(result[0].children).toEqual([]);
  });

  test("multiple headings with section-rules", () => {
    const body = [
      "## First",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "## Second",
      "",
      "```yaml section-rules",
      "required: false",
      "table:",
      "  columns: [Name, Value]",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("First");
    expect(result[0].sectionRules).toEqual({ required: true });
    expect(result[1].text).toBe("Second");
    expect(result[1].sectionRules).toEqual({
      required: false,
      table: { columns: ["Name", "Value"] },
    });
  });

  test("section-rules with all value types", () => {
    const body = [
      "## Complex",
      "",
      "```yaml section-rules",
      "required: true",
      "repeatable: false",
      "min: 1",
      "max: 10",
      "severity: warning",
      "message: custom message here",
      "heading:",
      '  pattern: "^AC\\\\d+"',
      "table:",
      "  columns: [A, B, C]",
      "  rows:",
      "    min: 1",
      "  strict: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    const rules = result[0].sectionRules;
    expect(rules.required).toBe(true);
    expect(rules.repeatable).toBe(false);
    expect(rules.min).toBe(1);
    expect(rules.max).toBe(10);
    expect(rules.severity).toBe("warning");
    expect(rules.message).toBe("custom message here");
    expect(rules.heading).toEqual({ pattern: "^AC\\d+" });
    expect(rules.table).toEqual({ columns: ["A", "B", "C"], rows: { min: 1 }, strict: true });
  });

  test("repeatable + heading pattern", () => {
    const body = [
      "## Items",
      "",
      "### Item Template",
      "",
      "```yaml section-rules",
      "repeatable: true",
      "heading:",
      '  pattern: "^IT-\\\\d{3}"',
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Items");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].text).toBe("Item Template");
    expect(result[0].children[0].sectionRules).toEqual({
      repeatable: true,
      heading: { pattern: "^IT-\\d{3}" },
    });
  });

  test("formula in section-rules (operates on frontmatter values only)", () => {
    const body = [
      "## Score",
      "",
      "```yaml section-rules",
      "required: true",
      'formula: "score == a * b / c"',
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result[0].sectionRules.formula).toBe("score == a * b / c");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseBodySchema — nested heading tree
// ────────────────────────────────────────────────────────────────────────────

describe("parseBodySchema — nested heading tree", () => {
  test("H2 → H3 nesting produces children tree", () => {
    const body = [
      "## Parent",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "### Child A",
      "",
      "```yaml section-rules",
      "repeatable: true",
      "```",
      "",
      "### Child B",
      "",
      "Some prose.",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Parent");
    expect(result[0].sectionRules).toEqual({ required: true });
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].text).toBe("Child A");
    expect(result[0].children[0].sectionRules).toEqual({ repeatable: true });
    expect(result[0].children[0].children).toEqual([]);
    expect(result[0].children[1].text).toBe("Child B");
    expect(result[0].children[1].sectionRules).toBeNull();
  });

  test("deep nesting: H2 → H3 → H4", () => {
    const body = [
      "## Level 2",
      "",
      "### Level 3",
      "",
      "#### Level 4",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(2);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].depth).toBe(3);
    expect(result[0].children[0].children).toHaveLength(1);
    expect(result[0].children[0].children[0].depth).toBe(4);
    expect(result[0].children[0].children[0].sectionRules).toEqual({ required: true });
  });

  test("multiple H2 siblings with mixed H3 children", () => {
    const body = [
      "## Alpha",
      "",
      "### A1",
      "",
      "### A2",
      "",
      "## Beta",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Alpha");
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].text).toBe("A1");
    expect(result[0].children[1].text).toBe("A2");
    expect(result[1].text).toBe("Beta");
    expect(result[1].sectionRules).toEqual({ required: true });
    expect(result[1].children).toEqual([]);
  });

  test("H1 heading is included in tree", () => {
    const body = [
      "# Top Level",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].depth).toBe(1);
    expect(result[0].text).toBe("Top Level");
    expect(result[0].sectionRules).toEqual({ required: true });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseBodySchema — error cases / edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("parseBodySchema — error handling", () => {
  test("invalid YAML in section-rules → sectionRules: null (silent skip)", () => {
    const body = [
      "## Bad YAML",
      "",
      "```yaml section-rules",
      "broken: [unclosed",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("Bad YAML");
    expect(result[0].sectionRules).toBeNull();
  });

  test("wrong lang (json section-rules) → sectionRules: null", () => {
    const body = [
      "## Wrong Lang",
      "",
      "```json section-rules",
      '{"required": true}',
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].sectionRules).toBeNull();
  });

  test("wrong meta (yaml section-rule singular) → sectionRules: null", () => {
    const body = [
      "## Wrong Meta",
      "",
      "```yaml section-rule",
      "required: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].sectionRules).toBeNull();
  });

  test("yaml fence without meta → sectionRules: null", () => {
    const body = [
      "## Plain YAML",
      "",
      "```yaml",
      "required: true",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].sectionRules).toBeNull();
  });

  test("only first section-rules block per heading is used", () => {
    const body = [
      "## Multi Block",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "```yaml section-rules",
      "required: false",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    // Only the first block is used.
    expect(result[0].sectionRules).toEqual({ required: true });
  });

  test("empty section-rules block → sectionRules: null", () => {
    const body = [
      "## Empty Rules",
      "",
      "```yaml section-rules",
      "",
      "```",
    ].join("\n");
    const result = parseBodySchema(body);
    expect(result).toHaveLength(1);
    expect(result[0].sectionRules).toBeNull();
  });

  test("heading text is preserved verbatim (not snake_cased)", () => {
    const body = "## Acceptance Criteria\n\nContent.\n";
    const result = parseBodySchema(body);
    expect(result[0].text).toBe("Acceptance Criteria");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findSectionRuleBlocks — preserved exactly from previous implementation
// ────────────────────────────────────────────────────────────────────────────

describe("findSectionRuleBlocks", () => {
  test("null / undefined / empty body → empty array", () => {
    expect(findSectionRuleBlocks(null)).toEqual([]);
    expect(findSectionRuleBlocks(undefined)).toEqual([]);
    expect(findSectionRuleBlocks("")).toEqual([]);
  });

  test("body with no code blocks → empty array", () => {
    expect(findSectionRuleBlocks("# Title\n\nSome prose.\n")).toEqual([]);
  });

  test("single `yaml section-rules` fence → one block with its line", () => {
    const body = [
      "## Acceptance Criteria", // line 1
      "", // line 2
      "```yaml section-rules", // line 3
      "required: true", // line 4
      "```", // line 5
    ].join("\n");
    expect(findSectionRuleBlocks(body)).toEqual([{ line: 3 }]);
  });

  test("multiple fences → one entry per block, in document order", () => {
    const body = [
      "```yaml section-rules", // line 1
      "required: true",
      "```",
      "",
      "## Later", // line 5
      "",
      "```yaml section-rules", // line 7
      "required: false",
      "```",
    ].join("\n");
    expect(findSectionRuleBlocks(body)).toEqual([{ line: 1 }, { line: 7 }]);
  });

  test("plain `yaml` fence with no meta → not matched", () => {
    const body = ["```yaml", "required: true", "```"].join("\n");
    expect(findSectionRuleBlocks(body)).toEqual([]);
  });

  test("wrong lang (`json section-rules`) → not matched", () => {
    const body = ['```json section-rules', '{"required": true}', "```"].join(
      "\n",
    );
    expect(findSectionRuleBlocks(body)).toEqual([]);
  });

  test("near-miss meta (`section-rule`, extra word) → not matched", () => {
    const singular = ["```yaml section-rule", "required: true", "```"].join(
      "\n",
    );
    const extra = ["```yaml section-rules extra", "x: 1", "```"].join("\n");
    expect(findSectionRuleBlocks(singular)).toEqual([]);
    expect(findSectionRuleBlocks(extra)).toEqual([]);
  });

  test("fence nested inside a list item → still detected", () => {
    const body = [
      "- a list item", // line 1
      "", // line 2
      "  ```yaml section-rules", // line 3
      "  required: true",
      "  ```",
    ].join("\n");
    expect(findSectionRuleBlocks(body)).toEqual([{ line: 3 }]);
  });

  test("section-rules shown INSIDE an outer fence → not a real block", () => {
    // A document that documents the construct wraps it in an outer `~~~`
    // fence. remark parses the outer block as one code node; the inner
    // ```yaml section-rules is plain text, not its own node.
    const body = [
      "Here is how a template declares rules:",
      "",
      "~~~markdown",
      "```yaml section-rules",
      "required: true",
      "```",
      "~~~",
    ].join("\n");
    expect(findSectionRuleBlocks(body)).toEqual([]);
  });
});
