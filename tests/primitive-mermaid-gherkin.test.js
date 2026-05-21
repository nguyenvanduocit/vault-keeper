import { describe, expect, test } from "bun:test";
import {
  applyBodySchema,
  applyBodySchemaAsync,
  validateBodyTemplateSchema,
} from "../lib/schema-engine.js";

const schemaWithRules = (rules) => [
  {
    depth: 2,
    text: "Diagram",
    sectionRules: rules,
    children: [],
  },
];

const errs = (issues) => issues.filter((i) => i.level === "error");

describe("mermaid primitive", () => {
  test("validates Mermaid syntax with Mermaid's parser", async () => {
    const body = [
      "## Diagram",
      "",
      "```mermaid",
      "graph TD",
      "  A-->B",
      "```",
      "",
    ].join("\n");

    const issues = await applyBodySchemaAsync(schemaWithRules({ mermaid: {} }), body);

    expect(errs(issues)).toHaveLength(0);
  });

  test("reports invalid Mermaid syntax at the fenced block", async () => {
    const body = [
      "## Diagram",
      "",
      "```mermaid",
      "graph TD",
      "  A--B",
      "```",
      "",
    ].join("\n");

    const issues = await applyBodySchemaAsync(schemaWithRules({ mermaid: {} }), body);
    const syntax = errs(issues).find((i) => i.error_type === "mermaid-syntax");

    expect(syntax).toBeTruthy();
    expect(syntax.bodyLine).toBeGreaterThanOrEqual(3);
  });

  test("reports missing Mermaid fence", async () => {
    const issues = await applyBodySchemaAsync(
      schemaWithRules({ mermaid: {} }),
      "## Diagram\n\nNo diagram here.\n",
    );

    expect(errs(issues).map((i) => i.error_type)).toContain("mermaid-missing");
  });

  test("sync applyBodySchema points callers to async path", () => {
    const issues = applyBodySchema(
      schemaWithRules({ mermaid: {} }),
      "## Diagram\n\n```mermaid\ngraph TD\n  A-->B\n```\n",
    );

    expect(errs(issues).map((i) => i.error_type)).toContain("async-validator-unavailable");
  });
});

describe("gherkin primitive", () => {
  test("validates Gherkin feature syntax", async () => {
    const body = [
      "## Diagram",
      "",
      "```gherkin",
      "Feature: Login",
      "  Scenario: successful login",
      "    Given a registered user",
      "    When they submit valid credentials",
      "    Then they see the dashboard",
      "```",
      "",
    ].join("\n");

    const issues = await applyBodySchemaAsync(schemaWithRules({ gherkin: {} }), body);

    expect(errs(issues)).toHaveLength(0);
  });

  test("reports invalid Gherkin syntax", async () => {
    const body = [
      "## Diagram",
      "",
      "```gherkin",
      "Scenario: missing feature",
      "  Given a registered user",
      "```",
      "",
    ].join("\n");

    const issues = await applyBodySchemaAsync(schemaWithRules({ gherkin: {} }), body);
    const syntax = errs(issues).find((i) => i.error_type === "gherkin-syntax");

    expect(syntax).toBeTruthy();
    expect(syntax.bodyLine).toBe(3);
  });

  test("reports missing Gherkin fence", async () => {
    const issues = await applyBodySchemaAsync(
      schemaWithRules({ gherkin: {} }),
      "## Diagram\n\nNo feature here.\n",
    );

    expect(errs(issues).map((i) => i.error_type)).toContain("gherkin-missing");
  });
});

describe("Mermaid/Gherkin template meta-validation", () => {
  test("accepts valid mermaid and gherkin rules", () => {
    const issues = validateBodyTemplateSchema(schemaWithRules({
      mermaid: { lang: ["mermaid", "mmd"], min: 1 },
      gherkin: { lang: "feature", defaultDialect: "en" },
    }));

    expect(errs(issues)).toHaveLength(0);
  });

  test("rejects unknown nested keys", () => {
    const issues = validateBodyTemplateSchema(schemaWithRules({
      mermaid: { language: "mermaid" },
      gherkin: { dialect: "en" },
    }));

    expect(errs(issues).map((i) => i.message).join("\n")).toContain("Unknown key 'language' in 'mermaid'");
    expect(errs(issues).map((i) => i.message).join("\n")).toContain("Unknown key 'dialect' in 'gherkin'");
  });
});
