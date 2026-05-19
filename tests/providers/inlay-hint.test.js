/**
 * Tests for server/providers/inlay-hint.js
 *
 * Strategy: mock the LSP connection, TextDocuments, and VaultIndex — no
 * filesystem access. All markdown is inline strings.
 */

import { describe, test, expect } from "bun:test";

// ── Minimal mocks ─────────────────────────────────────────────────────────

function makeConnection() {
  let handler = null;
  return {
    languages: {
      inlayHint: {
        on(fn) { handler = fn; },
      },
    },
    console: { error() {} },
    async callHint(params) { return handler(params); },
  };
}

function makeDocs(text, uri = "file:///vault/product-knowledge/test.md") {
  return {
    get(u) {
      if (u === uri) return { getText: () => text, uri: u };
      return null;
    },
  };
}

function makeVaultIndex({ backlinks = [], frontmatterMap = {} } = {}) {
  return {
    getBacklinks(_absPath) { return backlinks; },
    getFrontmatter(absPath) { return frontmatterMap[absPath] ?? null; },
  };
}

// Import the register function
const { register } = await import("../../server/providers/inlay-hint.js");

const PROJECT_ROOT = "/vault";
// Doc lives UNDER projectRoot's vault folder so isVaultUri (mirrors
// server/main.js isVaultFile — relative-to-projectRoot membership in
// vaultFolders) classifies it as a vault file. The default config's
// vaultFolders includes "product-knowledge".
const URI = "file:///vault/product-knowledge/test.md";

function setup(text, opts = {}) {
  const connection = makeConnection();
  const docs = makeDocs(text, URI);
  const vaultIndex = makeVaultIndex(opts.vaultIndex ?? {});
  register({ connection, docs, vaultIndex, projectRoot: PROJECT_ROOT });
  return (extraParams = {}) =>
    connection.callHint({ textDocument: { uri: URI }, ...extraParams });
}

// ── Tests: empty doc ──────────────────────────────────────────────────────

describe("inlay-hint — empty doc", () => {
  test("returns [] for empty text", async () => {
    const call = setup("");
    const hints = await call();
    expect(hints).toEqual([]);
  });

  test("returns [] when doc not found", async () => {
    const connection = makeConnection();
    const docs = { get: () => null };
    const vaultIndex = makeVaultIndex();
    register({ connection, docs, vaultIndex, projectRoot: PROJECT_ROOT });
    const hints = await connection.callHint({ textDocument: { uri: URI } });
    expect(hints).toEqual([]);
  });
});

// ── Tests: ## Relationships heading ───────────────────────────────────────

