/**
 * Unit tests for .claude/skills/tools/validate-documents.js — pure validators
 * and helpers. No I/O.
 *
 * After the template-driven refactor, doc-type-specific rules (required fields,
 * allowed statuses, status transitions) live in each template's
 * `validation_rules` block — not in CONFIG. The cross-cutting validators
 * (template path shape, naming convention, path-absoluteness) and the new rule
 * applier (applyRules) are unit-tested here. End-to-end behaviour against real
 * fixture templates is in validate-documents.integration.test.js.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateTemplateField,
  validateTemplateMetaLeak,
  validateNaming,
  validateSlug,
  suggestSlug,
  validatePaths,
  applyRules,
  isTemplateFile,
  isTemplateInstance,
  findTemplateMetaLeaks,
  resolveDocPath,
  inferDocType,
  stripCodeRegions,
  CONFIG,
} from "../cli/validate-documents.js";
import { _resetVaultConfigCache } from "../lib/vault-config.js";

// These unit tests assert validator behavior against a known folder→regex
// map (PRD/DIBB/ADR/story/research) and a known exclude-pattern set. Pin the
// config via VAULT_KEEPER_CONFIG so the test surface is independent of
// whatever lib/vault-config.js ships as defaults.
const TEST_CONFIG_PATH = resolve(
  fileURLToPath(new URL("./fixtures/test-vault-paths.json", import.meta.url)),
);
let ORIGINAL_VAULT_KEEPER_CONFIG;
beforeAll(() => {
  ORIGINAL_VAULT_KEEPER_CONFIG = process.env.VAULT_KEEPER_CONFIG;
  process.env.VAULT_KEEPER_CONFIG = TEST_CONFIG_PATH;
  _resetVaultConfigCache();
});
afterAll(() => {
  if (ORIGINAL_VAULT_KEEPER_CONFIG === undefined) {
    delete process.env.VAULT_KEEPER_CONFIG;
  } else {
    process.env.VAULT_KEEPER_CONFIG = ORIGINAL_VAULT_KEEPER_CONFIG;
  }
  _resetVaultConfigCache();
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const errorsOnly = (issues) => issues.filter((i) => i.level === "error");
const warningsOnly = (issues) => issues.filter((i) => i.level === "warning");
const fields = (issues) => issues.map((i) => i.field);

const emptyRules = () => ({
  required_fields: [],
  conditional_required_fields: [],
  optional_fields: [],
  field_rules: [],
  state_machine: null,
  __source: "test",
});

// ────────────────────────────────────────────────────────────────────────────
// validateTemplateField
// ────────────────────────────────────────────────────────────────────────────

describe("validateTemplateField", () => {
  test("missing template field → error", () => {
    const issues = validateTemplateField({}, "doc.md");
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].field).toBe("template");
    expect(issues[0].message).toContain("Missing required template field");
  });

  test("template path not under templates/ → error", () => {
    const issues = validateTemplateField(
      { template: "foo/bar.md" },
      "doc.md",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Invalid template path");
  });

  test("template path missing .md extension → error", () => {
    const issues = validateTemplateField(
      { template: "templates/prd" },
      "doc.md",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("must end with .md");
  });

  test("valid template path → no issues", () => {
    const issues = validateTemplateField(
      { template: "templates/prd-template.md" },
      "doc.md",
    );
    expect(issues).toEqual([]);
  });

  test("nested templates path is still valid (starts with templates/)", () => {
    const issues = validateTemplateField(
      { template: "templates/sub/dibb.md" },
      "doc.md",
    );
    expect(issues).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateNaming
// ────────────────────────────────────────────────────────────────────────────

describe("validateNaming", () => {
  test("valid PRD filename in PRDs folder → no issues", () => {
    const path =
      "product-knowledge/02-product/prds/2026-01-01-prd-001-coupon.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("invalid filename in PRDs folder → error", () => {
    const path = "product-knowledge/02-product/prds/coupon.md";
    const issues = validateNaming(path);
    expect(errorsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toBe("filename");
  });

  test("valid ADR filename in engineering decisions folder → no issues", () => {
    const path =
      "product-knowledge/03-engineering/decisions/2026-01-01-adr-001-pick-bun.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("invalid ADR filename → error", () => {
    const path =
      "product-knowledge/03-engineering/decisions/random-thoughts.md";
    expect(errorsOnly(validateNaming(path))).toHaveLength(1);
  });

  test("valid DIBB filename → no issues", () => {
    const path =
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-mobile.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("valid PRD without date prefix → no issues (post-2026-05-13 convention)", () => {
    // Date prefix made optional — `prd-NNN-<slug>` is the canonical form.
    // Historical dated names still validate (see test above).
    const path = "product-knowledge/02-product/prds/prd-005-coupon.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("valid DIBB without date prefix → no issues (post-2026-05-13 convention)", () => {
    const path = "product-knowledge/01-strategy/dibbs/dibb-002-growth.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("user-story still requires date prefix → error without it", () => {
    // Append-only historical artifacts (stories, ADRs, research) keep the
    // date requirement — only PRD/DIBB dropped it.
    const path =
      "product-knowledge/02-product/user-stories/story-001-checkout.md";
    expect(errorsOnly(validateNaming(path))).toHaveLength(1);
  });

  test("valid user-story filename → no issues", () => {
    const path =
      "product-knowledge/02-product/user-stories/2026-01-01-story-001-checkout.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("valid research filename → no issues", () => {
    const path =
      "product-knowledge/01-strategy/research/2026-01-01-research-001-mobile.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("file in folder with no naming pattern → no issues (skipped)", () => {
    const path = "product-knowledge/04-operations/runbooks/anything.md";
    expect(validateNaming(path)).toEqual([]);
  });

  test("README.md is always exempt from naming rules", () => {
    const path = "product-knowledge/02-product/prds/README.md";
    expect(validateNaming(path)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateSlug — every folder segment and every file basename must be
// lowercase-kebab. Task-ID prefix (t-NNN, d-NNN) and a small set of well-known
// uppercase basenames (README, BOARD, DESIGN, ...) are intentionally exempt.
// ────────────────────────────────────────────────────────────────────────────

describe("validateSlug — folder segments", () => {
  test("all-lowercase folder chain → no issues", () => {
    const path = "product-knowledge/02-product/prds/2026-01-01-prd-001-x.md";
    expect(validateSlug(path)).toEqual([]);
  });

  test("folder with space → error", () => {
    const path = "product-knowledge/02-product/ux writing/style.md";
    const issues = errorsOnly(validateSlug(path));
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("folder");
    expect(issues[0].message).toMatch(/ux writing/);
    expect(issues[0].fix).toMatch(/ux-writing/);
  });

  test("folder with uppercase letter → error", () => {
    const path = "product-knowledge/02-product/UX-Writing/style.md";
    const issues = errorsOnly(validateSlug(path));
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("folder");
    expect(issues[0].fix).toMatch(/ux-writing/);
  });

  test("folder with underscore → error", () => {
    const path = "product-knowledge/02-product/ux_writing/style.md";
    const issues = errorsOnly(validateSlug(path));
    expect(issues).toHaveLength(1);
    expect(issues[0].fix).toMatch(/ux-writing/);
  });

  test("hidden folder (.omc) → skipped", () => {
    const path = "product-knowledge/03-engineering/tasks/.omc/state/foo.json";
    expect(validateSlug(path)).toEqual([]);
  });

  test("multiple bad folders → one error per offender", () => {
    const path = "product-knowledge/Bad Folder/Another_Bad/file.md";
    expect(errorsOnly(validateSlug(path))).toHaveLength(2);
  });

  test("date-prefixed folder (2026-05-001-...) is valid slug", () => {
    const path = "product-knowledge/02-product/design/discovery/2026-05-001-consolidate-settings/README.md";
    expect(validateSlug(path)).toEqual([]);
  });

  test("deep nested slug path stays clean", () => {
    const path =
      "product-knowledge/02-product/design/discovery/2026-05-001-consolidate-settings/solutions/01-scope-grouped-settings/specs/2026-05-spec-001-settings-shell.html";
    expect(validateSlug(path)).toEqual([]);
  });
});

describe("validateSlug — file basenames", () => {
  test("slug filename → no issues", () => {
    expect(validateSlug("product-knowledge/01-strategy/dibbs/2026-05-12-dibb-001-year-of-trust.md")).toEqual([]);
  });

  test("filename with space → error", () => {
    const issues = errorsOnly(validateSlug("product-knowledge/02-product/ux-writing/Style guide.md"));
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("filename");
    expect(issues[0].fix).toMatch(/style-guide\.md/);
  });

  test("filename with uppercase letters → error", () => {
    const issues = errorsOnly(validateSlug("product-knowledge/01-strategy/TrueProfit-handbook.md"));
    expect(issues).toHaveLength(1);
    expect(issues[0].fix).toMatch(/true-profit-handbook\.md/);
  });

  test("filename with embedded camelCase token → error", () => {
    const issues = errorsOnly(validateSlug(
      "product-knowledge/03-engineering/investigations/2025-10-30-analysis-syncStartHandler-investigation.md"
    ));
    expect(issues).toHaveLength(1);
    expect(issues[0].fix).toMatch(/sync-start-handler/);
  });

  test("filename with underscore → error", () => {
    const issues = errorsOnly(validateSlug(
      "product-knowledge/02-product/design/design_tokens.json"
    ));
    expect(issues).toHaveLength(1);
    expect(issues[0].fix).toMatch(/design-tokens\.json/);
  });

  test("task-ID prefix t-NNN-slug.md → exempt (no issue)", () => {
    expect(validateSlug("product-knowledge/03-engineering/tasks/t-051-integrate-reportfns.md")).toEqual([]);
  });

  test("task-ID prefix d-NNN-slug.md → exempt (no issue)", () => {
    expect(validateSlug("product-knowledge/02-product/design/tasks/d-001-add-layer.md")).toEqual([]);
  });

  test("task-ID with multi-letter lowercase prefix (shtp-NNN) → exempt", () => {
    expect(validateSlug("product-knowledge/03-engineering/tasks/shtp-6488-shared-dlq.md")).toEqual([]);
  });

  test("uppercase task-ID prefix (T-NNN) → error (slug must be lowercase)", () => {
    const issues = errorsOnly(validateSlug("product-knowledge/03-engineering/tasks/T-051-integrate-reportfns.md"));
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("filename");
    expect(issues[0].fix).toMatch(/t-051-integrate-reportfns\.md/);
  });

  test("Jira-id token in MIDDLE of filename → not exempt (only PREFIX position counts)", () => {
    // 2025-10-21-issue-analysis-SHTP-6138-... has uppercase SHTP mid-name, so
    // the name part doesn't match either segmentPattern or taskIdPattern.
    const issues = errorsOnly(validateSlug(
      "product-knowledge/03-engineering/investigations/2025-10-21-issue-analysis-SHTP-6138-cogs.md"
    ));
    expect(issues).toHaveLength(1);
  });

  test("README.md → exempt anywhere in the tree", () => {
    expect(validateSlug("product-knowledge/04-operations/README.md")).toEqual([]);
    expect(validateSlug("product-knowledge/04-operations/marketing/README.md")).toEqual([]);
  });

  test("BOARD.md → exempt (auto-generated kanban)", () => {
    expect(validateSlug("product-knowledge/BOARD.md")).toEqual([]);
  });

  test("DESIGN.md → exempt (Google Labs convention)", () => {
    expect(validateSlug("product-knowledge/02-product/design/design-system/design-md/DESIGN.md")).toEqual([]);
  });

  test("hidden file .gitkeep → exempt", () => {
    expect(validateSlug("product-knowledge/02-product/tasks/.gitkeep")).toEqual([]);
  });

  test("multi-dot extension (tailwind.config.js) → no issues when every segment is slug", () => {
    expect(validateSlug("product-knowledge/some/tailwind.config.js")).toEqual([]);
  });

  test("multi-dot extension with bad segment → error pinpoints the bad segment", () => {
    const issues = errorsOnly(validateSlug("product-knowledge/some/file.Bad.json"));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/Bad/);
  });

  test("uppercase extension (.PNG) → error", () => {
    const issues = errorsOnly(validateSlug("product-knowledge/some/image.PNG"));
    expect(issues).toHaveLength(1);
  });

  test("absolute filepath gets normalized to repo-relative before validation", () => {
    const abs = `${process.cwd()}/product-knowledge/02-product/ux writing/file.md`;
    const issues = errorsOnly(validateSlug(abs));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].field).toBe("folder");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// suggestSlug — pure helper that produces the fix-hint slug form for a name.
// ────────────────────────────────────────────────────────────────────────────

describe("suggestSlug", () => {
  test("camelCase → kebab", () => {
    expect(suggestSlug("syncStartHandler")).toBe("sync-start-handler");
    expect(suggestSlug("getUsage")).toBe("get-usage");
  });

  test("underscores → hyphens", () => {
    expect(suggestSlug("design_tokens")).toBe("design-tokens");
  });

  test("whitespace → hyphens", () => {
    expect(suggestSlug("TrueProfit tone and voice")).toBe("true-profit-tone-and-voice");
    expect(suggestSlug("Style guide")).toBe("style-guide");
  });

  test("uppercase abbreviation followed by camelCase → split correctly", () => {
    expect(suggestSlug("ABCFoo")).toBe("abc-foo");
    expect(suggestSlug("APIClient")).toBe("api-client");
  });

  test("mixed: SHTP-6138-cogs → lowercase preserved as hyphen run", () => {
    expect(suggestSlug("SHTP-6138-cogs")).toBe("shtp-6138-cogs");
  });

  test("already-slug input is idempotent", () => {
    expect(suggestSlug("already-good-slug")).toBe("already-good-slug");
  });

  test("strips characters outside [a-z0-9-]", () => {
    expect(suggestSlug("foo!@#bar")).toBe("foobar");
  });

  test("collapses repeated hyphens and trims edges", () => {
    expect(suggestSlug("---foo---bar---")).toBe("foo-bar");
  });

  test("empty / non-string → empty string", () => {
    expect(suggestSlug("")).toBe("");
    expect(suggestSlug(null)).toBe("");
    expect(suggestSlug(undefined)).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validatePaths
// ────────────────────────────────────────────────────────────────────────────

describe("validatePaths", () => {
  test("absolute paths in relationships → no issues", () => {
    const fm = {
      relationships: {
        implements: [
          { path: "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-x.md" },
        ],
      },
    };
    expect(validatePaths(fm, "")).toEqual([]);
  });

  test("relative ../ in relationships → error", () => {
    const fm = { relationships: { implements: [{ path: "../foo.md" }] } };
    const issues = validatePaths(fm, "");
    expect(errorsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toMatch(/relationships\.implements/);
  });

  test("relative ./ in relationships → error", () => {
    const fm = { relationships: { derived_from: [{ path: "./bar.md" }] } };
    expect(errorsOnly(validatePaths(fm, ""))).toHaveLength(1);
  });

  test("relative path inside body content → warning", () => {
    const body = `Look at "../neighbor.md" for context.`;
    const issues = validatePaths({}, body);
    expect(warningsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toBe("body");
  });

  test("body without quoted relative paths → no issues", () => {
    const body = `# Doc\n\nReference: product-knowledge/02-product/prds/foo.md`;
    expect(validatePaths({}, body)).toEqual([]);
  });

  test("multiple relative paths → multiple errors", () => {
    const fm = {
      relationships: {
        implements: [{ path: "../a.md" }, { path: "./b.md" }],
      },
    };
    expect(errorsOnly(validatePaths(fm, ""))).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyRules — required_fields
// ────────────────────────────────────────────────────────────────────────────

describe("applyRules — required_fields", () => {
  test("all required present → no issues", () => {
    const rules = { ...emptyRules(), required_fields: ["template", "status"] };
    const fm = { template: "templates/x.md", status: "draft" };
    expect(applyRules(rules, fm, "", "x.md")).toEqual([]);
  });

  test("missing field → 1 error per field", () => {
    const rules = { ...emptyRules(), required_fields: ["template", "status", "owner"] };
    const fm = { template: "templates/x.md" };
    const issues = applyRules(rules, fm, "", "x.md");
    expect(errorsOnly(issues)).toHaveLength(2);
    expect(fields(issues).sort()).toEqual(["owner", "status"]);
  });

  test("nested dot-path required field works", () => {
    const rules = { ...emptyRules(), required_fields: ["relationships.derived_from"] };
    const issues = applyRules(rules, { relationships: {} }, "", "x.md");
    expect(errorsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toBe("relationships.derived_from");
  });

  test("empty string treated as missing", () => {
    const rules = { ...emptyRules(), required_fields: ["owner"] };
    expect(errorsOnly(applyRules(rules, { owner: "" }, "", "x.md"))).toHaveLength(1);
  });

  test("array value (even empty) is considered present", () => {
    // Empty arrays satisfy 'required' — use min_count via conditional rule
    // when "≥ 1 entry" is the real intent.
    const rules = { ...emptyRules(), required_fields: ["tags"] };
    expect(applyRules(rules, { tags: [] }, "", "x.md")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyRules — field_rules
// ────────────────────────────────────────────────────────────────────────────

describe("applyRules — field_rules.values (enum)", () => {
  const rules = {
    ...emptyRules(),
    field_rules: [{ field: "status", values: ["draft", "approved"] }],
  };

  test("value in list → no issues", () => {
    expect(applyRules(rules, { status: "draft" }, "", "x.md")).toEqual([]);
  });

  test("value not in list → error", () => {
    const issues = applyRules(rules, { status: "wat" }, "", "x.md");
    expect(errorsOnly(issues)).toHaveLength(1);
    expect(issues[0].fix).toContain("draft");
  });

  test("missing field is skipped (use required_fields for presence)", () => {
    expect(applyRules(rules, {}, "", "x.md")).toEqual([]);
  });
});

describe("applyRules — field_rules.regex", () => {
  const rules = {
    ...emptyRules(),
    field_rules: [{ field: "created", regex: "^\\d{4}-\\d{2}-\\d{2}$" }],
  };

  test("matching string → no issues", () => {
    expect(applyRules(rules, { created: "2026-01-01" }, "", "x.md")).toEqual([]);
  });

  test("non-matching string → error", () => {
    expect(errorsOnly(applyRules(rules, { created: "01/01/2026" }, "", "x.md")))
      .toHaveLength(1);
  });

  test("Date instance bypasses regex (YAML 1.1 already enforced format)", () => {
    expect(applyRules(rules, { created: new Date("2026-01-01") }, "", "x.md"))
      .toEqual([]);
  });

  test("invalid Date instance → error", () => {
    expect(errorsOnly(applyRules(rules, { created: new Date("not-a-date") }, "", "x.md")))
      .toHaveLength(1);
  });

  test("non-string non-Date (number) → error", () => {
    expect(errorsOnly(applyRules(rules, { created: 20260101 }, "", "x.md")))
      .toHaveLength(1);
  });
});

describe("applyRules — field_rules.type / min", () => {
  test("type:integer rejects non-integer", () => {
    const rules = {
      ...emptyRules(),
      field_rules: [{ field: "count", type: "integer" }],
    };
    expect(errorsOnly(applyRules(rules, { count: 1.5 }, "", "x.md")))
      .toHaveLength(1);
    expect(applyRules(rules, { count: 7 }, "", "x.md")).toEqual([]);
  });

  test("min: rejects values below threshold", () => {
    const rules = {
      ...emptyRules(),
      field_rules: [{ field: "score", min: 0 }],
    };
    expect(errorsOnly(applyRules(rules, { score: -1 }, "", "x.md"))).toHaveLength(1);
    expect(applyRules(rules, { score: 0 }, "", "x.md")).toEqual([]);
    expect(applyRules(rules, { score: 5 }, "", "x.md")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyRules — conditional_required_fields
// ────────────────────────────────────────────────────────────────────────────

describe("applyRules — conditional_required_fields", () => {
  test("condition false → no issues regardless of field presence", () => {
    const rules = {
      ...emptyRules(),
      conditional_required_fields: [
        {
          condition: "status in ['shipped']",
          field: "shipped_at",
          required: true,
        },
      ],
    };
    expect(applyRules(rules, { status: "draft" }, "", "x.md")).toEqual([]);
  });

  test("condition true + required missing → error", () => {
    const rules = {
      ...emptyRules(),
      conditional_required_fields: [
        {
          condition: "status in ['shipped']",
          field: "shipped_at",
          required: true,
        },
      ],
    };
    const issues = applyRules(rules, { status: "shipped" }, "", "x.md");
    expect(errorsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toBe("shipped_at");
    expect(issues[0].message).toContain("status in ['shipped']");
  });

  test("condition true + required present → no issues", () => {
    const rules = {
      ...emptyRules(),
      conditional_required_fields: [
        { condition: "status in ['shipped']", field: "shipped_at", required: true },
      ],
    };
    expect(
      applyRules(rules, { status: "shipped", shipped_at: "2026-01-01" }, "", "x.md"),
    ).toEqual([]);
  });

  test("min_count: array shorter than required → error", () => {
    const rules = {
      ...emptyRules(),
      conditional_required_fields: [
        {
          condition: "prd_type in ['feature']",
          field: "relationships.user_stories",
          min_count: 2,
        },
      ],
    };
    const fm = { prd_type: "feature", relationships: { user_stories: [{ path: "a" }] } };
    expect(errorsOnly(applyRules(rules, fm, "", "x.md"))).toHaveLength(1);
  });

  test("min_count: array meets count → no issues", () => {
    const rules = {
      ...emptyRules(),
      conditional_required_fields: [
        { condition: "prd_type in ['feature']", field: "tags", min_count: 1 },
      ],
    };
    expect(applyRules(rules, { prd_type: "feature", tags: ["x"] }, "", "x.md"))
      .toEqual([]);
  });

  test("malformed DSL surfaces as a validation_rules error (not a crash)", () => {
    const rules = {
      ...emptyRules(),
      conditional_required_fields: [
        { condition: "status @bogus@", field: "x", required: true },
      ],
    };
    const issues = applyRules(rules, { status: "draft" }, "", "x.md");
    expect(errorsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toBe("validation_rules");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// applyRules — state_machine (informational)
// ────────────────────────────────────────────────────────────────────────────

describe("applyRules — state_machine", () => {
  test("declared status → no warning", () => {
    const rules = {
      ...emptyRules(),
      state_machine: { draft: ["review"], review: [] },
    };
    expect(applyRules(rules, { status: "draft" }, "", "x.md")).toEqual([]);
  });

  test("undeclared status → warning (not error)", () => {
    const rules = {
      ...emptyRules(),
      state_machine: { draft: ["review"], review: [] },
    };
    const issues = applyRules(rules, { status: "shipped" }, "", "x.md");
    expect(errorsOnly(issues)).toEqual([]);
    expect(warningsOnly(issues)).toHaveLength(1);
    expect(issues[0].field).toBe("status");
  });

  test("missing status with state_machine → no warning (status is optional here)", () => {
    const rules = {
      ...emptyRules(),
      state_machine: { draft: ["review"] },
    };
    expect(applyRules(rules, {}, "", "x.md")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// inferDocType
// ────────────────────────────────────────────────────────────────────────────

describe("inferDocType", () => {
  test("explicit document_type wins", () => {
    expect(inferDocType({ document_type: "custom", template: "templates/x.md" }))
      .toBe("custom");
  });

  test("v3.1.0-style template basename → 'prd'", () => {
    expect(inferDocType({ template: "templates/prd-template.md" })).toBe("prd");
  });

  test("short template name (test fixtures) → basename", () => {
    expect(inferDocType({ template: "templates/dibb.md" })).toBe("dibb");
  });

  test("compound template → preserves hyphenated type", () => {
    expect(inferDocType({ template: "templates/work-bug-template.md" }))
      .toBe("work-bug");
  });

  test("no template + no document_type → 'unknown'", () => {
    expect(inferDocType({})).toBe("unknown");
  });

  test("empty frontmatter → 'unknown'", () => {
    expect(inferDocType(undefined)).toBe("unknown");
    expect(inferDocType(null)).toBe("unknown");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isTemplateFile
// ────────────────────────────────────────────────────────────────────────────

describe("isTemplateFile", () => {
  test("relative path under templates/ → true", () => {
    expect(isTemplateFile("templates/prd.md")).toBe(true);
  });

  test("path with embedded /templates/ segment → true", () => {
    expect(isTemplateFile("any/where/templates/prd.md")).toBe(true);
  });

  test("absolute path through /templates/ → true", () => {
    expect(isTemplateFile("/Volumes/Data/foo/templates/prd.md")).toBe(true);
  });

  test("equal to bare 'templates' → true", () => {
    expect(isTemplateFile("templates")).toBe(true);
  });

  test("non-template path → false", () => {
    expect(isTemplateFile("product-knowledge/02-product/prds/x.md")).toBe(
      false,
    );
  });

  test("substring 'templates' without slash → false", () => {
    expect(isTemplateFile("mytemplates/x.md")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CONFIG sanity — pin the canonical cross-cutting rules
// ────────────────────────────────────────────────────────────────────────────

describe("CONFIG (canonical cross-cutting rules)", () => {
  test("contentFolders includes product-knowledge", () => {
    expect(CONFIG.contentFolders).toContain("product-knowledge");
  });

  test("templateFolder is 'templates'", () => {
    expect(CONFIG.templateFolder).toBe("templates");
  });

  test("excludePatterns covers README.md, vitepress, node_modules", () => {
    expect(CONFIG.excludePatterns).toContain("**/README.md");
    expect(CONFIG.excludePatterns).toContain("**/.vitepress/**");
    expect(CONFIG.excludePatterns).toContain("**/node_modules/**");
  });

  test("naming pattern exists for each documented folder", () => {
    expect(Object.keys(CONFIG.namingPatterns)).toEqual(
      expect.arrayContaining([
        "product-knowledge/01-strategy/dibbs",
        "product-knowledge/02-product/prds",
        "product-knowledge/02-product/user-stories",
        "product-knowledge/03-engineering/decisions",
        "product-knowledge/01-strategy/research",
      ]),
    );
  });

  test("no per-doc-type CONFIG remains (rules now live in templates)", () => {
    // After the template-driven refactor, these legacy keys must be gone.
    // If anything reintroduces them, this test will catch the regression.
    expect(CONFIG.requiredFields).toBeUndefined();
    expect(CONFIG.validStatuses).toBeUndefined();
  });

  test("templateOnlyFields covers the 3 unambiguously template-only meta fields", () => {
    // Source: templates/prd-template.md header declares the meta block.
    // Used by template-meta-leak detection.
    expect(CONFIG.templateOnlyFields).toContain("validation_rules");
    expect(CONFIG.templateOnlyFields).toContain("template_version");
    expect(CONFIG.templateOnlyFields).toContain("template_id");
  });

  test("templateOnlyFields does NOT include `template` (singular — required in instances)", () => {
    // Catastrophic regression guard: stripping `template` would break every
    // instance — `template` is in template-driven required_fields.
    expect(CONFIG.templateOnlyFields).not.toContain("template");
  });

  test("templateOnlyFields does NOT include `template_path` (legitimate folder-readme field)", () => {
    // Regression guard: templates/folder-readme-template.md uses template_path
    // to document which template files in the folder should use. Stripping
    // would destroy legitimate metadata on every README.md folder-meta file.
    expect(CONFIG.templateOnlyFields).not.toContain("template_path");
  });

  test("excludePatterns excludes README.md as folder-meta", () => {
    // README.md is the universal folder-meta name. Folder-level README.md
    // describes folder purpose and is not graph content. Validating them
    // produces orphan noise without surfacing real drift.
    expect(CONFIG.excludePatterns).toContain("**/README.md");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isTemplateInstance — pure path classification (inverse of isTemplateFile)
// ────────────────────────────────────────────────────────────────────────────

describe("isTemplateInstance", () => {
  test("returns false for top-level templates/ scaffolds", () => {
    expect(isTemplateInstance("templates/prd-template.md")).toBe(false);
    expect(isTemplateInstance("templates/work-bug-template.md")).toBe(false);
  });

  test("returns false for nested templates/ folders", () => {
    expect(
      isTemplateInstance("product-knowledge/02-product/templates/foo.md")
    ).toBe(false);
  });

  test("returns true for derived instances under product-knowledge/", () => {
    expect(
      isTemplateInstance(
        "product-knowledge/02-product/prds/2026-05-01-prd-001-foo.md"
      )
    ).toBe(true);
  });

  test("returns true for arbitrary non-template paths", () => {
    expect(isTemplateInstance(".specify/specs/some-spec.md")).toBe(true);
  });

  test("returns false for empty/null filepath (defensive)", () => {
    expect(isTemplateInstance("")).toBe(false);
    expect(isTemplateInstance(null)).toBe(false);
    expect(isTemplateInstance(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findTemplateMetaLeaks — pure detection of template-only fields in instances
// ────────────────────────────────────────────────────────────────────────────

describe("findTemplateMetaLeaks", () => {
  test("returns [] for clean instance (no template-only fields)", () => {
    const fm = {
      template: "templates/prd-template.md",
      status: "draft",
      owner: "@alice",
    };
    expect(
      findTemplateMetaLeaks(
        "product-knowledge/02-product/prds/2026-05-01-prd-001.md",
        fm
      )
    ).toEqual([]);
  });

  test("flags validation_rules leak in instance", () => {
    const fm = {
      template: "templates/prd-template.md",
      status: "draft",
      validation_rules: { required_fields: ["template"] },
    };
    const leaks = findTemplateMetaLeaks(
      "product-knowledge/02-product/prds/2026-05-01-prd-001.md",
      fm
    );
    expect(leaks).toEqual(["validation_rules"]);
  });

  test("flags the 3 template-only fields when full meta block leaks", () => {
    // Realistic copy-paste scenario: user duplicates templates/prd-template.md
    // header into a new instance — meta fields ride along. template_path is
    // intentionally NOT flagged (overloaded semantics).
    const fm = {
      template: "templates/prd-template.md", // required, must NOT be flagged
      template_version: "3.1.0",
      template_id: "prd-template",
      template_path: "templates/prd-template.md", // overloaded, must NOT flag
      validation_rules: { required_fields: ["template"] },
      status: "draft",
    };
    const leaks = findTemplateMetaLeaks(
      "product-knowledge/02-product/prds/2026-05-01-prd-001.md",
      fm
    );
    expect(leaks).toContain("validation_rules");
    expect(leaks).toContain("template_version");
    expect(leaks).toContain("template_id");
    expect(leaks).not.toContain("template_path"); // overloaded survives
    expect(leaks).not.toContain("template"); // singular survives
    expect(leaks).not.toContain("status");
    expect(leaks.length).toBe(3);
  });

  test("does NOT flag template_path on folder-readme (overloaded semantics)", () => {
    const fm = {
      template: "templates/folder-readme-template.md",
      template_path: "templates/prd-template.md",
      folder_purpose: "Product Requirements Documents",
      status: "approved",
    };
    expect(
      findTemplateMetaLeaks(
        "product-knowledge/02-product/prds/README.md",
        fm
      )
    ).toEqual([]);
  });

  test("flags only the leaked subset when partial fields are present", () => {
    const fm = {
      template: "templates/prd-template.md",
      template_id: "prd-template",
      status: "draft",
    };
    const leaks = findTemplateMetaLeaks(
      "product-knowledge/02-product/prds/2026-05-01-prd-001.md",
      fm
    );
    expect(leaks).toEqual(["template_id"]);
  });

  test("returns [] for the template scaffold itself (validation_rules belongs there)", () => {
    const fm = {
      template_id: "prd-template",
      validation_rules: { required_fields: ["template"] },
    };
    expect(findTemplateMetaLeaks("templates/prd-template.md", fm)).toEqual([]);
  });

  test("handles missing/invalid frontmatter defensively", () => {
    const path = "product-knowledge/02-product/prds/2026-05-01-prd-001.md";
    expect(findTemplateMetaLeaks(path, null)).toEqual([]);
    expect(findTemplateMetaLeaks(path, undefined)).toEqual([]);
    expect(findTemplateMetaLeaks(path, "not-an-object")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateTemplateMetaLeak — wrapper that emits warning issues
// ────────────────────────────────────────────────────────────────────────────

describe("validateTemplateMetaLeak", () => {
  test("clean instance → no issues", () => {
    expect(
      validateTemplateMetaLeak(
        { template: "templates/prd-template.md" },
        "product-knowledge/02-product/prds/2026-05-01-prd-001.md"
      )
    ).toEqual([]);
  });

  test("leaked field → 1 warning per field", () => {
    const issues = validateTemplateMetaLeak(
      {
        template: "templates/prd-template.md",
        validation_rules: {},
        template_id: "prd-template",
      },
      "product-knowledge/02-product/prds/2026-05-01-prd-001.md"
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.level === "warning")).toBe(true);
    expect(issues.map((i) => i.field).sort()).toEqual([
      "template_id",
      "validation_rules",
    ]);
  });

  test("template scaffold itself → no issues", () => {
    expect(
      validateTemplateMetaLeak(
        { validation_rules: {} },
        "templates/prd-template.md"
      )
    ).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// resolveDocPath — link normalization (skip URLs, placeholders, code refs)
// ────────────────────────────────────────────────────────────────────────────

describe("resolveDocPath", () => {
  test("plain markdown path → unchanged", () => {
    expect(resolveDocPath("product-knowledge/02-product/prds/foo.md")).toBe(
      "product-knowledge/02-product/prds/foo.md"
    );
  });

  test("strips anchor fragment", () => {
    expect(resolveDocPath("foo.md#section")).toBe("foo.md");
  });

  test("URL → null (skipped)", () => {
    expect(resolveDocPath("https://example.com/foo")).toBeNull();
    expect(resolveDocPath("http://example.com")).toBeNull();
  });

  test("placeholder path with [brackets] → null (skipped)", () => {
    expect(resolveDocPath("[future-prd-001]")).toBeNull();
  });

  test("source-code line ref → null (skipped)", () => {
    expect(resolveDocPath("internal/order/handler.go:42")).toBeNull();
    expect(resolveDocPath("src/foo.ts:100")).toBeNull();
    expect(resolveDocPath("app.py:5")).toBeNull();
  });

  test("empty/null/non-string → null", () => {
    expect(resolveDocPath("")).toBeNull();
    expect(resolveDocPath(null)).toBeNull();
    expect(resolveDocPath(undefined)).toBeNull();
    expect(resolveDocPath(42)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// stripCodeRegions — pure markdown code-region remover used by validatePaths
// to avoid false-positives on documented code samples.
// ────────────────────────────────────────────────────────────────────────────

describe("stripCodeRegions", () => {
  test("strips fenced ``` blocks", () => {
    const md = 'before\n```\ncode "./foo.js"\n```\nafter';
    const out = stripCodeRegions(md);
    expect(out).not.toMatch(/foo\.js/);
    expect(out).toMatch(/before/);
    expect(out).toMatch(/after/);
  });

  test("strips fenced ~~~ blocks", () => {
    const md = 'pre\n~~~js\nrequire("./bar")\n~~~\npost';
    const out = stripCodeRegions(md);
    expect(out).not.toMatch(/bar/);
    expect(out).toMatch(/pre/);
    expect(out).toMatch(/post/);
  });

  test("strips inline `code` spans", () => {
    const md = 'see `import "./foo"` for context';
    const out = stripCodeRegions(md);
    expect(out).not.toMatch(/foo/);
    expect(out).toMatch(/see/);
    expect(out).toMatch(/for context/);
  });

  test("strips 4-space indented code lines (legacy markdown)", () => {
    const md = 'paragraph\n\n    $inline("./fp.js");\n    other line\n\nback to prose';
    const out = stripCodeRegions(md);
    expect(out).not.toMatch(/fp\.js/);
    expect(out).toMatch(/paragraph/);
    expect(out).toMatch(/back to prose/);
  });

  test("strips tab-indented code lines", () => {
    const md = 'normal\n\n\tcode("../bad")\n\nresume';
    const out = stripCodeRegions(md);
    expect(out).not.toMatch(/bad/);
  });

  test("preserves prose-level relative path mentions", () => {
    // A naked `./foo` outside any code region SHOULD survive — that's the
    // signal validatePaths is actually meant to catch.
    const md = 'broken vault link: "./missing.md" needs absolute path';
    const out = stripCodeRegions(md);
    expect(out).toMatch(/missing\.md/);
  });

  test("non-string input returns empty string", () => {
    expect(stripCodeRegions(null)).toBe("");
    expect(stripCodeRegions(undefined)).toBe("");
    expect(stripCodeRegions(42)).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validatePaths — body relative-path scan, must skip code regions
// ────────────────────────────────────────────────────────────────────────────

describe("validatePaths body code-region awareness", () => {
  test("relative path inside fenced block is NOT flagged", () => {
    const fm = {};
    const body = '```js\nimport x from "./foo.js";\n```';
    expect(validatePaths(fm, body)).toEqual([]);
  });

  test("relative path inside 4-space indented block is NOT flagged (T-054 case)", () => {
    const fm = {};
    const body = 'Solution:\n\n    $inline("./fp.js");\n    Shopify.analytics.publish("trueprofit:fp", { fpId });\n';
    expect(validatePaths(fm, body)).toEqual([]);
  });

  test("relative path inside inline `code` span is NOT flagged", () => {
    const fm = {};
    const body = 'see `import("./mod")` for usage';
    expect(validatePaths(fm, body)).toEqual([]);
  });

  test("naked relative path in prose IS flagged (signal preserved)", () => {
    const fm = {};
    // Outside any code region — exactly what the rule is designed to surface.
    const body = 'broken vault link: see "./missing.md" — should be absolute';
    const issues = validatePaths(fm, body);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].field).toBe("body");
  });
});
