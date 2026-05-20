/**
 * tests/providers/code-action.test.js — unit tests for code-action provider.
 *
 * Tests the fixer dispatch logic with synthetic Diagnostic objects.
 * No filesystem access, no real vault loaded.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Import the pure helpers under test ────────────────────────────────────────
// We test fixersForDiagnostic indirectly via the exported register() function,
// but since it's an internal async function we test through handleCodeAction
// by calling register and then invoking the stored handler. Instead, we test
// the observable behaviour: given a params object, register() wires
// connection.onCodeAction, and we invoke the registered handler directly.

// Since the module uses a closure, we re-import it fresh for each describe
// and capture the handler via the mock connection.

function makeConnection() {
  let _handler = null;
  return {
    onCodeAction(h) { _handler = h; },
    console: { error() {} },
    getHandler() { return _handler; },
  };
}

function makeDocs(text) {
  return {
    get(_uri) {
      return { getText() { return text; } };
    },
  };
}

function makeVaultIndex() {
  return {
    async ensureLoaded() {},
    search(q) { return []; },
  };
}

function diag(code, message, line = 0) {
  return {
    code,
    message,
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    severity: 1,
    source: "vault-keeper",
  };
}

async function getActions(text, diagnostics, opts = {}) {
  const { register } = await import("../../server/providers/code-action.js");
  const conn = makeConnection();
  const docs = opts.docs ?? makeDocs(text);
  const vaultIndex = opts.vaultIndex ?? makeVaultIndex();
  const projectRoot = opts.hasOwnProperty("projectRoot") ? opts.projectRoot : "/vault";

  register({ connection: conn, docs, vaultIndex, projectRoot });

  const handler = conn.getHandler();
  return handler({
    textDocument: { uri: "file:///vault/product-knowledge/02-product/prds/My%20PRD.md" },
    context: { diagnostics },
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FM_WITH_RELATIONSHIPS = `---
template: templates/prd-template.md
status: draft
owner: @alice
relationships:
  implements:
    - path: product-knowledge/01-strategy/dibbs/dibb-001-foo.md
  derived_from:
    - path: product-knowledge/01-strategy/research/2026-01-01-research-001-bar.md
---

## Summary

This is the body.
`;

const FM_WITH_TEMPLATE_META_LEAK = `---
template: templates/prd-template.md
status: draft
owner: @alice
fields:
  title: { required: true }
template_version: "2.0"
---

## Summary
`;

const FM_MISSING_OWNER = `---
template: templates/prd-template.md
status: draft
---

## Summary
`;

const FM_WITH_RELATIVE_PATH = `---
template: templates/prd-template.md
status: draft
owner: @alice
relationships:
  implements:
    - path: ../01-strategy/dibbs/dibb-001-foo.md
---
`;

// ── Tests: returns [] when no matching diagnostics ────────────────────────────

describe("code-action: no match", () => {
  test("returns [] when diagnostics array is empty", async () => {
    const actions = await getActions(FM_WITH_RELATIONSHIPS, []);
    expect(actions).toEqual([]);
  });

  test("returns [] when diagnostic code does not match any fixer", async () => {
    const actions = await getActions(FM_WITH_RELATIONSHIPS, [
      diag("body", "V15: AC AC1 body must contain a gherkin fenced block."),
    ]);
    expect(actions).toEqual([]);
  });

  test("returns [] when doc is not found", async () => {
    const { register } = await import("../../server/providers/code-action.js");
    const conn = makeConnection();
    const docs = { get() { return undefined; } };
    register({ connection: conn, docs, vaultIndex: makeVaultIndex(), projectRoot: "/vault" });
    const handler = conn.getHandler();
    const result = await handler({
      textDocument: { uri: "file:///vault/foo.md" },
      context: { diagnostics: [diag("filename", "Filename 'Foo.md' violates slug convention")] },
    });
    expect(result).toEqual([]);
  });
});

// ── Tests: Template-meta leak fixer ──────────────────────────────────────────

describe("code-action: template-meta leak fixer", () => {
  test("produces quickfix for fields leak", async () => {
    const d = diag(
      "fields",
      'Template-only field "fields" leaked into instance from template scaffold',
      4,
    );
    const actions = await getActions(FM_WITH_TEMPLATE_META_LEAK, [d]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].kind).toBe("quickfix");
    expect(actions[0].title).toMatch(/fields/);
  });

  test("edit deletes the fields block (multi-line)", async () => {
    const uri = "file:///vault/product-knowledge/02-product/prds/My%20PRD.md";
    const d = diag(
      "fields",
      'Template-only field "fields" leaked into instance from template scaffold',
      4,
    );
    const actions = await getActions(FM_WITH_TEMPLATE_META_LEAK, [d]);
    const act = actions[0];
    const edits = act.edit?.changes?.[uri];
    expect(Array.isArray(edits)).toBe(true);
    const deleteEdit = edits[0];
    expect(deleteEdit.newText).toBe("");
    // Deletes from line 4 (fields:) through the indented child
    expect(deleteEdit.range.start.line).toBe(4);
    expect(deleteEdit.range.end.line).toBeGreaterThan(4);
  });

  test("produces quickfix for template_version leak", async () => {
    const d = diag(
      "template_version",
      'Template-only field "template_version" leaked into instance from template scaffold',
      6,
    );
    const actions = await getActions(FM_WITH_TEMPLATE_META_LEAK, [d]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].title).toMatch(/template_version/);
  });

  test("does NOT fire for non-leak message on template_only code", async () => {
    // Same code but different message (shouldn't match 'leaked')
    const d = diag("fields", "Missing required field: fields", 4);
    const actions = await getActions(FM_WITH_TEMPLATE_META_LEAK, [d]);
    const leakActions = actions.filter((a) => a.title?.includes("Remove template-only"));
    expect(leakActions.length).toBe(0);
  });
});

// ── Tests: Naming violation fixer ─────────────────────────────────────────────

describe("code-action: naming violation fixer", () => {
  const textWithBadFilename = `---
template: templates/prd-template.md
status: draft
owner: @alice
---
## Summary
`;

  test("produces rename CodeAction with documentChanges", async () => {
    const d = diag(
      "filename",
      "Filename 'My PRD.md' violates slug convention (lowercase letters, digits, hyphens only)\nfix: Rename to 'my-prd.md' (or another lowercase-kebab name)",
    );
    const actions = await getActions(textWithBadFilename, [d]);
    expect(actions.length).toBeGreaterThan(0);
    const act = actions[0];
    expect(act.kind).toBe("quickfix");
    expect(act.title).toMatch(/my-prd\.md/);
    expect(act.edit?.documentChanges).toBeDefined();
    const renameOp = act.edit.documentChanges[0];
    expect(renameOp.kind).toBe("rename");
    expect(renameOp.newUri).toMatch(/my-prd\.md$/);
    expect(renameOp.options?.overwrite).toBe(false);
  });

  test("returns [] when fix hint has no 'Rename to' in message", async () => {
    const d = diag(
      "filename",
      "Filename 'Bad.md' violates slug convention (lowercase letters, digits, hyphens only)",
    );
    const actions = await getActions(textWithBadFilename, [d]);
    // No 'Rename to' hint → fixer returns null
    const renameActions = actions.filter((a) => a.edit?.documentChanges);
    expect(renameActions.length).toBe(0);
  });

  test("does NOT fire for folder code", async () => {
    const d = diag("folder", "Folder 'Bad Folder' violates slug convention\nfix: Rename to 'bad-folder/'");
    const actions = await getActions(textWithBadFilename, [d]);
    // folder code doesn't match filename fixer
    expect(actions.length).toBe(0);
  });
});

// ── Tests: Missing required field fixer ──────────────────────────────────────

describe("code-action: missing required field fixer", () => {
  test("inserts placeholder for top-level missing field", async () => {
    const uri = "file:///vault/product-knowledge/02-product/prds/My%20PRD.md";
    const d = diag("owner", "Missing required field: owner");
    const actions = await getActions(FM_MISSING_OWNER, [d]);
    expect(actions.length).toBeGreaterThan(0);
    const act = actions[0];
    expect(act.kind).toBe("quickfix");
    expect(act.title).toMatch(/owner/);
    const edits = act.edit?.changes?.[uri];
    expect(Array.isArray(edits)).toBe(true);
    const insertEdit = edits[0];
    expect(insertEdit.newText).toBe("owner: TODO\n");
    // Inserted just before closing ---
    // FM_MISSING_OWNER closes `---` at line 3 (0-indexed)
    expect(insertEdit.range.start.line).toBe(3);
  });

  test("returns [] for nested dot-path fields (not inline-fixable)", async () => {
    const d = diag(
      "success_metric_actual.primary.verdict",
      "Missing required field: success_metric_actual.primary.verdict",
    );
    const actions = await getActions(FM_MISSING_OWNER, [d]);
    // Nested dot-path → fixer returns null
    const insertActions = actions.filter((a) => a.title?.includes("Insert missing"));
    expect(insertActions.length).toBe(0);
  });

  test("does NOT fire when message does not start with 'Missing required field:'", async () => {
    const d = diag("owner", "V14: legacy frontmatter field 'owner'...");
    const actions = await getActions(FM_MISSING_OWNER, [d]);
    const insertActions = actions.filter((a) => a.title?.includes("Insert missing field"));
    expect(insertActions.length).toBe(0);
  });
});

// ── Tests: Relative path fixer ────────────────────────────────────────────────

describe("code-action: relative path fixer", () => {
  test("produces quickfix rewriting relative path to vault-absolute", async () => {
    const uri = "file:///vault/product-knowledge/02-product/prds/My%20PRD.md";
    // The diagnostic sits on the `- path: ../...` line (line 6 in FM_WITH_RELATIVE_PATH)
    const d = {
      code: "relationships.implements[0].path",
      message: "Relative path found: ../01-strategy/dibbs/dibb-001-foo.md",
      range: { start: { line: 6, character: 0 }, end: { line: 6, character: 50 } },
      severity: 1,
      source: "vault-keeper",
    };
    const actions = await getActions(FM_WITH_RELATIVE_PATH, [d], { projectRoot: "/vault" });
    expect(actions.length).toBeGreaterThan(0);
    const act = actions[0];
    expect(act.kind).toBe("quickfix");
    expect(act.title).toMatch(/vault-absolute/i);
    const edits = act.edit?.changes?.[uri];
    expect(Array.isArray(edits)).toBe(true);
    // The new text should not start with ../
    expect(edits[0].newText).not.toMatch(/\.\.\//);
  });

  test("does NOT fire when no 'Relative path found:' prefix in message", async () => {
    const d = diag(
      "relationships.implements[0].path",
      "V1: unknown predicate 'implements'",
    );
    const actions = await getActions(FM_WITH_RELATIVE_PATH, [d]);
    const relActions = actions.filter((a) => a.title?.includes("vault-absolute"));
    expect(relActions.length).toBe(0);
  });

  test("does NOT fire when projectRoot is null", async () => {
    const d = {
      code: "relationships.implements[0].path",
      message: "Relative path found: ../01-strategy/dibbs/dibb-001-foo.md",
      range: { start: { line: 6, character: 0 }, end: { line: 6, character: 50 } },
      severity: 1,
      source: "vault-keeper",
    };
    const actions = await getActions(FM_WITH_RELATIVE_PATH, [d], { projectRoot: null });
    const relActions = actions.filter((a) => a.title?.includes("vault-absolute"));
    expect(relActions.length).toBe(0);
  });
});

