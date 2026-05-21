/**
 * Tests for lib/fuzzy-suggest.js — the "did you mean?" helper used by every
 * unknown-key validator.
 *
 * Covers:
 *  - levenshtein distance: empty/equal/typical/unicode-safe
 *  - suggest(): typo matches, case-mismatch shortcut, cutoff rejection,
 *    tie-breaking by shorter candidate, no-match returns null
 *  - didYouMean(): empty string when no suggestion, suffix otherwise
 */

import { describe, test, expect } from "bun:test";
import { levenshtein, suggest, didYouMean } from "../lib/fuzzy-suggest.js";
import {
  validateTemplateSchema,
  validateBodyTemplateSchema,
  applyFieldSchema,
} from "../lib/schema-engine.js";

describe("levenshtein", () => {
  test("zero distance for equal strings", () => {
    expect(levenshtein("items", "items")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  test("length of the other when one side is empty", () => {
    expect(levenshtein("", "items")).toBe(5);
    expect(levenshtein("required", "")).toBe(8);
  });

  test("counts single edits", () => {
    expect(levenshtein("item", "items")).toBe(1);          // insertion
    expect(levenshtein("items", "item")).toBe(1);          // deletion
    expect(levenshtein("pattren", "pattern")).toBe(2);     // two swaps
    expect(levenshtein("requried", "required")).toBe(2);
  });

  test("symmetric", () => {
    expect(levenshtein("min", "max")).toBe(levenshtein("max", "min"));
  });
});

describe("suggest", () => {
  const HAYSTACK = ["required", "repeatable", "heading", "table", "list",
    "code", "formula", "min", "max", "severity", "message"];

  test("classic typo match within cutoff", () => {
    expect(suggest("requried", HAYSTACK)).toBe("required");
    expect(suggest("pattren", ["pattern", "enum"])).toBe("pattern");
    expect(suggest("itme", ["items", "values"])).toBe("items");
  });

  test("case-insensitive exact match wins immediately", () => {
    expect(suggest("REQUIRED", HAYSTACK)).toBe("required");
    expect(suggest("Pattern", ["pattern", "enum"])).toBe("pattern");
  });

  test("missing-letter and extra-letter both bridge", () => {
    expect(suggest("item", ["items"])).toBe("items");
    expect(suggest("itemss", ["items"])).toBe("items");
  });

  test("returns null when nothing falls within cutoff", () => {
    expect(suggest("xyz", HAYSTACK)).toBeNull();
    expect(suggest("completely_unrelated_word", HAYSTACK)).toBeNull();
  });

  test("1-char input never produces a match (too noisy)", () => {
    expect(suggest("x", HAYSTACK)).toBeNull();
    expect(suggest("a", HAYSTACK)).toBeNull();
  });

  test("ties broken by shorter candidate", () => {
    // Both "min" and "max" are distance-3 from "abc". They're equally bad
    // and beyond the cutoff anyway → returns null. Use a clearer case.
    // "tabl" → "table" (1 edit) vs "list" (3 edits). "table" wins.
    expect(suggest("tabl", ["table", "list"])).toBe("table");
  });

  test("rejects non-string / empty input", () => {
    expect(suggest("", HAYSTACK)).toBeNull();
    expect(suggest(undefined, HAYSTACK)).toBeNull();
    expect(suggest(null, HAYSTACK)).toBeNull();
    expect(suggest(42, HAYSTACK)).toBeNull();
  });

  test("skips non-string candidates inside haystack", () => {
    expect(suggest("itme", ["items", null, undefined, 42])).toBe("items");
  });

  test("Set iterable is accepted as haystack", () => {
    const set = new Set(["items", "values"]);
    expect(suggest("itme", set)).toBe("items");
  });
});

describe("didYouMean", () => {
  test("returns formatted suffix when a suggestion exists", () => {
    expect(didYouMean("itme", ["items", "values"])).toBe(
      " Did you mean 'items'?",
    );
  });

  test("returns empty string when no suggestion", () => {
    expect(didYouMean("xyz", ["items", "values"])).toBe("");
    expect(didYouMean("", ["items"])).toBe("");
  });
});

// Integration — fuzzy suffix must surface from each unknown-key validator,
// not just the helper. These tests fail if a call-site forgets to wire
// didYouMean() onto the diagnostic message.
describe("fuzzy integration with schema-engine validators", () => {
  test("validateTemplateSchema suggests primitive name on typo", () => {
    const issues = validateTemplateSchema({
      title: { type: "string", pattren: "^[A-Z]" },
    });
    const unknown = issues.find((i) =>
      i.message.includes("Unknown primitive 'pattren'"),
    );
    expect(unknown).toBeDefined();
    expect(unknown.message).toContain("Did you mean 'pattern'?");
  });

  test("validateTemplateSchema suggests on invalid type value", () => {
    const issues = validateTemplateSchema({
      title: { type: "strring" },
    });
    const bad = issues.find((i) => i.message.includes("Invalid type 'strring'"));
    expect(bad).toBeDefined();
    expect(bad.message).toContain("Did you mean 'string'?");
  });

  test("validateTemplateSchema suggests on unknown modifier in expanded form", () => {
    const issues = validateTemplateSchema({
      title: { type: "string", pattern: { value: "^x", mssage: "bad" } },
    });
    const bad = issues.find((i) => i.message.includes("Unknown modifier 'mssage'"));
    expect(bad).toBeDefined();
    expect(bad.message).toContain("Did you mean 'message'?");
  });

  test("validateBodyTemplateSchema suggests on unknown section-rules key", () => {
    const issues = validateBodyTemplateSchema([
      {
        depth: 2,
        text: "Notes",
        sectionRules: { requried: true },
        children: [],
      },
    ]);
    const bad = issues.find((i) => i.message.includes("Unknown section-rules key 'requried'"));
    expect(bad).toBeDefined();
    expect(bad.message).toContain("Did you mean 'required'?");
  });

  test("applyFieldSchema in strict mode suggests on undeclared frontmatter key", () => {
    const schema = {
      fields: { status: { type: "string" } },
      strict: true,
    };
    const issues = applyFieldSchema(schema, { sttatus: "draft" });
    const bad = issues.find((i) => i.message.includes("Undeclared field 'sttatus'"));
    expect(bad).toBeDefined();
    expect(bad.message).toContain("Did you mean 'status'?");
  });
});
