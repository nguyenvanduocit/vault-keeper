/**
 * Tests for the composable schema validation engine. Pure tests — no I/O.
 *
 * Covers: every scalar primitive (pass+fail), `when` gating, severity/message
 * override, synthetic `$path`, strict mode, `validateTemplateSchema` catching
 * every malformed-template case, conditional `required`, shorthand vs expanded.
 */

import { describe, test, expect } from "bun:test";
import {
  PRIMITIVES,
  SYNTHETIC_RESOLVERS,
  applyFieldSchema,
  validateTemplateSchema,
} from "../lib/schema-engine.js";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Shorthand to run applyFieldSchema with minimal boilerplate. */
function apply(fields, frontmatter, docMeta = {}) {
  return applyFieldSchema({ fields }, frontmatter, docMeta);
}

function applyStrict(fields, frontmatter, docMeta = {}) {
  return applyFieldSchema({ fields, strict: true }, frontmatter, docMeta);
}

// ────────────────────────────────────────────────────────────────────────────
// Primitive: type
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — type", () => {
  test("string — pass", () => {
    const issues = apply({ x: { type: "string" } }, { x: "hello" });
    expect(issues).toHaveLength(0);
  });

  test("string — fail (number given)", () => {
    const issues = apply({ x: { type: "string" } }, { x: 42 });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
    expect(issues[0].field).toBe("x");
  });

  test("integer — pass", () => {
    const issues = apply({ x: { type: "integer" } }, { x: 7 });
    expect(issues).toHaveLength(0);
  });

  test("integer — fail (float given)", () => {
    const issues = apply({ x: { type: "integer" } }, { x: 3.14 });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });

  test("integer — fail (string given)", () => {
    const issues = apply({ x: { type: "integer" } }, { x: "7" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });

  test("number — pass (integer)", () => {
    const issues = apply({ x: { type: "number" } }, { x: 7 });
    expect(issues).toHaveLength(0);
  });

  test("number — pass (float)", () => {
    const issues = apply({ x: { type: "number" } }, { x: 3.14 });
    expect(issues).toHaveLength(0);
  });

  test("number — fail (NaN)", () => {
    const issues = apply({ x: { type: "number" } }, { x: NaN });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });

  test("boolean — pass", () => {
    const issues = apply({ x: { type: "boolean" } }, { x: true });
    expect(issues).toHaveLength(0);
  });

  test("boolean — fail", () => {
    const issues = apply({ x: { type: "boolean" } }, { x: "true" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });

  test("date — pass (Date instance)", () => {
    const issues = apply({ x: { type: "date" } }, { x: new Date("2025-01-01") });
    expect(issues).toHaveLength(0);
  });

  test("date — fail (string given)", () => {
    const issues = apply({ x: { type: "date" } }, { x: "2025-01-01" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });

  test("date — fail (invalid Date — NaN)", () => {
    const issues = apply({ x: { type: "date" } }, { x: new Date("not-a-date") });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });

  test("array — pass", () => {
    const issues = apply({ x: { type: "array" } }, { x: [1, 2, 3] });
    expect(issues).toHaveLength(0);
  });

  test("array — fail", () => {
    const issues = apply({ x: { type: "array" } }, { x: "not-array" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("type-mismatch");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: required
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — required", () => {
  test("required: true — present → no issue", () => {
    const issues = apply({ x: { required: true } }, { x: "hello" });
    expect(issues).toHaveLength(0);
  });

  test("required: true — missing → required-missing", () => {
    const issues = apply({ x: { required: true } }, {});
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
    expect(issues[0].field).toBe("x");
  });

  test("required: true — null value → required-missing", () => {
    const issues = apply({ x: { required: true } }, { x: null });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("required: true — empty string → required-missing", () => {
    const issues = apply({ x: { required: true } }, { x: "" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("required: false — missing → no issue", () => {
    const issues = apply({ x: { required: false } }, {});
    expect(issues).toHaveLength(0);
  });

  test("not required, not present — skips other constraints", () => {
    const issues = apply({ x: { type: "string", enum: ["a", "b"] } }, {});
    expect(issues).toHaveLength(0);
  });

  test("required missing skips other constraint checks", () => {
    // If required and missing, only required-missing is emitted, not type-mismatch etc.
    const issues = apply(
      { x: { required: true, type: "string", enum: ["a", "b"] } },
      {},
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: enum
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — enum", () => {
  test("value in list → pass", () => {
    const issues = apply({ x: { enum: ["a", "b", "c"] } }, { x: "b" });
    expect(issues).toHaveLength(0);
  });

  test("value not in list → enum-violation", () => {
    const issues = apply({ x: { enum: ["a", "b"] } }, { x: "z" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("enum-violation");
    expect(issues[0].field).toBe("x");
  });

  test("numeric enum works", () => {
    const issues = apply({ x: { enum: [1, 2, 3] } }, { x: 2 });
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: pattern
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — pattern", () => {
  test("matching regex → pass", () => {
    const issues = apply({ x: { pattern: "^[a-z]+$" } }, { x: "hello" });
    expect(issues).toHaveLength(0);
  });

  test("non-matching regex → pattern-mismatch", () => {
    const issues = apply({ x: { pattern: "^[a-z]+$" } }, { x: "Hello123" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("pattern-mismatch");
  });

  test("pattern coerces value to string", () => {
    const issues = apply({ x: { pattern: "^42$" } }, { x: 42 });
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: min / max
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — min/max", () => {
  test("string length — min pass", () => {
    const issues = apply({ x: { type: "string", min: 3 } }, { x: "hello" });
    expect(issues).toHaveLength(0);
  });

  test("string length — min fail", () => {
    const issues = apply({ x: { type: "string", min: 10 } }, { x: "hi" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("min-violation");
    expect(issues[0].message).toContain("Length");
  });

  test("string length — max pass", () => {
    const issues = apply({ x: { type: "string", max: 10 } }, { x: "hello" });
    expect(issues).toHaveLength(0);
  });

  test("string length — max fail", () => {
    const issues = apply({ x: { type: "string", max: 3 } }, { x: "hello" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("max-violation");
    expect(issues[0].message).toContain("Length");
  });

  test("number value — min pass", () => {
    const issues = apply({ x: { type: "number", min: 1 } }, { x: 5 });
    expect(issues).toHaveLength(0);
  });

  test("number value — min fail", () => {
    const issues = apply({ x: { type: "number", min: 10 } }, { x: 3 });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("min-violation");
    expect(issues[0].message).toContain("Value");
  });

  test("number value — max pass", () => {
    const issues = apply({ x: { type: "number", max: 100 } }, { x: 50 });
    expect(issues).toHaveLength(0);
  });

  test("number value — max fail", () => {
    const issues = apply({ x: { type: "number", max: 10 } }, { x: 50 });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("max-violation");
    expect(issues[0].message).toContain("Value");
  });

  test("integer — min/max work on value", () => {
    expect(apply({ x: { type: "integer", min: 1, max: 100 } }, { x: 50 })).toHaveLength(0);
    expect(apply({ x: { type: "integer", min: 1 } }, { x: 0 })).toHaveLength(1);
    expect(apply({ x: { type: "integer", max: 100 } }, { x: 101 })).toHaveLength(1);
  });

  test("array count — min pass", () => {
    const issues = apply({ x: { type: "array", min: 2 } }, { x: [1, 2, 3] });
    expect(issues).toHaveLength(0);
  });

  test("array count — min fail", () => {
    const issues = apply({ x: { type: "array", min: 5 } }, { x: [1, 2] });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("min-violation");
    expect(issues[0].message).toContain("Count");
  });

  test("array count — max fail", () => {
    const issues = apply({ x: { type: "array", max: 2 } }, { x: [1, 2, 3, 4] });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("max-violation");
    expect(issues[0].message).toContain("Count");
  });

  test("no declared type but number value — falls back to value comparison", () => {
    const issues = apply({ x: { min: 10 } }, { x: 5 });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("min-violation");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: uniqueItems
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — uniqueItems", () => {
  test("unique items → pass", () => {
    const issues = apply({ x: { type: "array", uniqueItems: true } }, { x: ["a", "b", "c"] });
    expect(issues).toHaveLength(0);
  });

  test("duplicate items → unique-violation", () => {
    const issues = apply({ x: { type: "array", uniqueItems: true } }, { x: ["a", "b", "a"] });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("unique-violation");
  });

  test("uniqueItems: false → no check", () => {
    const issues = apply({ x: { type: "array", uniqueItems: false } }, { x: ["a", "a"] });
    expect(issues).toHaveLength(0);
  });

  test("non-array with uniqueItems → no issue (type check catches it)", () => {
    const issues = apply({ x: { uniqueItems: true } }, { x: "not-array" });
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: exists
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — exists", () => {
  test("file exists → pass", () => {
    const issues = apply(
      { x: { exists: true } },
      { x: "docs/readme.md" },
      { fileExists: () => true },
    );
    expect(issues).toHaveLength(0);
  });

  test("file does not exist → exists-missing", () => {
    const issues = apply(
      { x: { exists: true } },
      { x: "docs/missing.md" },
      { fileExists: () => false },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("exists-missing");
  });

  test("injectable resolver receives the path", () => {
    let receivedPath;
    apply(
      { x: { exists: true } },
      { x: "some/path.md" },
      { fileExists: (p) => { receivedPath = p; return true; } },
    );
    expect(receivedPath).toBe("some/path.md");
  });

  test("non-string value → no issue from exists", () => {
    const issues = apply(
      { x: { exists: true } },
      { x: 42 },
      { fileExists: () => false },
    );
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive: description (metadata only)
// ────────────────────────────────────────────────────────────────────────────

describe("primitive — description", () => {
  test("description emits nothing regardless of value", () => {
    const issues = apply(
      { x: { description: "This field tracks something" } },
      { x: "anything" },
    );
    expect(issues).toHaveLength(0);
  });

  test("description emits nothing even when value is missing", () => {
    const issues = apply(
      { x: { description: "Optional info" } },
      {},
    );
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `when` modifier — conditional gating
// ────────────────────────────────────────────────────────────────────────────

describe("when modifier — conditional gating", () => {
  test("when condition true → constraint runs", () => {
    const issues = apply(
      { x: { enum: { value: ["a", "b"], when: "y in ['yes']" } } },
      { x: "z", y: "yes" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("enum-violation");
  });

  test("when condition false → constraint skipped", () => {
    const issues = apply(
      { x: { enum: { value: ["a", "b"], when: "y in ['yes']" } } },
      { x: "z", y: "no" },
    );
    expect(issues).toHaveLength(0);
  });

  test("conditional required — when true and missing → required-missing", () => {
    const issues = apply(
      { x: { required: { when: "y in ['active']" } } },
      { y: "active" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("conditional required — when false → no issue even if missing", () => {
    const issues = apply(
      { x: { required: { when: "y in ['active']" } } },
      { y: "inactive" },
    );
    expect(issues).toHaveLength(0);
  });

  test("conditional required — when true and present → no issue", () => {
    const issues = apply(
      { x: { required: { when: "y in ['active']" } } },
      { x: "value", y: "active" },
    );
    expect(issues).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// severity / message overrides
// ────────────────────────────────────────────────────────────────────────────

describe("severity and message overrides", () => {
  test("severity override changes issue level", () => {
    const issues = apply(
      { x: { enum: { value: ["a", "b"], severity: "warning" } } },
      { x: "z" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });

  test("default severity is error", () => {
    const issues = apply(
      { x: { enum: ["a", "b"] } },
      { x: "z" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("error");
  });

  test("message override replaces default text", () => {
    const issues = apply(
      { x: { enum: { value: ["a", "b"], message: "Pick a or b please" } } },
      { x: "z" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("Pick a or b please");
  });

  test("severity override on required", () => {
    const issues = apply(
      { x: { required: { value: true, severity: "warning" } } },
      {},
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].error_type).toBe("required-missing");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Synthetic `$path` field
// ────────────────────────────────────────────────────────────────────────────

describe("synthetic $path field", () => {
  test("$path resolves from docMeta.repoRelativePath", () => {
    expect(SYNTHETIC_RESOLVERS.$path({ repoRelativePath: "docs/foo.md" })).toBe("docs/foo.md");
  });

  test("$path pattern — pass", () => {
    const issues = apply(
      { $path: { pattern: "^docs/.*\\.md$" } },
      {},
      { repoRelativePath: "docs/foo.md" },
    );
    expect(issues).toHaveLength(0);
  });

  test("$path pattern — fail", () => {
    const issues = apply(
      { $path: { pattern: "^docs/.*\\.md$" } },
      {},
      { repoRelativePath: "src/bar.js" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("pattern-mismatch");
    expect(issues[0].field).toBe("$path");
  });

  test("$path enum — pass", () => {
    const issues = apply(
      { $path: { enum: ["a.md", "b.md"] } },
      {},
      { repoRelativePath: "a.md" },
    );
    expect(issues).toHaveLength(0);
  });

  test("$path enum — fail", () => {
    const issues = apply(
      { $path: { enum: ["a.md", "b.md"] } },
      {},
      { repoRelativePath: "c.md" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("enum-violation");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Strict mode — undeclared fields
// ────────────────────────────────────────────────────────────────────────────

describe("strict mode", () => {
  test("undeclared key → undeclared-field issue", () => {
    const issues = applyStrict(
      { x: { type: "string" } },
      { x: "hello", extra: "oops" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("undeclared-field");
    expect(issues[0].field).toBe("extra");
  });

  test("all keys declared → no issues", () => {
    const issues = applyStrict(
      { x: { type: "string" }, y: { type: "number" } },
      { x: "hello", y: 5 },
    );
    expect(issues).toHaveLength(0);
  });

  test("non-strict mode ignores undeclared keys", () => {
    const issues = apply(
      { x: { type: "string" } },
      { x: "hello", extra: "fine" },
    );
    expect(issues).toHaveLength(0);
  });

  test("multiple undeclared keys → one issue per key", () => {
    const issues = applyStrict(
      { x: { type: "string" } },
      { x: "hello", a: 1, b: 2 },
    );
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.error_type === "undeclared-field")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dot-path field access
// ────────────────────────────────────────────────────────────────────────────

describe("dot-path field access", () => {
  test("nested field resolves via dot path", () => {
    const issues = apply(
      { "a.b.c": { type: "string" } },
      { a: { b: { c: "hello" } } },
    );
    expect(issues).toHaveLength(0);
  });

  test("nested field missing → skips (not required)", () => {
    const issues = apply(
      { "a.b.c": { type: "string" } },
      { a: {} },
    );
    expect(issues).toHaveLength(0);
  });

  test("nested field required and missing → required-missing", () => {
    const issues = apply(
      { "a.b": { required: true } },
      { a: {} },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
    expect(issues[0].field).toBe("a.b");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Shorthand vs expanded form
// ────────────────────────────────────────────────────────────────────────────

describe("shorthand vs expanded form", () => {
  test("shorthand enum: [a, b] works", () => {
    const issues = apply({ x: { enum: ["a", "b"] } }, { x: "c" });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("enum-violation");
  });

  test("expanded enum: { value: [a, b], severity: warning } works", () => {
    const issues = apply(
      { x: { enum: { value: ["a", "b"], severity: "warning" } } },
      { x: "c" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
    expect(issues[0].error_type).toBe("enum-violation");
  });

  test("shorthand required: true works", () => {
    const issues = apply({ x: { required: true } }, {});
    expect(issues).toHaveLength(1);
  });

  test("expanded required: { when: ... } works", () => {
    const issues = apply(
      { x: { required: { when: "y in ['yes']" } } },
      { y: "yes" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("shorthand min: 5 works", () => {
    const issues = apply({ x: { type: "number", min: 5 } }, { x: 2 });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("min-violation");
  });

  test("expanded min: { value: 5, severity: warning } works", () => {
    const issues = apply(
      { x: { type: "number", min: { value: 5, severity: "warning" } } },
      { x: 2 },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe("warning");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Multiple constraints on one field
// ────────────────────────────────────────────────────────────────────────────

describe("multiple constraints on one field", () => {
  test("type + enum — both checked", () => {
    // Value is a string (passes type) but not in enum
    const issues = apply(
      { x: { type: "string", enum: ["a", "b"] } },
      { x: "c" },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("enum-violation");
  });

  test("type + min + max — all pass", () => {
    const issues = apply(
      { x: { type: "integer", min: 1, max: 100 } },
      { x: 50 },
    );
    expect(issues).toHaveLength(0);
  });

  test("type + min — type fails, min also checked", () => {
    // string given where integer expected, min also fails
    const issues = apply(
      { x: { type: "integer", min: 1 } },
      { x: "hello" },
    );
    // type-mismatch is emitted; min may or may not emit (depends on resolveMinMaxTarget)
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.error_type === "type-mismatch")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Issue shape
// ────────────────────────────────────────────────────────────────────────────

describe("issue shape", () => {
  test("issue has level, field, message, error_type", () => {
    const issues = apply({ x: { required: true } }, {});
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i).toHaveProperty("level");
    expect(i).toHaveProperty("field");
    expect(i).toHaveProperty("message");
    expect(i).toHaveProperty("error_type");
    expect(typeof i.level).toBe("string");
    expect(typeof i.field).toBe("string");
    expect(typeof i.message).toBe("string");
    expect(typeof i.error_type).toBe("string");
  });

  test("issue may have fix", () => {
    const issues = apply({ x: { required: true } }, {});
    expect(issues[0]).toHaveProperty("fix");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("empty fields schema → no issues", () => {
    const issues = apply({}, { x: "anything" });
    expect(issues).toHaveLength(0);
  });

  test("null fields schema → no issues", () => {
    const issues = applyFieldSchema({ fields: null }, { x: 1 }, {});
    expect(issues).toHaveLength(0);
  });

  test("null frontmatter → handles gracefully", () => {
    const issues = apply({ x: { required: true } }, null);
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("required-missing");
  });

  test("undefined docMeta → no crash", () => {
    const issues = applyFieldSchema({ fields: { x: { type: "string" } } }, { x: "hi" }, undefined);
    expect(issues).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// validateTemplateSchema — meta-validation (spec §8)
// ════════════════════════════════════════════════════════════════════════════

describe("validateTemplateSchema", () => {
  test("valid schema → no issues", () => {
    const issues = validateTemplateSchema({
      x: { type: "string", required: true, enum: ["a", "b"], pattern: "^[a-b]$" },
      y: { type: "integer", min: 1, max: 100 },
      z: { type: "array", uniqueItems: true },
      w: { description: "Just info" },
    });
    expect(issues).toHaveLength(0);
  });

  test("unknown primitive key → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { type: "string", foobar: true },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
    expect(issues[0].message).toContain("foobar");
  });

  test("bad type value → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { type: "uuid" },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
    expect(issues[0].message).toContain("uuid");
  });

  test("non-compiling regex → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { pattern: "[invalid(" },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.message.includes("regex") || i.message.includes("pattern"))).toBe(true);
  });

  test("enum not an array → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { enum: "not-an-array" },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
  });

  test("enum empty array → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { enum: [] },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
  });

  test("min not a number → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { type: "string", min: "five" },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.message.includes("min") && i.message.includes("number"))).toBe(true);
  });

  test("max not a number → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { type: "number", max: true },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.message.includes("max") && i.message.includes("number"))).toBe(true);
  });

  test("malformed when string → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { required: { when: "not valid dsl @@" } },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
    expect(issues[0].message).toContain("when");
  });

  test("malformed when on non-required constraint → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { enum: { value: ["a"], when: "@@invalid" } },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
  });

  test("synthetic $ field using disallowed primitive → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      $path: { type: "string" },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
    expect(issues[0].message).toContain("$path");
  });

  test("synthetic $ field using pattern → no issue", () => {
    const issues = validateTemplateSchema({
      $path: { pattern: "^docs/" },
    });
    expect(issues).toHaveLength(0);
  });

  test("synthetic $ field using enum → no issue", () => {
    const issues = validateTemplateSchema({
      $path: { enum: ["a.md", "b.md"] },
    });
    expect(issues).toHaveLength(0);
  });

  test("synthetic $ field using description → no issue", () => {
    const issues = validateTemplateSchema({
      $path: { description: "Document path" },
    });
    expect(issues).toHaveLength(0);
  });

  test("min without type → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { min: 5 },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.message.includes("type"))).toBe(true);
  });

  test("max without type → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: { max: 10 },
    });
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.message.includes("type"))).toBe(true);
  });

  test("field spec not an object → template-schema-invalid", () => {
    const issues = validateTemplateSchema({
      x: "just a string",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].error_type).toBe("template-schema-invalid");
  });

  test("null schema → no issues (graceful)", () => {
    const issues = validateTemplateSchema(null);
    expect(issues).toHaveLength(0);
  });

  test("never throws — always returns issues array", () => {
    // Even extremely malformed input should not throw
    expect(() => validateTemplateSchema(undefined)).not.toThrow();
    expect(() => validateTemplateSchema(42)).not.toThrow();
    expect(() => validateTemplateSchema({ x: { pattern: "[(" } })).not.toThrow();
  });

  test("valid when string with field reference → no issue", () => {
    // `conditionalEvaluate("y in ['a']", {})` returns false (missing field) but does NOT throw
    const issues = validateTemplateSchema({
      x: { required: { when: "y in ['a']" } },
    });
    expect(issues).toHaveLength(0);
  });
});
