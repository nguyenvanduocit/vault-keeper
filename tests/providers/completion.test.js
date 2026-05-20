/**
 * Tests for server/providers/completion.js
 *
 * Strategy: capture the handler registered via connection.onCompletion, then
 * invoke it directly with synthetic params. Mock connection and docs minimally;
 * use real position-context.js. Stub VaultIndex with allEntries / ensureLoaded.
 *
 * Template vocab requires a real projectRoot with templates/ on disk (we write
 * minimal ones to a temp dir). Status/phase enum tests use an inline template.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// ── Module under test ────────────────────────────────────────────────────────
import { register, capability } from "../../server/providers/completion.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let SANDBOX;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "completion-"));
});

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const abs = join(SANDBOX, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

/**
 * Build a minimal mock connection that captures the onCompletion handler.
 */
function makeConnection() {
  let handler = null;
  return {
    onCompletion: (fn) => { handler = fn; },
    console: { error: () => {} },
    _invoke: async (params) => {
      if (!handler) throw new Error("onCompletion handler not registered");
      return handler(params);
    },
  };
}

/**
 * Build a minimal VaultIndex stub.
 */
function makeVaultIndex(entries = []) {
  return {
    _loaded: true,
    async ensureLoaded() {},
    allEntries() { return entries; },
    getEntry(absPath) { return entries.find((e) => e.absPath === absPath) || null; },
    getFrontmatter(absPath) {
      const e = entries.find((en) => en.absPath === absPath);
      return e ? e.fm : null;
    },
  };
}

/**
 * Build a minimal docs stub.
 */
function makeDocs(uri, text) {
  const map = new Map();
  map.set(uri, { getText: () => text, uri });
  return { get: (u) => map.get(u) || null };
}

/**
 * Write a minimal prd-template.md with a `fields:` schema block.
 */
function writePrdTemplate(sandbox) {
  const content = `---
template_id: "prd-template"
template_path: "templates/prd-template.md"
tier: PRODUCT
fields:
  template:
    required: true
  status:
    required: true
    enum: [draft, review, approved, shipped, cancelled]
  phase:
    enum: [inception, build, launch]
---
# PRD Template
`;
  writeFile("templates/prd-template.md", content);
}

/**
 * Write a task-template.md for WORK tier.
 */
function writeTaskTemplate(sandbox) {
  const content = `---
template_id: "task-template"
template_path: "templates/task-template.md"
tier: WORK
fields:
  template:
    required: true
  status:
    required: true
    enum: [todo, in_progress, done]
---
# Task Template
`;
  writeFile("templates/task-template.md", content);
}

/**
 * Shared setup: write templates, create a vault entry doc URI.
 */
function setupSandbox() {
  writePrdTemplate(SANDBOX);
  writeTaskTemplate(SANDBOX);

  // Write a people file so @handle completions can find it
  writeFile("product-data/people/bob.md", "# Bob\n");
  writeFile("product-data/people/alice.md", "# Alice\n");

  // Write a target doc so anchor completions work
  writeFile("product-knowledge/02-product/prds/prd-001-foo.md", `---
template: templates/prd-template.md
status: draft
---
# PRD-001

## Acceptance Criteria

### AC1 — user can login

### AC2 — user sees dashboard
`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("capability export", () => {
  test("has completionProvider with triggerCharacters", () => {
    expect(capability.completionProvider).toBeDefined();
    expect(capability.completionProvider.triggerCharacters).toContain("*");
    expect(capability.completionProvider.triggerCharacters).toContain("(");
    expect(capability.completionProvider.triggerCharacters).toContain(":");
    expect(capability.completionProvider.resolveProvider).toBe(false);
  });
});

describe("register — unknown context returns []", () => {
  test("random body text → []", async () => {
    setupSandbox();
    const connection = makeConnection();
    const docText = "---\ntemplate: templates/prd-template.md\nstatus: draft\n---\n\nSome random body text.\n";
    const uri = pathToFileURL(join(SANDBOX, "product-knowledge/02-product/prds/test.md")).href;
    const docs = makeDocs(uri, docText);
    const vaultIndex = makeVaultIndex([]);

    register({ connection, docs, vaultIndex, projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri },
      position: { line: 5, character: 10 },
    });

    expect(result).toEqual([]);
  });

  test("missing doc URI → []", async () => {
    const connection = makeConnection();
    const docs = { get: () => null };
    register({ connection, docs, vaultIndex: makeVaultIndex(), projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri: "file:///nonexistent.md" },
      position: { line: 0, character: 0 },
    });

    expect(result).toEqual([]);
  });
});

