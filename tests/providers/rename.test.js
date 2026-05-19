/**
 * Tests for server/providers/rename.js
 *
 * Strategy: mock VaultIndex with pre-loaded entries (body text injected as
 * entry.body) so the provider never hits the filesystem. Mock connection
 * captures registered handlers for direct invocation in tests.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { register } from "../../server/providers/rename.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a minimal mock VaultIndex.
 * entries: Array<{ absPath, id?, title?, fm?, body?, outLinks? }>
 * backlinks: Map<absPath, [{source, line, rawPath?}]>
 */
function makeVaultIndex(entries = [], backlinks = new Map()) {
  return {
    _loaded: true,
    async ensureLoaded() {},
    allEntries() {
      return entries;
    },
    getBacklinks(targetAbsPath) {
      return backlinks.get(targetAbsPath) || [];
    },
    getFrontmatter(absPath) {
      const e = entries.find((x) => x.absPath === absPath);
      return e ? e.fm || {} : null;
    },
    getEntry(absPath) {
      return entries.find((x) => x.absPath === absPath) || null;
    },
    resolveId(id) {
      const e = entries.find(
        (x) => x.id && x.id.toLowerCase() === id.toLowerCase(),
      );
      return e ? e.absPath : null;
    },
  };
}

/**
 * Build a mock LSP connection that captures registered handlers.
 */
function makeConnection() {
  const handlers = {};
  const warnings = [];
  const errors = [];
  return {
    _handlers: handlers,
    _warnings: warnings,
    _errors: errors,
    onPrepareRename(fn) {
      handlers.prepareRename = fn;
    },
    onRenameRequest(fn) {
      handlers.renameRequest = fn;
    },
    workspace: {
      _willRenameHandler: null,
      onWillRenameFiles(fn) {
        this._willRenameHandler = fn;
      },
    },
    console: {
      warn(msg) {
        warnings.push(msg);
      },
      error(msg) {
        errors.push(msg);
      },
      info() {},
    },
  };
}

/**
 * Build a minimal mock TextDocuments store.
 */
