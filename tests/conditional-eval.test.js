/**
 * Tests for the conditional-rule DSL evaluator. Pure tests — no I/O.
 *
 * Anchored to expressions actually used in templates/prd-template.md so that
 * if grammar drift later breaks template authoring, these tests fire first.
 */

import { describe, test, expect } from "bun:test";
import {
  evaluate,
  getField,
} from "../lib/conditional-eval.js";

// ────────────────────────────────────────────────────────────────────────────
// `in` membership
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — single 'in' clause", () => {
  test("field present in list → true", () => {
    expect(evaluate("status in ['draft']", { status: "draft" })).toBe(true);
  });

  test("field not in list → false", () => {
    expect(evaluate("status in ['draft']", { status: "review" })).toBe(false);
  });

  test("multi-value list — membership check works", () => {
    expect(
      evaluate("prd_type in ['feature', 'enhancement']", {
        prd_type: "enhancement",
      }),
    ).toBe(true);
  });

  test("missing field → false", () => {
    expect(evaluate("status in ['draft']", {})).toBe(false);
  });

  test("empty list → always false", () => {
    expect(evaluate("status in []", { status: "draft" })).toBe(false);
  });

  test("double-quoted strings work the same as single-quoted", () => {
    expect(evaluate('status in ["draft"]', { status: "draft" })).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `not in` membership
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — 'not in' clause", () => {
  test("field NOT in list → true", () => {
    expect(evaluate("status not in ['draft']", { status: "review" })).toBe(true);
  });

  test("field in list → false", () => {
    expect(evaluate("status not in ['draft']", { status: "draft" })).toBe(false);
  });

  test("missing field → true (undefined is not in any list of strings)", () => {
    expect(evaluate("status not in ['draft']", {})).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Boolean composition + precedence
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — boolean composition", () => {
  test("AND — both true", () => {
    expect(
      evaluate("a in ['x'] and b in ['y']", { a: "x", b: "y" }),
    ).toBe(true);
  });

  test("AND — first false", () => {
    expect(
      evaluate("a in ['x'] and b in ['y']", { a: "z", b: "y" }),
    ).toBe(false);
  });

  test("AND — second false", () => {
    expect(
      evaluate("a in ['x'] and b in ['y']", { a: "x", b: "z" }),
    ).toBe(false);
  });

  test("OR — left true short-circuits", () => {
    expect(
      evaluate("a in ['x'] or b in ['y']", { a: "x", b: "z" }),
    ).toBe(true);
  });

  test("OR — right true", () => {
    expect(
      evaluate("a in ['x'] or b in ['y']", { a: "z", b: "y" }),
    ).toBe(true);
  });

  test("OR — both false", () => {
    expect(
      evaluate("a in ['x'] or b in ['y']", { a: "z", b: "q" }),
    ).toBe(false);
  });

  test("AND has higher precedence than OR (a or b and c → a or (b and c))", () => {
    // (b and c) false, a true → result true
    expect(
      evaluate("a in ['x'] or b in ['y'] and c in ['z']", {
        a: "x",
        b: "y",
        c: "q",
      }),
    ).toBe(true);

    // a false, (b and c): b true, c false → false → result false
    expect(
      evaluate("a in ['x'] or b in ['y'] and c in ['z']", {
        a: "q",
        b: "y",
        c: "q",
      }),
    ).toBe(false);

    // a false, (b and c): both true → result true
    expect(
      evaluate("a in ['x'] or b in ['y'] and c in ['z']", {
        a: "q",
        b: "y",
        c: "z",
      }),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real expressions copied verbatim from templates/prd-template.md v3.1.0
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — real PRD-template expressions", () => {
  const COND_USER_STORIES =
    "prd_type in ['feature', 'enhancement']";

  const COND_TARGET_SHIP =
    "prd_type in ['feature', 'enhancement', 'sunset', 'hotfix'] and status not in ['draft', 'review']";

  const COND_SHIPPED_AT =
    "status in ['shipped', 'betting', 'graduated', 'reverted', 'killed', 'deprecated']";

  const COND_VERDICT =
    "status in ['graduated', 'reverted', 'killed']";

  test("user-stories rule fires only for feature/enhancement", () => {
    expect(evaluate(COND_USER_STORIES, { prd_type: "feature" })).toBe(true);
    expect(evaluate(COND_USER_STORIES, { prd_type: "enhancement" })).toBe(true);
    expect(evaluate(COND_USER_STORIES, { prd_type: "hotfix" })).toBe(false);
    expect(evaluate(COND_USER_STORIES, { prd_type: "refactor" })).toBe(false);
  });

  test("target-ship rule needs the right prd_type AND a post-review status", () => {
    expect(
      evaluate(COND_TARGET_SHIP, { prd_type: "feature", status: "approved" }),
    ).toBe(true);
    expect(
      evaluate(COND_TARGET_SHIP, { prd_type: "feature", status: "draft" }),
    ).toBe(false);
    expect(
      evaluate(COND_TARGET_SHIP, { prd_type: "refactor", status: "approved" }),
    ).toBe(false);
    expect(
      evaluate(COND_TARGET_SHIP, { prd_type: "hotfix", status: "review" }),
    ).toBe(false);
  });

  test("shipped_at rule fires for any status from shipped onward", () => {
    for (const s of [
      "shipped",
      "betting",
      "graduated",
      "reverted",
      "killed",
      "deprecated",
    ]) {
      expect(evaluate(COND_SHIPPED_AT, { status: s })).toBe(true);
    }
    for (const s of ["draft", "review", "approved", "in_progress"]) {
      expect(evaluate(COND_SHIPPED_AT, { status: s })).toBe(false);
    }
  });

  test("verdict rule fires only at terminal post-betting states", () => {
    expect(evaluate(COND_VERDICT, { status: "graduated" })).toBe(true);
    expect(evaluate(COND_VERDICT, { status: "reverted" })).toBe(true);
    expect(evaluate(COND_VERDICT, { status: "killed" })).toBe(true);
    expect(evaluate(COND_VERDICT, { status: "betting" })).toBe(false);
    expect(evaluate(COND_VERDICT, { status: "shipped" })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Nested field access
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — nested field access", () => {
  test("dotted path resolves into nested objects", () => {
    expect(
      evaluate("relationships.kind in ['parent']", {
        relationships: { kind: "parent" },
      }),
    ).toBe(true);
  });

  test("missing intermediate object → false (does not throw)", () => {
    expect(evaluate("relationships.kind in ['parent']", {})).toBe(false);
  });

  test("deep nesting (a.b.c) works", () => {
    expect(
      evaluate("a.b.c in ['x']", { a: { b: { c: "x" } } }),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error cases — malformed expressions must throw, not silently misbehave
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — error cases", () => {
  test("unterminated string", () => {
    expect(() => evaluate("status in ['draft", {})).toThrow();
  });

  test("missing closing bracket", () => {
    expect(() => evaluate("status in ['draft'", {})).toThrow();
  });

  test("missing operator", () => {
    expect(() => evaluate("status ['draft']", {})).toThrow();
  });

  test("trailing tokens", () => {
    expect(() => evaluate("status in ['draft'] foo", {})).toThrow();
  });

  test("unknown character", () => {
    expect(() => evaluate("status @ ['draft']", {})).toThrow();
  });

  test("empty expression", () => {
    expect(() => evaluate("", {})).toThrow();
  });

  test("'not' without 'in'", () => {
    expect(() => evaluate("status not ['draft']", {})).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getField helper
// ────────────────────────────────────────────────────────────────────────────

describe("getField helper", () => {
  test("simple field", () => {
    expect(getField({ a: 1 }, "a")).toBe(1);
  });

  test("nested path", () => {
    expect(getField({ a: { b: { c: "x" } } }, "a.b.c")).toBe("x");
  });

  test("missing intermediate returns undefined (does not throw)", () => {
    expect(getField({ a: {} }, "a.b.c")).toBeUndefined();
  });

  test("null/undefined object returns undefined", () => {
    expect(getField(null, "a.b")).toBeUndefined();
    expect(getField(undefined, "a")).toBeUndefined();
  });
});
