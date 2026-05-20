/**
 * Tests for the arithmetic/comparison expression evaluator. Pure tests — no I/O.
 *
 * Covers: operator precedence, parentheses, every operator, division,
 * epsilon equality, malformed input → throws, identifier resolution,
 * missing identifiers, unary minus, parse-only mode.
 */

import { describe, test, expect } from "bun:test";
import { evaluate, parse } from "../lib/expression-eval.js";

// ────────────────────────────────────────────────────────────────────────────
// Arithmetic — addition and subtraction
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — addition and subtraction", () => {
  test("simple addition", () => {
    expect(evaluate("a + b", { a: 3, b: 5 })).toBe(8);
  });

  test("simple subtraction", () => {
    expect(evaluate("a - b", { a: 10, b: 3 })).toBe(7);
  });

  test("chained addition", () => {
    expect(evaluate("a + b + c", { a: 1, b: 2, c: 3 })).toBe(6);
  });

  test("mixed add and subtract", () => {
    expect(evaluate("a + b - c", { a: 10, b: 5, c: 3 })).toBe(12);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Arithmetic — multiplication and division
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — multiplication and division", () => {
  test("simple multiplication", () => {
    expect(evaluate("a * b", { a: 4, b: 7 })).toBe(28);
  });

  test("simple division", () => {
    expect(evaluate("a / b", { a: 20, b: 4 })).toBe(5);
  });

  test("division by zero yields Infinity", () => {
    expect(evaluate("a / b", { a: 1, b: 0 })).toBe(Infinity);
  });

  test("zero divided by zero yields NaN", () => {
    expect(evaluate("a / b", { a: 0, b: 0 })).toBeNaN();
  });

  test("chained multiplication", () => {
    expect(evaluate("a * b * c", { a: 2, b: 3, c: 4 })).toBe(24);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Operator precedence
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — operator precedence", () => {
  test("multiplication before addition: a + b * c = a + (b * c)", () => {
    // 2 + 3 * 4 = 2 + 12 = 14 (not 20)
    expect(evaluate("a + b * c", { a: 2, b: 3, c: 4 })).toBe(14);
  });

  test("division before subtraction: a - b / c = a - (b / c)", () => {
    // 10 - 6 / 2 = 10 - 3 = 7 (not 2)
    expect(evaluate("a - b / c", { a: 10, b: 6, c: 2 })).toBe(7);
  });

  test("comparison has lowest precedence: a + b == c", () => {
    expect(evaluate("a + b == c", { a: 3, b: 4, c: 7 })).toBe(true);
    expect(evaluate("a + b == c", { a: 3, b: 4, c: 8 })).toBe(false);
  });

  test("complex: a * b + c == d", () => {
    // 2 * 3 + 4 = 10
    expect(evaluate("a * b + c == d", { a: 2, b: 3, c: 4, d: 10 })).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Parentheses
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — parentheses", () => {
  test("parentheses override precedence: (a + b) * c", () => {
    // (2 + 3) * 4 = 20 (not 14)
    expect(evaluate("(a + b) * c", { a: 2, b: 3, c: 4 })).toBe(20);
  });

  test("nested parentheses: ((a + b)) * c", () => {
    expect(evaluate("((a + b)) * c", { a: 2, b: 3, c: 4 })).toBe(20);
  });

  test("parentheses around comparison operand: (a + b) == c", () => {
    expect(evaluate("(a + b) == c", { a: 1, b: 2, c: 3 })).toBe(true);
  });

  test("parentheses in divisor: a / (b + c)", () => {
    // 12 / (2 + 4) = 2
    expect(evaluate("a / (b + c)", { a: 12, b: 2, c: 4 })).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Comparison operators
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — comparison operators", () => {
  test("== (equal)", () => {
    expect(evaluate("a == b", { a: 5, b: 5 })).toBe(true);
    expect(evaluate("a == b", { a: 5, b: 6 })).toBe(false);
  });

  test("!= (not equal)", () => {
    expect(evaluate("a != b", { a: 5, b: 6 })).toBe(true);
    expect(evaluate("a != b", { a: 5, b: 5 })).toBe(false);
  });

  test("< (less than)", () => {
    expect(evaluate("a < b", { a: 3, b: 5 })).toBe(true);
    expect(evaluate("a < b", { a: 5, b: 5 })).toBe(false);
    expect(evaluate("a < b", { a: 7, b: 5 })).toBe(false);
  });

  test("> (greater than)", () => {
    expect(evaluate("a > b", { a: 7, b: 5 })).toBe(true);
    expect(evaluate("a > b", { a: 5, b: 5 })).toBe(false);
    expect(evaluate("a > b", { a: 3, b: 5 })).toBe(false);
  });

  test("<= (less than or equal)", () => {
    expect(evaluate("a <= b", { a: 3, b: 5 })).toBe(true);
    expect(evaluate("a <= b", { a: 5, b: 5 })).toBe(true);
    expect(evaluate("a <= b", { a: 7, b: 5 })).toBe(false);
  });

  test(">= (greater than or equal)", () => {
    expect(evaluate("a >= b", { a: 7, b: 5 })).toBe(true);
    expect(evaluate("a >= b", { a: 5, b: 5 })).toBe(true);
    expect(evaluate("a >= b", { a: 3, b: 5 })).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Epsilon tolerance for == and !=
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — epsilon tolerance (1e-9)", () => {
  test("floating-point arithmetic: 0.1 + 0.2 == 0.3", () => {
    // In JS: 0.1 + 0.2 = 0.30000000000000004
    expect(evaluate("a + b == c", { a: 0.1, b: 0.2, c: 0.3 })).toBe(true);
  });

  test("epsilon boundary: difference exactly at 1e-9 is still not-equal", () => {
    // 1e-9 is NOT less than 1e-9, so values exactly 1e-9 apart are not equal
    expect(evaluate("a == b", { a: 0, b: 1e-9 })).toBe(false);
  });

  test("epsilon boundary: difference just under 1e-9 is equal", () => {
    expect(evaluate("a == b", { a: 0, b: 5e-10 })).toBe(true);
  });

  test("!= respects epsilon: nearly-equal values are not !=", () => {
    expect(evaluate("a != b", { a: 0.1, b: 0.1 + 1e-12 })).toBe(false);
  });

  test("!= with genuinely different values", () => {
    expect(evaluate("a != b", { a: 1, b: 2 })).toBe(true);
  });

  test("RICE-style formula: score == reach * impact * confidence / effort", () => {
    expect(
      evaluate("score == reach * impact * confidence / effort", {
        score: 6,
        reach: 8,
        impact: 3,
        confidence: 1,
        effort: 4,
      }),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Unary minus
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — unary minus", () => {
  test("negative identifier", () => {
    expect(evaluate("-a", { a: 5 })).toBe(-5);
  });

  test("negative number literal", () => {
    expect(evaluate("-3 + a", { a: 10 })).toBe(7);
  });

  test("double negative via parentheses", () => {
    expect(evaluate("-(-a)", { a: 5 })).toBe(5);
  });

  test("negative in multiplication", () => {
    expect(evaluate("-a * b", { a: 3, b: 4 })).toBe(-12);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Number literals
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — number literals", () => {
  test("integer literal", () => {
    expect(evaluate("a + 10", { a: 5 })).toBe(15);
  });

  test("decimal literal", () => {
    expect(evaluate("a + 1.5", { a: 3 })).toBe(4.5);
  });

  test("pure numeric expression (no identifiers)", () => {
    expect(evaluate("2 + 3 * 4", {})).toBe(14);
  });

  test("comparison with literals", () => {
    expect(evaluate("a > 5", { a: 10 })).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Identifier resolution
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — identifier resolution", () => {
  test("single identifier returns its value", () => {
    expect(evaluate("x", { x: 42 })).toBe(42);
  });

  test("missing identifier throws", () => {
    expect(() => evaluate("x", {})).toThrow("Unknown identifier 'x'");
  });

  test("missing identifier in expression throws", () => {
    expect(() => evaluate("a + b", { a: 1 })).toThrow("Unknown identifier 'b'");
  });

  test("underscore in identifier name", () => {
    expect(evaluate("my_var + 1", { my_var: 9 })).toBe(10);
  });

  test("identifier with digits", () => {
    expect(evaluate("x1 + x2", { x1: 3, x2: 7 })).toBe(10);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parse() — syntax-only validation (returns AST, no evaluation)
// ────────────────────────────────────────────────────────────────────────────

describe("parse — syntax validation", () => {
  test("valid expression returns an AST object", () => {
    const ast = parse("a + b * c");
    expect(ast).toBeDefined();
    expect(typeof ast).toBe("object");
  });

  test("valid comparison returns AST", () => {
    const ast = parse("x == y + z");
    expect(ast.type).toBe("compare");
  });

  test("malformed expression throws", () => {
    expect(() => parse("+ +")).toThrow();
  });

  test("empty expression throws", () => {
    expect(() => parse("")).toThrow();
  });

  test("trailing tokens throw", () => {
    expect(() => parse("a + b c")).toThrow();
  });

  test("unmatched parenthesis throws", () => {
    expect(() => parse("(a + b")).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error cases — malformed expressions must throw
// ────────────────────────────────────────────────────────────────────────────

describe("evaluate — error cases", () => {
  test("empty expression throws", () => {
    expect(() => evaluate("", {})).toThrow();
  });

  test("just an operator throws", () => {
    expect(() => evaluate("+", {})).toThrow();
  });

  test("trailing operator throws", () => {
    expect(() => evaluate("a +", { a: 1 })).toThrow();
  });

  test("double operator throws", () => {
    expect(() => evaluate("a ++ b", { a: 1, b: 2 })).toThrow();
  });

  test("unmatched opening parenthesis throws", () => {
    expect(() => evaluate("(a + b", { a: 1, b: 2 })).toThrow();
  });

  test("unmatched closing parenthesis throws", () => {
    expect(() => evaluate("a + b)", { a: 1, b: 2 })).toThrow();
  });

  test("unknown character throws", () => {
    expect(() => evaluate("a @ b", { a: 1, b: 2 })).toThrow();
  });

  test("string literals are not supported (throws)", () => {
    expect(() => evaluate("'hello'", {})).toThrow();
  });

  test("empty parentheses throw", () => {
    expect(() => evaluate("()", {})).toThrow();
  });
});
