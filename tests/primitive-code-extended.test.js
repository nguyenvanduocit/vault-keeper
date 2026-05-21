/**
 * Tests for the extended `code` primitive — `min`, `max`, and
 * `content.pattern` on top of the existing `lang` filter.
 *
 * Exercised via applyBodySchema so we cover the full path including the
 * `bodyLine` anchoring logic in validateSectionContent: cardinality
 * issues anchor at the first fence (or the section heading), while
 * per-fence `code-content-mismatch` issues keep their own fence-line.
 */

import { describe, test, expect } from "bun:test";
import { applyBodySchema } from "../lib/schema-engine.js";

const errs = (issues) => issues.filter((i) => i.level === "error");

/** Build a minimal body schema with one H2 section carrying `code` rules. */
function schemaWithCode(rules) {
  return [{
    depth: 2,
    text: "Scenario",
    sectionRules: { code: rules },
    children: [],
  }];
}

const SECTION_WITH_TWO_FENCES = [
  "## Scenario",
  "",
  "```gherkin",
  "Scenario: A",
  "  Given x",
  "```",
  "",
  "```gherkin",
  "Scenario: B",
  "  Given y",
  "```",
  "",
].join("\n");

const SECTION_WITH_ONE_NON_MATCHING_FENCE = [
  "## Scenario",
  "",
  "```gherkin",
  "Not a scenario header",
  "```",
  "",
].join("\n");

const SECTION_WITH_NO_FENCE = "## Scenario\n\nplain prose only.\n";

const SECTION_WITH_MIXED_LANGS = [
  "## Scenario",
  "",
  "```js",
  "let x = 1;",
  "```",
  "",
  "```gherkin",
  "Scenario: Only one",
  "```",
  "",
].join("\n");

describe("code primitive — min/max", () => {
  test("default (no min) requires at least one matching fence", () => {
    const issues = applyBodySchema(schemaWithCode({ lang: "gherkin" }), SECTION_WITH_NO_FENCE);
    const e = errs(issues);
    expect(e.some((i) => i.error_type === "code-missing")).toBe(true);
  });

  test("min: 2 fires when only one fence exists", () => {
    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin", min: 2 }),
      SECTION_WITH_MIXED_LANGS,
    );
    expect(errs(issues).some((i) => i.message.includes("at least 2"))).toBe(true);
  });

  test("min: 2 passes when two matching fences exist", () => {
    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin", min: 2 }),
      SECTION_WITH_TWO_FENCES,
    );
    expect(errs(issues)).toHaveLength(0);
  });

  test("max: 1 fires when two matching fences exist", () => {
    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin", max: 1 }),
      SECTION_WITH_TWO_FENCES,
    );
    expect(errs(issues).some((i) => i.message.includes("at most 1"))).toBe(true);
  });

  test("min: 0 makes the section's fence optional", () => {
    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin", min: 0 }),
      SECTION_WITH_NO_FENCE,
    );
    expect(errs(issues)).toHaveLength(0);
  });
});

describe("code primitive — content.pattern", () => {
  test("each non-matching fence reports one issue with its own bodyLine", () => {
    const body = [
      "## Scenario",
      "",            // line 2
      "```gherkin",  // line 3 — passes
      "Scenario: Ok",
      "```",
      "",
      "```gherkin",  // line 7 — fails
      "Just text",
      "```",
      "",
    ].join("\n");

    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin", content: { pattern: "^Scenario:" } }),
      body,
    );
    const mismatches = errs(issues).filter((i) => i.error_type === "code-content-mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].bodyLine).toBe(7);
  });

  test("all matching fences → no content-mismatch", () => {
    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin", content: { pattern: "^Scenario:" } }),
      SECTION_WITH_TWO_FENCES,
    );
    expect(errs(issues).filter((i) => i.error_type === "code-content-mismatch")).toHaveLength(0);
  });

  test("content.pattern works without lang (applies to every fence)", () => {
    const issues = applyBodySchema(
      schemaWithCode({ content: { pattern: "^Scenario:" } }),
      SECTION_WITH_MIXED_LANGS,
    );
    // js fence fails; gherkin fence passes
    const mismatches = errs(issues).filter((i) => i.error_type === "code-content-mismatch");
    expect(mismatches).toHaveLength(1);
  });
});

describe("code primitive — backward compatibility", () => {
  test("`code: { lang: x }` alone keeps original behavior (min=1)", () => {
    const issues = applyBodySchema(
      schemaWithCode({ lang: "gherkin" }),
      SECTION_WITH_TWO_FENCES,
    );
    expect(errs(issues)).toHaveLength(0);
  });

  test("`code: {}` (no params) still requires ≥ 1 fence", () => {
    const issues = applyBodySchema(schemaWithCode({}), SECTION_WITH_NO_FENCE);
    expect(errs(issues).some((i) => i.error_type === "code-missing")).toBe(true);
  });
});