describe("no predicate completions — predicates removed", () => {
  test("cursor after ** at start of bullet → no completions (predicates removed)", async () => {
    setupSandbox();
    const connection = makeConnection();
    const docText = `---
template: templates/prd-template.md
status: draft
---

- **`;
    const uri = pathToFileURL(join(SANDBOX, "product-knowledge/02-product/prds/test.md")).href;
    const docs = makeDocs(uri, docText);
    register({ connection, docs, vaultIndex: makeVaultIndex(), projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri },
      position: { line: 5, character: 4 },
    });

    expect(result).toEqual([]);
  });

});

describe("link path completions — after ](", () => {
  test("returns File items for vault entries", async () => {
    setupSandbox();
    const connection = makeConnection();

    const docUri = pathToFileURL(join(SANDBOX, "product-knowledge/02-product/prds/test.md")).href;
    const targetAbs = join(SANDBOX, "product-knowledge/02-product/prds/prd-001-foo.md");

    const vaultIndex = makeVaultIndex([
      {
        absPath: targetAbs,
        id: "prd-001",
        title: "PRD-001 Foo",
        template: "templates/prd-template.md",
        status: "draft",
        fm: { template: "templates/prd-template.md", status: "draft" },
        outLinks: [],
      },
    ]);

    const docText = `---
template: templates/prd-template.md
status: draft
---

See [foo](`;
    const docs = makeDocs(docUri, docText);
    register({ connection, docs, vaultIndex, projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri: docUri },
      position: { line: 5, character: 10 }, // cursor after `](`
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const item = result.find((i) => i.label.includes("prd-001-foo.md"));
    expect(item).toBeDefined();
    expect(item.kind).toBe(17); // CompletionItemKind.File
    expect(item.detail).toBe("prd"); // template name without "-template"
  });

  test("no vaultIndex → []", async () => {
    const connection = makeConnection();
    const uri = pathToFileURL(join(SANDBOX, "product-knowledge/02-product/prds/test.md")).href;
    const docs = makeDocs(uri, "---\n---\n\nSee [foo](");
    register({ connection, docs, vaultIndex: null, projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri },
      position: { line: 3, character: 10 },
    });
    expect(result).toEqual([]);
  });
});

describe("status enum completions — after status:", () => {
  test("returns EnumMember items from field schema enum", async () => {
    setupSandbox();
    const connection = makeConnection();
    const docText = `---
template: templates/prd-template.md
status:
---
`;
    const uri = pathToFileURL(join(SANDBOX, "product-knowledge/02-product/prds/test.md")).href;
    const docs = makeDocs(uri, docText);
    register({ connection, docs, vaultIndex: makeVaultIndex(), projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri },
      position: { line: 2, character: 7 }, // cursor after `status:`
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const labels = result.map((i) => i.label);
    expect(labels).toContain("draft");
    expect(labels).toContain("approved");
    expect(labels).toContain("shipped");

    for (const item of result) {
      expect(item.kind).toBe(20); // CompletionItemKind.EnumMember
    }
  });

  test("no template → []", async () => {
    const connection = makeConnection();
    const docText = `---
status:
---
`;
    const uri = pathToFileURL(join(SANDBOX, "test.md")).href;
    const docs = makeDocs(uri, docText);
    register({ connection, docs, vaultIndex: makeVaultIndex(), projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri },
      position: { line: 1, character: 7 }, // after `status:`, no template field → []
    });
    expect(result).toEqual([]);
  });
});

describe("template completions — after template:", () => {
  test("returns Module items for template files", async () => {
    setupSandbox();
    const connection = makeConnection();
    const docText = `---
template:
---
`;
    const uri = pathToFileURL(join(SANDBOX, "product-knowledge/02-product/prds/test.md")).href;
    const docs = makeDocs(uri, docText);
    register({ connection, docs, vaultIndex: makeVaultIndex(), projectRoot: SANDBOX });

    const result = await connection._invoke({
      textDocument: { uri },
      position: { line: 1, character: 9 }, // cursor after `template:`
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const labels = result.map((i) => i.label);
    expect(labels.some((l) => l.includes("prd-template.md"))).toBe(true);
    expect(labels.some((l) => l.includes("task-template.md"))).toBe(true);

    for (const item of result) {
      expect(item.kind).toBe(9); // CompletionItemKind.Module
    }
  });
});
