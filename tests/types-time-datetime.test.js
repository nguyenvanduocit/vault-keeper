/**
 * Tests for the `time` and `datetime` types plus the `before` / `after`
 * chronological constraints. All four are registered as part of the
 * schema engine's primitive set; verifying them end-to-end through
 * `applyFieldSchema` mirrors how documents will exercise them.
 *
 * Coverage:
 *   - `type: time`     — accept HH:MM, HH:MM:SS; reject bad strings, OOR
 *   - `type: datetime` — accept ISO 8601 / RFC 3339, JS Date; reject plain
 *                        date or garbage
 *   - `before` / `after` — date / datetime / time, with template-level
 *                          validation rejecting nonsensical combinations
 */

import { describe, test, expect } from "bun:test";
import { applyFieldSchema, validateTemplateSchema } from "../lib/schema-engine.js";

const errs = (issues) => issues.filter((i) => i.level === "error");
const errorTypes = (issues) => errs(issues).map((i) => i.error_type);

describe("type: time", () => {
  const schema = { fields: { start: { type: "time" } } };

  test("accepts HH:MM", () => {
    expect(errs(applyFieldSchema(schema, { start: "09:30" }))).toHaveLength(0);
  });

  test("accepts HH:MM:SS", () => {
    expect(errs(applyFieldSchema(schema, { start: "23:59:59" }))).toHaveLength(0);
  });

  test("rejects out-of-range hour", () => {
    expect(errorTypes(applyFieldSchema(schema, { start: "24:00" }))).toContain("type-mismatch");
  });

  test("rejects out-of-range minute", () => {
    expect(errorTypes(applyFieldSchema(schema, { start: "09:60" }))).toContain("type-mismatch");
  });

  test("rejects non-string", () => {
    expect(errorTypes(applyFieldSchema(schema, { start: 930 }))).toContain("type-mismatch");
  });

  test("rejects bare-date string", () => {
    expect(errorTypes(applyFieldSchema(schema, { start: "2026-01-01" }))).toContain("type-mismatch");
  });
});

describe("type: datetime", () => {
  const schema = { fields: { ts: { type: "datetime" } } };

  test("accepts ISO 8601 with Z", () => {
    expect(errs(applyFieldSchema(schema, { ts: "2026-01-01T09:30:00Z" }))).toHaveLength(0);
  });

  test("accepts ISO 8601 with offset", () => {
    expect(errs(applyFieldSchema(schema, { ts: "2026-01-01T09:30:00+07:00" }))).toHaveLength(0);
  });

  test("accepts JS Date instance", () => {
    expect(errs(applyFieldSchema(schema, { ts: new Date("2026-01-01T09:30:00Z") }))).toHaveLength(0);
  });

  test("rejects bare-date (no time part)", () => {
    expect(errorTypes(applyFieldSchema(schema, { ts: "2026-01-01" }))).toContain("type-mismatch");
  });

  test("rejects garbage string", () => {
    expect(errorTypes(applyFieldSchema(schema, { ts: "not-a-date" }))).toContain("type-mismatch");
  });

  test("rejects Invalid Date", () => {
    expect(errorTypes(applyFieldSchema(schema, { ts: new Date("nope") }))).toContain("type-mismatch");
  });
});

describe("before / after — runtime", () => {
  test("date: value before bound → passes", () => {
    const schema = { fields: { d: { type: "date", before: "2027-01-01" } } };
    expect(errs(applyFieldSchema(schema, { d: new Date("2026-05-01") }))).toHaveLength(0);
  });

  test("date: value at-or-after bound → before-violation", () => {
    const schema = { fields: { d: { type: "date", before: "2026-01-01" } } };
    expect(errorTypes(applyFieldSchema(schema, { d: new Date("2026-05-01") }))).toContain("before-violation");
  });

  test("date: value after bound → passes", () => {
    const schema = { fields: { d: { type: "date", after: "2025-01-01" } } };
    expect(errs(applyFieldSchema(schema, { d: new Date("2026-01-01") }))).toHaveLength(0);
  });

  test("date: value at-or-before bound → after-violation", () => {
    const schema = { fields: { d: { type: "date", after: "2026-01-01" } } };
    expect(errorTypes(applyFieldSchema(schema, { d: new Date("2025-12-31") }))).toContain("after-violation");
  });

  test("datetime: ISO comparison works", () => {
    const schema = { fields: { ts: { type: "datetime", after: "2026-01-01T00:00:00Z" } } };
    expect(errs(applyFieldSchema(schema, { ts: "2026-06-01T12:00:00Z" }))).toHaveLength(0);
    expect(errorTypes(applyFieldSchema(schema, { ts: "2025-12-31T23:59:59Z" }))).toContain("after-violation");
  });

  test("time: HH:MM comparison ignores date", () => {
    const schema = { fields: { t: { type: "time", before: "17:00" } } };
    expect(errs(applyFieldSchema(schema, { t: "09:00" }))).toHaveLength(0);
    expect(errorTypes(applyFieldSchema(schema, { t: "18:00" }))).toContain("before-violation");
  });
});

describe("before / after — template-level meta-validation", () => {
  test("rejects before/after without declared type", () => {
    const issues = validateTemplateSchema({
      d: { before: "2027-01-01" },
    });
    expect(issues.some((i) => i.message.includes("requires a declared 'type'"))).toBe(true);
  });

  test("rejects before/after on non-chronological type", () => {
    const issues = validateTemplateSchema({
      d: { type: "string", before: "2027-01-01" },
    });
    expect(issues.some((i) => i.message.includes("only valid with type 'date', 'datetime', or 'time'"))).toBe(true);
  });

  test("rejects unparseable before value", () => {
    const issues = validateTemplateSchema({
      d: { type: "date", before: "not-a-date" },
    });
    expect(issues.some((i) => i.message.includes("is not a parseable date"))).toBe(true);
  });

  test("accepts valid before with type: time", () => {
    const issues = validateTemplateSchema({
      t: { type: "time", before: "17:00" },
    });
    expect(issues.filter((i) => i.message.includes("before"))).toHaveLength(0);
  });
});

describe("fuzzy: typo on the new types", () => {
  test("'tiem' → suggest 'time'", () => {
    const issues = validateTemplateSchema({ x: { type: "tiem" } });
    const bad = issues.find((i) => i.message.includes("Invalid type 'tiem'"));
    expect(bad.message).toContain("Did you mean 'time'?");
  });

  test("'datatime' → suggest 'datetime'", () => {
    const issues = validateTemplateSchema({ x: { type: "datatime" } });
    const bad = issues.find((i) => i.message.includes("Invalid type 'datatime'"));
    expect(bad.message).toContain("Did you mean 'datetime'?");
  });
});
