/**
 * Tests for server/providers/document-formatting.js
 *
 * Strategy: mock LSP connection + TextDocuments, invoke handler directly.
 * All markdown is inline strings — no disk reads in these tests.
 */

import { describe, test, expect } from "bun:test";

// ── Minimal mocks ─────────────────────────────────────────────────────────

function makeConnection() {
  let handler = null;
  return {
    onDocumentFormatting(fn) { handler = fn; },
    console: { error() {}, info() {} },
    async callFormat(params) { return handler(params); },
  };
}

function makeDocs(text, uri = "file:///product-knowledge/test.md") {
  return {
    get(u) {
      if (u === uri) return { getText: () => text, uri: u };
      return null;
    },
  };
}

function makeVaultIndex() {
  return {};
}

const { register, capability } = await import(
  "../../server/providers/document-formatting.js"
);

const PROJECT_ROOT = "/vault";
const URI = "file:///product-knowledge/test.md";

function setup(text) {
  const connection = makeConnection();
  const docs = makeDocs(text, URI);
  const vaultIndex = makeVaultIndex();
  register({ connection, docs, vaultIndex, projectRoot: PROJECT_ROOT });
  return () => connection.callFormat({ textDocument: { uri: URI } });
}

// ── Capability export ─────────────────────────────────────────────────────

describe("capability", () => {
  test("exports documentFormattingProvider: true", () => {
    expect(capability).toEqual({ documentFormattingProvider: true });
  });
});

// ── Null / no-op cases ────────────────────────────────────────────────────

describe("document-formatting — no-op cases", () => {
  test("returns null for empty doc", async () => {
    const call = setup("");
    const result = await call();
    expect(result).toBeNull();
  });

  test("returns null when doc not found", async () => {
    const connection = makeConnection();
    const docs = { get: () => null };
    const vaultIndex = makeVaultIndex();
    register({ connection, docs, vaultIndex, projectRoot: PROJECT_ROOT });
    const result = await connection.callFormat({ textDocument: { uri: URI } });
    expect(result).toBeNull();
  });

  test("returns null when already canonical (no change)", async () => {
    // A document that is already fully formatted — format(format(x)) === format(x)
    // We run format once to get canonical form, then check second pass returns null.
    const { formatVaultDocument } = await import("../../lib/canonical-formatter.js");
    const raw = `---
status: draft
template: templates/prd-template.md
---

## Problem

Content.
`;
    const canonical = formatVaultDocument(raw).formatted;
    const call = setup(canonical);
    const result = await call();
    // canonical document → null (no edits)
    expect(result).toBeNull();
  });
});

// ── TextEdit shape ────────────────────────────────────────────────────────

describe("document-formatting — TextEdit structure", () => {
  test("returns array with one TextEdit covering full document", async () => {
    const input = `---
status: draft
updated: '2026-05-12T00:00:00+07:00'
template: templates/prd-template.md
---

### AC1: user can login
`;
    const call = setup(input);
    const result = await call();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);

    const edit = result[0];
    expect(edit.range.start).toEqual({ line: 0, character: 0 });
    expect(typeof edit.newText).toBe("string");
    expect(edit.newText.length).toBeGreaterThan(0);
  });

  test("TextEdit range end matches last line of original doc", async () => {
    const input = "### AC1: user can login\n";
    const call = setup(input);
    const result = await call();
    expect(result).not.toBeNull();
    const edit = result[0];
    const lines = input.split("\n");
    const lastLine = lines.length - 1;
    const lastChar = lines[lastLine].length;
    expect(edit.range.end).toEqual({ line: lastLine, character: lastChar });
  });

  test("newText contains normalized AC heading", async () => {
    const input = "### AC1: user can login\n";
    const call = setup(input);
    const result = await call();
    expect(result[0].newText).toContain("### AC1 — User can login");
  });

  test("newText contains normalized relationship bullet", async () => {
    const input = "- implements_bet: [PRD](../prds/prd-001.md) — core\n";
    const call = setup(input);
    const result = await call();
    expect(result).not.toBeNull();
    expect(result[0].newText).toContain("**implements_bet**");
  });
});

// ── Integration: AC heading + frontmatter together ─────────────────────────

describe("document-formatting — integration", () => {
  test("formats frontmatter key order + AC heading in one pass", async () => {
    const input = `---
updated: '2026-05-12T00:00:00+07:00'
status: draft
template: templates/prd-template.md
---

### AC1: user sees dashboard
`;
    const call = setup(input);
    const result = await call();
    expect(result).not.toBeNull();
    const { newText } = result[0];
    // Frontmatter: template before status (priority ordering skips 'updated' before 'status')
    const templateIdx = newText.indexOf("template:");
    const updatedIdx = newText.indexOf("updated:");
    expect(templateIdx).toBeLessThan(updatedIdx);
    // AC heading normalized
    expect(newText).toContain("### AC1 — User sees dashboard");
  });

  test("trailing whitespace stripped in formatted output", async () => {
    const input = "line with trailing space   \n";
    const call = setup(input);
    const result = await call();
    expect(result).not.toBeNull();
    const lines = result[0].newText.split("\n");
    expect(lines[0]).toBe("line with trailing space");
  });

  test("final newline ensured in formatted output", async () => {
    const input = "content without newline";
    const call = setup(input);
    const result = await call();
    expect(result).not.toBeNull();
    expect(result[0].newText.endsWith("\n")).toBe(true);
  });

  test("error in handler returns null, does not throw", async () => {
    // Simulate docs.get() throwing
    const connection = makeConnection();
    const docs = { get: () => { throw new Error("disk error"); } };
    const vaultIndex = makeVaultIndex();
    register({ connection, docs, vaultIndex, projectRoot: PROJECT_ROOT });
    const result = await connection.callFormat({ textDocument: { uri: URI } });
    expect(result).toBeNull();
  });
});
