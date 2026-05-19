/**
 * Tests for lib/doc-io.js — the shared parseDocument + resolveDocPath helpers
 * consumed by both the CLI orchestrator and the V-rule pipeline.
 *
 * These tests lock the contract that lets us delete the historical pair of
 * duplicates (`_parseDocument`, `_resolveDocPath`) in lib/adr005-rules.js and
 * the inline copies in cli/validate-documents.js. If either consumer ever
 * needs to swap parser semantics, this is the single fixture to update.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, resolveDocPath } from "../lib/doc-io.js";

describe("parseDocument", () => {
  test("reads frontmatter and body cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-io-"));
    const path = join(dir, "doc.md");
    writeFileSync(
      path,
      "---\ntitle: Hello\nstatus: draft\n---\n\n# Body heading\n\nBody prose.\n",
    );

    const result = await parseDocument(path);
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toEqual({ title: "Hello", status: "draft" });
    expect(result.body).toContain("# Body heading");
    expect(result.body).toContain("Body prose.");
    expect(result.filepath).toBe(path);

    rmSync(dir, { recursive: true });
  });

  test("missing file → soft error result, never throws", async () => {
    const result = await parseDocument("/nonexistent/path/does-not-exist.md");
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.frontmatter).toBeUndefined();
  });

  test("file with no frontmatter → empty frontmatter, full body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-io-"));
    const path = join(dir, "raw.md");
    writeFileSync(path, "Just a plain body, no frontmatter.\n");

    const result = await parseDocument(path);
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("Just a plain body");

    rmSync(dir, { recursive: true });
  });
});

describe("resolveDocPath", () => {
  test("strips #anchor fragments", () => {
    expect(resolveDocPath("foo/bar.md#AC1")).toBe("foo/bar.md");
    expect(resolveDocPath("foo.md#deeply-nested")).toBe("foo.md");
  });

  test("returns clean paths unchanged", () => {
    expect(resolveDocPath("foo/bar.md")).toBe("foo/bar.md");
    expect(resolveDocPath("./foo.md")).toBe("./foo.md");
    expect(resolveDocPath("../foo/bar.md")).toBe("../foo/bar.md");
  });

  test("returns null for HTTP URLs", () => {
    expect(resolveDocPath("https://example.com/foo.md")).toBeNull();
    expect(resolveDocPath("http://example.com")).toBeNull();
  });

  test("returns null for placeholder strings with brackets", () => {
    expect(resolveDocPath("[future-prd]")).toBeNull();
    expect(resolveDocPath("see [TBD]")).toBeNull();
  });

  test("returns null for source-code line refs", () => {
    expect(resolveDocPath("foo.go:123")).toBeNull();
    expect(resolveDocPath("src/main.ts:42")).toBeNull();
    expect(resolveDocPath("script.py:7")).toBeNull();
    expect(resolveDocPath("Module.java:55")).toBeNull();
    expect(resolveDocPath("file.rb:9")).toBeNull();
  });

  test("returns null for empty / non-string input", () => {
    expect(resolveDocPath("")).toBeNull();
    expect(resolveDocPath(null)).toBeNull();
    expect(resolveDocPath(undefined)).toBeNull();
    expect(resolveDocPath(42)).toBeNull();
  });
});