describe("inlay-hint — ## Relationships heading", () => {
  const relDoc = `---
id: t-001
status: draft
---

## Relationships

- [DIBB-001](../01-strategy/dibb-001.md)
- [PRD-001](../02-product/prd-001.md)
`;

  test("shows (N outgoing, M incoming) on ## Relationships line", async () => {
    const call = setup(relDoc, {
      vaultIndex: { backlinks: [{ source: "/other.md", line: 5 }] },
    });
    const hints = await call();
    const relHint = hints.find((h) => h.label.includes("outgoing"));
    expect(relHint).toBeDefined();
    expect(relHint.label).toBe(" (2 outgoing, 1 incoming)");
  });

  test("position is end of the ## Relationships line", async () => {
    const call = setup(relDoc, {
      vaultIndex: { backlinks: [] },
    });
    const hints = await call();
    const relHint = hints.find((h) => h.label.includes("outgoing"));
    expect(relHint).toBeDefined();
    // ## Relationships is on line 5 (0-indexed) of relDoc
    const lines = relDoc.split("\n");
    const lineIdx = lines.findIndex((l) => l === "## Relationships");
    expect(relHint.position.line).toBe(lineIdx);
    expect(relHint.position.character).toBe("## Relationships".length);
  });

  test("0 incoming when no backlinks", async () => {
    const call = setup(relDoc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const relHint = hints.find((h) => h.label.includes("outgoing"));
    expect(relHint.label).toContain("0 incoming");
  });

  test("doc with no relationships → 0 outgoing", async () => {
    const doc = `---
id: t-002
---

## Relationships

`;
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const relHint = hints.find((h) => h.label.includes("outgoing"));
    expect(relHint.label).toBe(" (0 outgoing, 0 incoming)");
  });
});

// ── Tests: ### ACk heading ────────────────────────────────────────────────

describe("inlay-hint — ### AC heading", () => {
  const acDoc = `---
id: prd-001
status: draft
---

## Acceptance Criteria

### AC1 — User can login — \`must\` · \`draft\`

Given user visits login page

Implemented by:

- [Login Feature](./login.md) — coverage: full

Verified by:

- [Login Test](./login-test.md) — verified 2026-01-01 by [@tester](../../product-data/people/tester.md) — method: manual

`;

  test("AC hint shows implementing and verified counts", async () => {
    const call = setup(acDoc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const acHint = hints.find((h) => h.label.includes("implementing"));
    expect(acHint).toBeDefined();
    expect(acHint.label).toBe(" (implementing: 1, verified by: 1)");
  });

  test("AC hint position is at end of ### AC heading line", async () => {
    const call = setup(acDoc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const acHint = hints.find((h) => h.label.includes("implementing"));
    const lines = acDoc.split("\n");
    const lineIdx = lines.findIndex((l) => l.startsWith("### AC1"));
    expect(acHint.position.line).toBe(lineIdx);
  });

  test("AC with 0 implementing and 0 verified → shows zeros", async () => {
    const doc = `---
id: prd-002
---

## Acceptance Criteria

### AC1 — Basic feature — \`must\` · \`draft\`

Some description.

`;
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const acHint = hints.find((h) => h.label.includes("implementing"));
    expect(acHint).toBeDefined();
    expect(acHint.label).toBe(" (implementing: 0, verified by: 0)");
  });
});

// ── Tests: relationship bullet status/phase hint ──────────────────────────

describe("inlay-hint — relationship bullet target status/phase", () => {
  const relBulletDoc = `---
id: t-003
---

## Relationships

- [DIBB-001](../dibb-001.md)
`;

  test("shows (status: S, phase: P) from target frontmatter", async () => {
    // Doc URI is file:///vault/product-knowledge/test.md → absPath
    // /vault/product-knowledge/test.md → dirname /vault/product-knowledge →
    // resolve("/vault/product-knowledge", "../dibb-001.md") → /vault/dibb-001.md
    const call = setup(relBulletDoc, {
      vaultIndex: {
        backlinks: [],
        frontmatterMap: {
          "/vault/dibb-001.md": { status: "approved", phase: "discovery" },
        },
      },
    });
    const hints = await call();
    const relHint = hints.find((h) => h.label.includes("status:"));
    expect(relHint).toBeDefined();
    expect(relHint.label).toContain("status: approved");
    expect(relHint.label).toContain("phase: discovery");
  });

  test("no hint when target not in vault index", async () => {
    const call = setup(relBulletDoc, {
      vaultIndex: {
        backlinks: [],
        frontmatterMap: {},
      },
    });
    const hints = await call();
    const relHint = hints.find((h) => h.label.includes("status:"));
    expect(relHint).toBeUndefined();
  });
});

// ── Tests: frontmatter status: line ──────────────────────────────────────

describe("inlay-hint — frontmatter status: line", () => {
  const statusDoc = `---
id: t-004
status: in_progress
---

## Phase History

| At | From Phase | To Phase | By | Note |
|---|---|---|---|---|
| 2026-01-01T00:00:00+07:00 | backlog | coding | @alice | |

## Status History

| At | From | To | By | Note |
|---|---|---|---|---|
| 2026-01-10T00:00:00+07:00 | draft | in_progress | @alice | |
`;

  test("shows phase days and status days on status: line", async () => {
    const call = setup(statusDoc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const statusHint = hints.find((h) => h.label.includes("in this phase"));
    expect(statusHint).toBeDefined();
    expect(statusHint.label).toMatch(/in this phase: \d+d/);
    expect(statusHint.label).toMatch(/total in this status: \d+d/);
  });

  test("status: line hint position is within frontmatter", async () => {
    const call = setup(statusDoc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const statusHint = hints.find((h) => h.label.includes("in this phase"));
    expect(statusHint).toBeDefined();
    // status: is on line 2 (0-indexed) of the doc
    expect(statusHint.position.line).toBe(2);
  });

  test("no status hint when no phase/status history", async () => {
    const doc = `---
id: t-005
status: draft
---

No history here.
`;
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    const statusHint = hints.find((h) => h.label.includes("in this phase"));
    expect(statusHint).toBeUndefined();
  });
});

// ── Tests: error resilience ───────────────────────────────────────────────

describe("inlay-hint — error resilience", () => {
  test("no throw on doc with no frontmatter", async () => {
    const doc = `# Just a heading

Some prose.

## Relationships

`;
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const hints = await call();
    expect(Array.isArray(hints)).toBe(true);
  });

  test("no throw when vaultIndex is null", async () => {
    const doc = `---
id: t-006
---

## Relationships

- [X](./x.md)
`;
    const connection = makeConnection();
    const docs = makeDocs(doc, URI);
    register({ connection, docs, vaultIndex: null, projectRoot: PROJECT_ROOT });
    const hints = await connection.callHint({ textDocument: { uri: URI } });
    expect(Array.isArray(hints)).toBe(true);
  });
});

// ── Tests: non-vault URI rejected (isVaultUri negative branch) ────────────
// Regression guard for the reject path: a hint-worthy doc that EXISTS but
// whose URI resolves OUTSIDE projectRoot must yield [] solely because of the
// isVaultUri gate. If the gate is removed this test fails (returns hints).

describe("inlay-hint — non-vault URI rejected", () => {
  test("hint-worthy doc OUTSIDE projectRoot returns [] (relative starts with ..)", async () => {
    const outsideUri = "file:///elsewhere/test.md"; // relative("/vault", ...) → "../elsewhere/test.md"
    const hintWorthy = `---
id: t-001
status: draft
---

## Relationships

- [DIBB-001](../01-strategy/dibb-001.md)
- [PRD-001](../02-product/prd-001.md)
`;
    const connection = makeConnection();
    const docs = { get: (u) => (u === outsideUri ? { getText: () => hintWorthy, uri: u } : null) };
    register({
      connection,
      docs,
      vaultIndex: makeVaultIndex({ backlinks: [{ source: "/other.md", line: 5 }] }),
      projectRoot: PROJECT_ROOT,
    });
    const hints = await connection.callHint({ textDocument: { uri: outsideUri } });
    expect(hints).toEqual([]);
  });
});