function makeDocs(map = {}) {
  return {
    get(uri) {
      const text = map[uri];
      if (text == null) return undefined;
      return { getText: () => text, uri };
    },
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = "/vault";
const PEOPLE_DIR = `${ROOT}/product-data/people`;

// ── 1. prepareRename ─────────────────────────────────────────────────────────

describe("onPrepareRename", () => {
  let connection, docs, vaultIndex;

  beforeEach(() => {
    connection = makeConnection();
    vaultIndex = makeVaultIndex();
    docs = makeDocs();
    register({ connection, docs, vaultIndex, projectRoot: ROOT });
  });

  test("returns null when doc not found", async () => {
    const result = await connection._handlers.prepareRename({
      textDocument: { uri: "file:///nonexistent.md" },
      position: { line: 0, character: 0 },
    });
    expect(result).toBeNull();
  });

  test("returns null for non-renameable position (plain prose)", async () => {
    docs = makeDocs({
      "file:///vault/doc.md": "---\ntitle: Foo\n---\n\nSome plain text here.\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection._handlers.prepareRename({
      textDocument: { uri: "file:///vault/doc.md" },
      position: { line: 4, character: 5 },
    });
    expect(result).toBeNull();
  });

  test("returns range for @handle in body", async () => {
    docs = makeDocs({
      "file:///vault/doc.md": "---\ntitle: Foo\n---\n\nOwner: @alice reviewed this.\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    // line 4: "Owner: @alice reviewed this." — @alice starts at char 7
    const result = await connection._handlers.prepareRename({
      textDocument: { uri: "file:///vault/doc.md" },
      position: { line: 4, character: 8 },
    });
    expect(result).not.toBeNull();
    expect(result.start).toEqual({ line: 4, character: 7 });
    expect(result.end).toEqual({ line: 4, character: 13 }); // "@alice" = 6 chars
  });

  test("returns range for frontmatter title:", async () => {
    docs = makeDocs({
      "file:///vault/doc.md": "---\ntitle: My Task\nid: t-001\n---\n\nBody\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    // line 1: "title: My Task" — value starts at char 7
    const result = await connection._handlers.prepareRename({
      textDocument: { uri: "file:///vault/doc.md" },
      position: { line: 1, character: 9 },
    });
    expect(result).not.toBeNull();
    expect(result.start.line).toBe(1);
    expect(result.start.character).toBe(7);
  });

  test("returns range for frontmatter id:", async () => {
    docs = makeDocs({
      "file:///vault/doc.md": "---\ntitle: Foo\nid: t-069\n---\n\nBody\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    // line 2: "id: t-069" — value starts at char 4
    const result = await connection._handlers.prepareRename({
      textDocument: { uri: "file:///vault/doc.md" },
      position: { line: 2, character: 5 },
    });
    expect(result).not.toBeNull();
    expect(result.start.line).toBe(2);
  });

  test("returns null when cursor is on unrelated frontmatter field", async () => {
    docs = makeDocs({
      "file:///vault/doc.md": "---\nstatus: draft\ntitle: Foo\n---\n\nBody\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    // cursor on "status" key — not renameable
    const result = await connection._handlers.prepareRename({
      textDocument: { uri: "file:///vault/doc.md" },
      position: { line: 1, character: 2 },
    });
    expect(result).toBeNull();
  });
});

// ── 2. renameRequest — @handle ────────────────────────────────────────────────

describe("onRenameRequest — @handle", () => {
  test("produces edits across multiple files + RenameFile for people doc", async () => {
    const alicePath = `${PEOPLE_DIR}/alice.md`;
    const docAPath = `${ROOT}/product-knowledge/02-product/tasks/t-001.md`;
    const docBPath = `${ROOT}/product-knowledge/03-engineering/tasks/t-002.md`;

    const entries = [
      {
        absPath: alicePath,
        fm: { handle: "alice", title: "Alice" },
        body: "---\nhandle: alice\ntitle: Alice\n---\n\nProfile of @alice.\n",
      },
      {
        absPath: docAPath,
        fm: { title: "Task A" },
        body: "---\ntitle: Task A\n---\n\nOwner: @alice.\nReviewed by @alice.\n",
      },
      {
        absPath: docBPath,
        fm: { title: "Task B" },
        body: "---\ntitle: Task B\n---\n\nNo mentions here.\n",
      },
    ];

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex(entries);
    const docText = "---\ntitle: Task A\n---\n\nOwner: @alice.\n";
    const docs = makeDocs({ [`file://${docAPath}`]: docText });

    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection._handlers.renameRequest({
      textDocument: { uri: `file://${docAPath}` },
      position: { line: 4, character: 8 }, // on @alice
      newName: "alice-smith",
    });

    expect(result).not.toBeNull();
    expect(result.documentChanges).toBeDefined();

    // Should have edits for alice.md, docA, and a RenameFile op
    const uris = result.documentChanges.map(
      (c) => c.textDocument?.uri ?? c.oldUri,
    );
    expect(uris).toContain(`file://${alicePath}`);
    expect(uris).toContain(`file://${docAPath}`);

    // RenameFile entry
    const renameOp = result.documentChanges.find((c) => c.kind === "rename");
    expect(renameOp).toBeDefined();
    expect(renameOp.oldUri).toBe(`file://${alicePath}`);
    expect(renameOp.newUri).toBe(`file://${PEOPLE_DIR}/alice-smith.md`);

    // Edits in docA replace @alice with @alice-smith
    const docAChange = result.documentChanges.find(
      (c) => c.textDocument?.uri === `file://${docAPath}`,
    );
    expect(docAChange).toBeDefined();
    expect(docAChange.edits.length).toBeGreaterThan(0);
    for (const edit of docAChange.edits) {
      expect(edit.newText).toBe("@alice-smith");
    }

    // docB has no @alice → no edits for it
    const docBChange = result.documentChanges.find(
      (c) => c.textDocument?.uri === `file://${docBPath}`,
    );
    expect(docBChange).toBeUndefined();
  });

  test("no people file → no RenameFile op", async () => {
    const docPath = `${ROOT}/product-knowledge/02-product/tasks/t-001.md`;
    const entries = [
      {
        absPath: docPath,
        fm: { title: "Task A" },
        body: "---\ntitle: Task A\n---\n\nOwner: @bob.\n",
      },
      // NOTE: no product-data/people/bob.md
    ];

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex(entries);
    const docs = makeDocs({
      [`file://${docPath}`]: "---\ntitle: Task A\n---\n\nOwner: @bob.\n",
    });

    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection._handlers.renameRequest({
      textDocument: { uri: `file://${docPath}` },
      position: { line: 4, character: 8 },
      newName: "bob-jones",
    });

    expect(result).not.toBeNull();
    const renameOps = result.documentChanges.filter((c) => c.kind === "rename");
    expect(renameOps).toHaveLength(0);
  });
});

// ── 3. renameRequest — title ──────────────────────────────────────────────────

describe("onRenameRequest — title", () => {
  test("updates only the title: field in-place, no propagation", async () => {
    const docPath = `${ROOT}/product-knowledge/02-product/tasks/t-001.md`;
    const docText = "---\ntitle: Old Title\nid: t-001\n---\n\nBody\n";

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex([]);
    const docs = makeDocs({ [`file://${docPath}`]: docText });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection._handlers.renameRequest({
      textDocument: { uri: `file://${docPath}` },
      position: { line: 1, character: 9 }, // on "Old Title"
      newName: "New Title",
    });

    expect(result).not.toBeNull();
    expect(result.documentChanges).toHaveLength(1);
    const change = result.documentChanges[0];
    expect(change.textDocument.uri).toBe(`file://${docPath}`);
    expect(change.edits).toHaveLength(1);
    expect(change.edits[0].newText).toBe("New Title");
  });
});

// ── 4. renameRequest — id ─────────────────────────────────────────────────────

describe("onRenameRequest — id", () => {
  test("updates [t-069] and bare t-069 references across vault", async () => {
    const docPath = `${ROOT}/product-knowledge/02-product/tasks/t-069-foo.md`;
    const refPath = `${ROOT}/product-knowledge/03-engineering/tasks/t-070.md`;

    const entries = [
      {
        absPath: docPath,
        id: "t-069",
        fm: { id: "t-069", title: "Foo" },
        body: "---\nid: t-069\ntitle: Foo\n---\n\nSelf ref t-069.\n",
      },
      {
        absPath: refPath,
        id: "t-070",
        fm: { title: "Bar" },
        body: "---\ntitle: Bar\n---\n\nBlocks [t-069] and also t-069 inline.\n",
      },
    ];

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex(entries);
    const docs = makeDocs({
      [`file://${docPath}`]: "---\nid: t-069\ntitle: Foo\n---\n\nSelf ref t-069.\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection._handlers.renameRequest({
      textDocument: { uri: `file://${docPath}` },
      position: { line: 1, character: 5 }, // on "t-069" in id: line
      newName: "t-099",
    });

    expect(result).not.toBeNull();

    // Find edits for refPath
    const refChange = result.documentChanges.find(
      (c) => c.textDocument?.uri === `file://${refPath}`,
    );
    expect(refChange).toBeDefined();

    // Should have two edits: [t-069] → [t-099] and bare t-069 → t-099
    expect(refChange.edits.length).toBeGreaterThanOrEqual(2);
    const bracketEdit = refChange.edits.find((e) => e.newText === "[t-099]");
    const bareEdit = refChange.edits.find((e) => e.newText === "t-099");
    expect(bracketEdit).toBeDefined();
    expect(bareEdit).toBeDefined();
  });

  test("no cross-doc references → only self-edit (frontmatter id line)", async () => {
    const docPath = `${ROOT}/product-knowledge/02-product/tasks/t-090.md`;
    // Entry body contains the id in frontmatter only — no other files reference t-090
    const entries = [
      {
        absPath: docPath,
        id: "t-090",
        fm: { id: "t-090" },
        body: "---\nid: t-090\n---\n\nNo references anywhere.\n",
      },
    ];

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex(entries);
    const docs = makeDocs({
      [`file://${docPath}`]: "---\nid: t-090\ntitle: X\n---\n\nBody\n",
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection._handlers.renameRequest({
      textDocument: { uri: `file://${docPath}` },
      position: { line: 1, character: 5 },
      newName: "t-099",
    });

    // The scan finds t-090 in the doc's own frontmatter id: line → one self-edit
    expect(result).not.toBeNull();
    expect(result.documentChanges).toHaveLength(1);
    expect(result.documentChanges[0].textDocument.uri).toBe(`file://${docPath}`);
    // No other docs referenced
    expect(result.documentChanges[0].edits[0].newText).toBe("t-099");
  });
});

// ── 5. onWillRenameFiles ──────────────────────────────────────────────────────

describe("onWillRenameFiles", () => {
  test("no referrers → returns null", async () => {
    const oldPath = `${ROOT}/product-knowledge/02-product/prds/prd-foo.md`;
    const newPath = `${ROOT}/product-knowledge/02-product/prds/prd-bar.md`;

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex([], new Map());
    const docs = makeDocs({});
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection.workspace._willRenameHandler({
      files: [
        { oldUri: `file://${oldPath}`, newUri: `file://${newPath}` },
      ],
    });

    expect(result).toBeNull();
  });

  test("produces TextEdits for all referrers with correct relative paths", async () => {
    const oldPath = `${ROOT}/product-knowledge/02-product/prds/prd-foo.md`;
    const newPath = `${ROOT}/product-knowledge/02-product/prds/prd-bar.md`;

    // Two referrers in different directories
    const refAPath = `${ROOT}/product-knowledge/02-product/tasks/t-001.md`;
    const refBPath = `${ROOT}/product-knowledge/03-engineering/tasks/t-002.md`;

    const backlinks = new Map([
      [
        oldPath,
        [
          { source: refAPath, line: 4, rawPath: "../prds/prd-foo.md" },
          { source: refBPath, line: 3, rawPath: "../../02-product/prds/prd-foo.md" },
        ],
      ],
    ]);

    const refAText =
      "---\ntitle: Task A\n---\n\nSee [PRD Foo](../prds/prd-foo.md) for details.\n";
    const refBText =
      "---\ntitle: Task B\n---\n\nSee [PRD Foo](../../02-product/prds/prd-foo.md).\n";

    const connection = makeConnection();
    const vaultIndex = makeVaultIndex([], backlinks);
    const docs = makeDocs({
      [`file://${refAPath}`]: refAText,
      [`file://${refBPath}`]: refBText,
    });
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection.workspace._willRenameHandler({
      files: [
        { oldUri: `file://${oldPath}`, newUri: `file://${newPath}` },
      ],
    });

    expect(result).not.toBeNull();
    expect(result.documentChanges).toHaveLength(2);

    const changeA = result.documentChanges.find(
      (c) => c.textDocument.uri === `file://${refAPath}`,
    );
    expect(changeA).toBeDefined();
    expect(changeA.edits).toHaveLength(1);
    // relative from refA dir (tasks/) to new path (prds/prd-bar.md)
    expect(changeA.edits[0].newText).toBe("../prds/prd-bar.md");

    const changeB = result.documentChanges.find(
      (c) => c.textDocument.uri === `file://${refBPath}`,
    );
    expect(changeB).toBeDefined();
    expect(changeB.edits).toHaveLength(1);
    // relative from refB dir (engineering/tasks/) to new path
    expect(changeB.edits[0].newText).toBe("../../02-product/prds/prd-bar.md");
  });

  test("skips non-.md files in rename list", async () => {
    const connection = makeConnection();
    const vaultIndex = makeVaultIndex([]);
    const docs = makeDocs({});
    register({ connection, docs, vaultIndex, projectRoot: ROOT });

    const result = await connection.workspace._willRenameHandler({
      files: [
        {
          oldUri: "file:///vault/some-image.png",
          newUri: "file:///vault/some-image-renamed.png",
        },
      ],
    });

    expect(result).toBeNull();
  });
});
