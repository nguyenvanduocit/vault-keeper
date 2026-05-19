/**
 * Tests for template-section-rules.js.
 *
 * Coverage:
 *   parseSectionRules():
 *     - empty/null/whitespace body
 *     - H2 without section-rules code block
 *     - H2 with valid section-rules → parsed
 *     - multiple sections with rules
 *     - heading → snake_case normalization
 *     - invalid YAML in code block → skip silently
 *     - wrong code block lang → skip
 *     - wrong code block meta → skip
 *     - only first section-rules block per section is used
 *     - all value types: string, array, boolean, number
 *     - real PRD-shape fixture
 *     - nested/deep YAML values
 *     - section-rules not immediately after heading (other content between)
 *
 *   getRequiredSections():
 *     - empty rules → empty array
 *     - all required → all returned
 *     - mixed required/optional → only required
 *     - missing required field → treated as not required
 *     - heading case reconstruction from snake_case
 *
 *   loadTemplateSectionRules():
 *     - valid file → parsed
 *     - missing file → empty
 *     - null/empty path → empty
 *     - file with frontmatter + body → parses body only
 *     - file with no section-rules → empty
 *
 *   body-parser formatHints integration:
 *     - AC priorities from hints
 *     - AC statuses from hints
 *     - table headers from hints
 *     - format/example in warning messages
 *     - no hints → built-in defaults
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  parseSectionRules,
  getRequiredSections,
  loadTemplateSectionRules,
} from "../lib/template-section-rules.js";
import { parseBody } from "../lib/body-parser.js";

let SANDBOX;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "section-rules-"));
});

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const abs = join(SANDBOX, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

// ────────────────────────────────────────────────────────────────────────────
// parseSectionRules — empty/null cases
// ────────────────────────────────────────────────────────────────────────────

describe("parseSectionRules — empty cases", () => {
  test("null body → empty object", () => {
    expect(parseSectionRules(null)).toEqual({});
  });

  test("undefined body → empty object", () => {
    expect(parseSectionRules(undefined)).toEqual({});
  });

  test("empty string → empty object", () => {
    expect(parseSectionRules("")).toEqual({});
  });

  test("whitespace-only body → empty object", () => {
    expect(parseSectionRules("   \n\n  ")).toEqual({});
  });

  test("body with no H2 headings → empty object", () => {
    expect(parseSectionRules("# Title\n\nSome paragraph.\n")).toEqual({});
  });

  test("body with H2 but no section-rules → empty object", () => {
    const md = `## Relationships\n\n- **foo** → [bar](baz.md)\n`;
    expect(parseSectionRules(md)).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseSectionRules — valid extraction
// ────────────────────────────────────────────────────────────────────────────

describe("parseSectionRules — valid extraction", () => {
  test("single section with section-rules → parsed", () => {
    const md = [
      "## Relationships",
      "",
      "```yaml section-rules",
      "required: true",
      'format: "- **<pred>** → [<title>](<path>)"',
      "```",
      "",
      "- **foo** → [bar](baz.md)",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(result.relationships).toBeDefined();
    expect(result.relationships.required).toBe(true);
    expect(result.relationships.format).toBe(
      "- **<pred>** → [<title>](<path>)"
    );
  });

  test("multiple sections with rules → all parsed", () => {
    const md = [
      "## Relationships",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "## Status History",
      "",
      "```yaml section-rules",
      "required: false",
      "type: table",
      'headers: ["at", "from", "to"]',
      "```",
      "",
      "## Contributions",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result.relationships.required).toBe(true);
    expect(result.status_history.required).toBe(false);
    expect(result.status_history.type).toBe("table");
    expect(result.status_history.headers).toEqual(["at", "from", "to"]);
    expect(result.contributions.required).toBe(true);
  });

  test("heading normalization → snake_case", () => {
    const md = [
      "## Acceptance Criteria",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "## RICE Score",
      "",
      "```yaml section-rules",
      "required: false",
      "```",
      "",
      "## Success Metric Verdict",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(result.acceptance_criteria).toBeDefined();
    expect(result.rice_score).toBeDefined();
    expect(result.success_metric_verdict).toBeDefined();
  });

  test("all value types: string, array, boolean, number", () => {
    const md = [
      "## Test Section",
      "",
      "```yaml section-rules",
      "required: true",
      'format: "some format"',
      "count: 42",
      "ratio: 3.14",
      "items: [a, b, c]",
      'nested_items: ["x", "y"]',
      "```",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(result.test_section.required).toBe(true);
    expect(result.test_section.format).toBe("some format");
    expect(result.test_section.count).toBe(42);
    expect(result.test_section.ratio).toBe(3.14);
    expect(result.test_section.items).toEqual(["a", "b", "c"]);
    expect(result.test_section.nested_items).toEqual(["x", "y"]);
  });

  test("section-rules not immediately after heading (other content between)", () => {
    const md = [
      "## Relationships",
      "",
      "Some introductory paragraph.",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "- **foo** → [bar](baz.md)",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(result.relationships).toBeDefined();
    expect(result.relationships.required).toBe(true);
  });

  test("real PRD-shape fixture", () => {
    const md = [
      "## User Stories",
      "",
      "```yaml section-rules",
      "required: false",
      'format: "- [<title>](<path>) [— *<reason>*]"',
      'example: "- [User Login](./stories/login.md)"',
      "```",
      "",
      "## Acceptance Criteria",
      "",
      "```yaml section-rules",
      "required: false",
      'heading_format: "### AC<n>[.<m>] — <text> — `<priority>` · `<status>` [(flag)]"',
      'heading_example: "### AC1 — User can login — `must` · `draft`"',
      "valid_priorities: [must, should, nice]",
      "valid_statuses: [draft, implementing, verified, descoped]",
      "```",
      "",
      "## Status History",
      "",
      '```yaml section-rules',
      "required: true",
      "type: table",
      'headers: ["at", "from", "to", "by", "note"]',
      "```",
      "",
      "## Contributions",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
      "",
      "## Relationships",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(Object.keys(result)).toHaveLength(5);
    expect(result.acceptance_criteria.valid_priorities).toEqual([
      "must",
      "should",
      "nice",
    ]);
    expect(result.acceptance_criteria.valid_statuses).toEqual([
      "draft",
      "implementing",
      "verified",
      "descoped",
    ]);
    expect(result.status_history.headers).toEqual([
      "at",
      "from",
      "to",
      "by",
      "note",
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseSectionRules — skip/ignore cases
// ────────────────────────────────────────────────────────────────────────────

describe("parseSectionRules — skip cases", () => {
  test("invalid YAML in code block → section skipped silently", () => {
    const md = [
      "## Bad Section",
      "",
      "```yaml section-rules",
      "required: [unterminated",
      "```",
      "",
      "## Good Section",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(result.bad_section).toBeUndefined();
    expect(result.good_section).toBeDefined();
    expect(result.good_section.required).toBe(true);
  });

  test("code block with wrong lang (not yaml) → skipped", () => {
    const md = [
      "## Relationships",
      "",
      "```json section-rules",
      '{"required": true}',
      "```",
    ].join("\n");

    expect(parseSectionRules(md)).toEqual({});
  });

  test("code block with wrong meta (not section-rules) → skipped", () => {
    const md = [
      "## Relationships",
      "",
      "```yaml validation",
      "required: true",
      "```",
    ].join("\n");

    expect(parseSectionRules(md)).toEqual({});
  });

  test("plain yaml code block without meta → skipped", () => {
    const md = [
      "## Relationships",
      "",
      "```yaml",
      "required: true",
      "```",
    ].join("\n");

    expect(parseSectionRules(md)).toEqual({});
  });

  test("only first section-rules block per section is used", () => {
    const md = [
      "## Relationships",
      "",
      "```yaml section-rules",
      'format: "first"',
      "```",
      "",
      "```yaml section-rules",
      'format: "second"',
      "```",
    ].join("\n");

    const result = parseSectionRules(md);
    expect(result.relationships.format).toBe("first");
  });

  test("H3/H4 headings with section-rules → ignored (only H2)", () => {
    const md = [
      "### Not A Section",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    expect(parseSectionRules(md)).toEqual({});
  });

  test("gherkin code block is not confused with section-rules", () => {
    const md = [
      "## Acceptance Criteria",
      "",
      "```gherkin",
      "Scenario: test",
      "  Given something",
      "```",
    ].join("\n");

    expect(parseSectionRules(md)).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getRequiredSections
// ────────────────────────────────────────────────────────────────────────────

describe("getRequiredSections", () => {
  test("empty rules → empty array", () => {
    expect(getRequiredSections({})).toEqual([]);
  });

  test("all required → all returned", () => {
    const rules = {
      relationships: { required: true },
      status_history: { required: true },
      contributions: { required: true },
    };
    const result = getRequiredSections(rules);
    expect(result).toHaveLength(3);
    expect(result).toContain("## Relationships");
    expect(result).toContain("## Status History");
    expect(result).toContain("## Contributions");
  });

  test("mixed required/optional → only required returned", () => {
    const rules = {
      relationships: { required: true },
      user_stories: { required: false },
      status_history: { required: true },
      acceptance_criteria: { required: false },
    };
    const result = getRequiredSections(rules);
    expect(result).toHaveLength(2);
    expect(result).toContain("## Relationships");
    expect(result).toContain("## Status History");
  });

  test("no required fields → empty array", () => {
    const rules = {
      relationships: { required: false },
      status_history: { format: "something" },
    };
    expect(getRequiredSections(rules)).toEqual([]);
  });

  test("missing required field → treated as not required", () => {
    const rules = {
      relationships: { format: "something" },
    };
    expect(getRequiredSections(rules)).toEqual([]);
  });

  test("required: 'true' (string) → not required (must be boolean)", () => {
    const rules = {
      relationships: { required: "true" },
    };
    expect(getRequiredSections(rules)).toEqual([]);
  });

  test("heading case reconstruction: snake_case → Title Case", () => {
    const rules = {
      acceptance_criteria: { required: true },
      rice_score: { required: true },
      success_metric_verdict: { required: true },
    };
    const result = getRequiredSections(rules);
    expect(result).toContain("## Acceptance Criteria");
    expect(result).toContain("## Rice Score");
    expect(result).toContain("## Success Metric Verdict");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// loadTemplateSectionRules — file-based loading
// ────────────────────────────────────────────────────────────────────────────

describe("loadTemplateSectionRules", () => {
  test("null path → empty object", async () => {
    expect(await loadTemplateSectionRules(null)).toEqual({});
  });

  test("empty path → empty object", async () => {
    expect(await loadTemplateSectionRules("")).toEqual({});
  });

  test("missing file → empty object", async () => {
    expect(
      await loadTemplateSectionRules("nonexistent.md", SANDBOX)
    ).toEqual({});
  });

  test("valid template file → parsed rules", async () => {
    const tpl = [
      "---",
      'template: "templates/test.md"',
      "validation_rules:",
      "  required_fields: [status]",
      "---",
      "",
      "## Relationships",
      "",
      "```yaml section-rules",
      "required: true",
      'format: "- **<pred>** → [<title>](<path>)"',
      "```",
      "",
      "## Status History",
      "",
      "```yaml section-rules",
      "required: true",
      "type: table",
      "```",
    ].join("\n");

    writeFile("templates/test.md", tpl);
    const result = await loadTemplateSectionRules(
      "templates/test.md",
      SANDBOX
    );
    expect(result.relationships).toBeDefined();
    expect(result.relationships.required).toBe(true);
    expect(result.status_history).toBeDefined();
    expect(result.status_history.type).toBe("table");
  });

  test("file with no section-rules → empty object", async () => {
    const tpl = [
      "---",
      "status: draft",
      "---",
      "",
      "## Some Section",
      "",
      "Just content, no rules.",
    ].join("\n");

    writeFile("templates/norules.md", tpl);
    const result = await loadTemplateSectionRules(
      "templates/norules.md",
      SANDBOX
    );
    expect(result).toEqual({});
  });

  test("file with broken frontmatter → empty object (graceful)", async () => {
    const tpl = [
      "---",
      "broken: [unterminated",
      "---",
      "",
      "## Relationships",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    writeFile("templates/broken-fm.md", tpl);
    const result = await loadTemplateSectionRules(
      "templates/broken-fm.md",
      SANDBOX
    );
    expect(result).toEqual({});
  });

  test("absolute path works", async () => {
    const tpl = [
      "---",
      "status: draft",
      "---",
      "",
      "## Contributions",
      "",
      "```yaml section-rules",
      "required: true",
      "```",
    ].join("\n");

    const absPath = writeFile("templates/abs.md", tpl);
    const result = await loadTemplateSectionRules(absPath);
    expect(result.contributions).toBeDefined();
    expect(result.contributions.required).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// body-parser formatHints integration
// ────────────────────────────────────────────────────────────────────────────

describe("body-parser formatHints integration", () => {
  test("AC valid_priorities from hints → custom enum enforced", async () => {
    const md = [
      "## Acceptance Criteria",
      "",
      "### AC1 — Test criterion — `critical` · `draft`",
    ].join("\n");

    // With hints allowing "critical"
    const customHints = {
      acceptance_criteria: {
        valid_priorities: ["critical", "optional"],
        valid_statuses: ["draft", "done"],
      },
    };
    const withHints = await parseBody(md, { formatHints: customHints });
    const priorityWarns = withHints.warnings.filter(
      (w) => w.type === "ac-unknown-priority"
    );
    expect(priorityWarns).toHaveLength(0);

    // Without hints → "critical" is not in default [must, should, nice]
    const noHints = await parseBody(md);
    const defaultWarns = noHints.warnings.filter(
      (w) => w.type === "ac-unknown-priority"
    );
    expect(defaultWarns).toHaveLength(1);
    expect(defaultWarns[0].message).toContain("critical");
  });

  test("AC valid_statuses from hints → custom enum enforced", async () => {
    const md = [
      "## Acceptance Criteria",
      "",
      "### AC1 — Test — `must` · `completed`",
    ].join("\n");

    const customHints = {
      acceptance_criteria: {
        valid_statuses: ["draft", "completed"],
      },
    };
    const withHints = await parseBody(md, { formatHints: customHints });
    const statusWarns = withHints.warnings.filter(
      (w) => w.type === "ac-unknown-status"
    );
    expect(statusWarns).toHaveLength(0);

    const noHints = await parseBody(md);
    const defaultWarns = noHints.warnings.filter(
      (w) => w.type === "ac-unknown-status"
    );
    expect(defaultWarns).toHaveLength(1);
  });

  test("table headers from hints → custom headers accepted", async () => {
    const md = [
      "## Status History",
      "",
      "| timestamp | prev | next | author | comment |",
      "|---|---|---|---|---|",
      "| 2026-01-01 | draft | review | @alice | initial |",
    ].join("\n");

    const customHints = {
      status_history: {
        headers: ["timestamp", "prev", "next", "author", "comment"],
      },
    };
    const withHints = await parseBody(md, { formatHints: customHints });
    const headerWarns = withHints.warnings.filter(
      (w) => w.type === "status-history-header-mismatch"
    );
    expect(headerWarns).toHaveLength(0);
    expect(withHints.statusHistory).toHaveLength(1);
  });

  test("format string from hints appears in warning message", async () => {
    const md = [
      "## Relationships",
      "",
      "- broken line without format",
    ].join("\n");

    const hints = {
      relationships: {
        format: "- **<pred>** → [<title>](<path>)",
        example: "- **depends_on** → [PRD-001](./prd-001.md)",
      },
    };
    const result = await parseBody(md, { formatHints: hints });
    const relWarns = result.warnings.filter(
      (w) => w.type === "unparseable-relationship-line"
    );
    expect(relWarns).toHaveLength(1);
    expect(relWarns[0].message).toContain("- **<pred>** → [<title>](<path>)");
    expect(relWarns[0].fix).toContain("- **depends_on** → [PRD-001](./prd-001.md)");
  });

  test("no hints → built-in defaults used (backward compat)", async () => {
    const md = [
      "## Acceptance Criteria",
      "",
      "### AC1 — Test — `must` · `draft`",
    ].join("\n");

    const result = await parseBody(md);
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.acceptanceCriteria[0].priority).toBe("must");
    expect(result.acceptanceCriteria[0].status).toBe("draft");
    expect(result.warnings.filter((w) => w.type === "ac-unknown-priority")).toHaveLength(0);
  });

  test("empty hints object → built-in defaults used", async () => {
    const md = [
      "## Acceptance Criteria",
      "",
      "### AC1 — Test — `must` · `draft`",
    ].join("\n");

    const result = await parseBody(md, { formatHints: {} });
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.warnings.filter((w) => w.type === "ac-unknown-priority")).toHaveLength(0);
  });

  test("user story format/example from hints in warnings", async () => {
    const md = [
      "## User Stories",
      "",
      "- broken story line",
    ].join("\n");

    const hints = {
      user_stories: {
        format: "- [<title>](<path>)",
        example: "- [Login](./login.md)",
      },
    };
    const result = await parseBody(md, { formatHints: hints });
    const warns = result.warnings.filter(
      (w) => w.type === "unparseable-user-story-line"
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("- [<title>](<path>)");
    expect(warns[0].fix).toContain("- [Login](./login.md)");
  });

  test("contribution format/example from hints in warnings", async () => {
    const md = [
      "## Contributions",
      "",
      "- broken contribution",
    ].join("\n");

    const hints = {
      contributions: {
        format: "**<role>** · @<handle> · <ts>",
        example: "**author** · @alice · 2026-01-01T00:00:00Z",
      },
    };
    const result = await parseBody(md, { formatHints: hints });
    const warns = result.warnings.filter(
      (w) => w.type === "unparseable-contribution-line"
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("**<role>** · @<handle> · <ts>");
  });

  test("RICE headers from hints", async () => {
    const md = [
      "## RICE Score",
      "",
      "| Dim | Val | Comment |",
      "|---|---|---|",
      "| Reach | 100 | users |",
      "| Impact | 3 | massive |",
      "| Confidence | 0.8 | medium |",
      "| Effort | 2 | months |",
      "| **Score** | **120** | computed |",
    ].join("\n");

    const hints = {
      rice_score: {
        headers: ["dim", "val", "comment"],
        required_dimensions: ["reach", "impact", "confidence", "effort", "score"],
      },
    };
    const result = await parseBody(md, { formatHints: hints });
    const headerWarns = result.warnings.filter(
      (w) => w.type === "rice-header-mismatch"
    );
    expect(headerWarns).toHaveLength(0);
    expect(result.riceScore).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// End-to-end: parseSectionRules → body-parser formatHints
// ────────────────────────────────────────────────────────────────────────────

describe("end-to-end: template → section rules → body validation", () => {
  test("parse template, extract rules, validate document body", async () => {
    const templateBody = [
      "## Acceptance Criteria",
      "",
      "```yaml section-rules",
      "required: true",
      "valid_priorities: [critical, optional, low]",
      "valid_statuses: [open, closed]",
      "```",
      "",
      "### AC1 — Placeholder — `critical` · `open`",
    ].join("\n");

    const rules = parseSectionRules(templateBody);
    expect(rules.acceptance_criteria.valid_priorities).toEqual([
      "critical",
      "optional",
      "low",
    ]);

    // Document with custom priorities → no warnings
    const docBody = [
      "## Acceptance Criteria",
      "",
      "### AC1 — Login works — `critical` · `open`",
    ].join("\n");

    const result = await parseBody(docBody, { formatHints: rules });
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.acceptanceCriteria[0].priority).toBe("critical");
    const warns = result.warnings.filter(
      (w) =>
        w.type === "ac-unknown-priority" || w.type === "ac-unknown-status"
    );
    expect(warns).toHaveLength(0);
  });

  test("document violates template rules → warnings with template-driven messages", async () => {
    const templateBody = [
      "## Acceptance Criteria",
      "",
      "```yaml section-rules",
      "required: true",
      "valid_priorities: [must, should]",
      "valid_statuses: [draft, done]",
      "```",
    ].join("\n");

    const rules = parseSectionRules(templateBody);

    // Document uses "nice" (not in template's valid_priorities)
    const docBody = [
      "## Acceptance Criteria",
      "",
      "### AC1 — Test — `nice` · `draft`",
    ].join("\n");

    const result = await parseBody(docBody, { formatHints: rules });
    const priorityWarns = result.warnings.filter(
      (w) => w.type === "ac-unknown-priority"
    );
    expect(priorityWarns).toHaveLength(1);
    expect(priorityWarns[0].message).toContain("nice");
    expect(priorityWarns[0].message).toContain("must, should");
  });
});
