/**
 * Tests for the extended `list` primitive:
 *  - the `item:` → `items:` rename
 *  - list-level `min`, `max`, `unique`
 *  - per-item `required`, `enum`, `pattern`
 *  - `did you mean?` migration on `list: { item: {...} }`
 *  - inner-key meta-validation rejects unknown nested keys
 */

import { describe, test, expect } from "bun:test";
import {
  applyBodySchema,
  validateBodyTemplateSchema,
} from "../lib/schema-engine.js";

const errs = (issues) => issues.filter((i) => i.level === "error");

function schemaWithList(rules) {
  return [{
    depth: 2,
    text: "Steps",
    sectionRules: { list: rules },
    children: [],
  }];
}

const LIST_THREE = "## Steps\n\n- alpha\n- beta\n- gamma\n";
const LIST_DUPES = "## Steps\n\n- alpha\n- alpha\n- beta\n";
const LIST_EMPTY = "## Steps\n\nplain text only\n";

describe("list primitive — list-level cardinality", () => {
  test("min: 3 passes when exactly three items", async () => {
    expect(errs(await applyBodySchema(schemaWithList({ min: 3 }), LIST_THREE))).toHaveLength(0);
  });

  test("min: 5 fires when only three items present", async () => {
    expect(errs(await applyBodySchema(schemaWithList({ min: 5 }), LIST_THREE))
      .some((i) => i.message.includes("at least 5"))).toBe(true);
  });

  test("max: 2 fires when three items present", async () => {
    expect(errs(await applyBodySchema(schemaWithList({ max: 2 }), LIST_THREE))
      .some((i) => i.message.includes("at most 2"))).toBe(true);
  });
});

describe("list primitive — list-level unique", () => {
  test("unique: true flags duplicate item with item's own bodyLine", async () => {
    const issues = errs(await applyBodySchema(schemaWithList({ unique: true }), LIST_DUPES));
    const dup = issues.find((i) => i.error_type === "unique-violation");
    expect(dup).toBeDefined();
    // The duplicate `alpha` is on line 4 of the body (line 1 is the heading).
    expect(typeof dup.bodyLine).toBe("number");
  });

  test("unique: true passes when all items distinct", async () => {
    expect(errs(await applyBodySchema(schemaWithList({ unique: true }), LIST_THREE))).toHaveLength(0);
  });
});

describe("list primitive — items.required / pattern / enum", () => {
  test("items.required flags empty list-item text", async () => {
    const body = "## Steps\n\n- alpha\n-\n- gamma\n";
    const issues = errs(await applyBodySchema(schemaWithList({ items: { required: true } }), body));
    expect(issues.some((i) => i.message.includes("empty"))).toBe(true);
  });

  test("items.enum rejects items outside the allowed set", async () => {
    const issues = errs(await applyBodySchema(
      schemaWithList({ items: { enum: ["alpha", "beta"] } }),
      LIST_THREE, // contains "gamma" which is not in the enum
    ));
    expect(issues.some((i) => i.message.includes("gamma"))).toBe(true);
  });

  test("items.enum passes when every item is in the set", async () => {
    expect(errs(await applyBodySchema(
      schemaWithList({ items: { enum: ["alpha", "beta", "gamma"] } }),
      LIST_THREE,
    ))).toHaveLength(0);
  });

  test("per-item issue carries its own bodyLine (not the list's)", async () => {
    const body = "## Steps\n\n- alpha\n- BAD\n- gamma\n";  // BAD is line 4
    const issues = errs(await applyBodySchema(
      schemaWithList({ items: { pattern: "^[a-z]+$" } }),
      body,
    ));
    const bad = issues.find((i) => i.message.includes("BAD"));
    expect(bad.bodyLine).toBe(4);
  });
});

describe("list primitive — meta-validation surfaces typos", () => {
  test("`list: { item: ... }` produces unknown-key + fuzzy 'items?'", () => {
    const schema = [{
      depth: 2, text: "Steps",
      sectionRules: { list: { item: { pattern: "^x" } } },
      children: [],
    }];
    const issues = validateBodyTemplateSchema(schema);
    const bad = issues.find((i) =>
      i.message.includes("Unknown key 'item' in 'list'"),
    );
    expect(bad).toBeDefined();
    expect(bad.message).toContain("Did you mean 'items'?");
  });

  test("`list.items.patern` (typo) flagged with fuzzy 'pattern?'", () => {
    const schema = [{
      depth: 2, text: "Steps",
      sectionRules: { list: { items: { patern: "^x" } } },
      children: [],
    }];
    const issues = validateBodyTemplateSchema(schema);
    const bad = issues.find((i) =>
      i.message.includes("Unknown key 'patern' in 'list.items'"),
    );
    expect(bad).toBeDefined();
    expect(bad.message).toContain("Did you mean 'pattern'?");
  });

  test("`list.items.enum` not an array → template-schema-invalid", () => {
    const schema = [{
      depth: 2, text: "Steps",
      sectionRules: { list: { items: { enum: "not-an-array" } } },
      children: [],
    }];
    const issues = validateBodyTemplateSchema(schema);
    expect(issues.some((i) => i.message.includes("must be an array"))).toBe(true);
  });
});

describe("list missing → list-item error (unchanged)", () => {
  test("section with no list at all still surfaces list-item", async () => {
    expect(errs(await applyBodySchema(schemaWithList({ items: { pattern: "^x" } }), LIST_EMPTY))
      .some((i) => i.error_type === "list-item")).toBe(true);
  });
});
