/**
 * Tests for server/providers/code-lens.js
 *
 * Strategy: mock LSP connection, TextDocuments, and VaultIndex.
 * All markdown is inline strings.
 */

import { describe, test, expect } from "bun:test";

// ── Minimal mocks ─────────────────────────────────────────────────────────

function makeConnection() {
  let handler = null;
  return {
    onCodeLens(fn) { handler = fn; },
    console: { error() {} },
    async callLens(params) { return handler(params); },
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

const { register } = await import("../../server/providers/code-lens.js");

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
  return () => connection.callLens({ textDocument: { uri: URI } });
}

// ── Tests: empty doc ──────────────────────────────────────────────────────

describe("code-lens — empty doc", () => {
  test("returns [] for empty text", async () => {
    const call = setup("");
    const lenses = await call();
    expect(lenses).toEqual([]);
  });

  test("returns [] when doc not found", async () => {
    const connection = makeConnection();
    const docs = { get: () => null };
    register({ connection, docs, vaultIndex: makeVaultIndex(), projectRoot: PROJECT_ROOT });
    const lenses = await connection.callLens({ textDocument: { uri: URI } });
    expect(lenses).toEqual([]);
  });
});

// ── Tests: template: line lens ────────────────────────────────────────────

describe("code-lens — template: line", () => {
  const doc = `---
id: prd-001
template: templates/prd-template.md
status: draft
updated_at: 2026-01-01T00:00:00+07:00
---

## Acceptance Criteria

### AC1 — Basic feature — \`must\` · \`draft\`

Some description.

`;

  test("lens appears above template: line", async () => {
    const call = setup(doc, {
      vaultIndex: { backlinks: [{ source: "/a.md", line: 1 }, { source: "/b.md", line: 2 }] },
    });
    const lenses = await call();
    const templateLens = lenses.find((l) => l.command.command === "vault-keeper.openBacklinkList");
    expect(templateLens).toBeDefined();
  });

  test("template lens shows backlink count", async () => {
    const call = setup(doc, {
      vaultIndex: { backlinks: [{ source: "/a.md", line: 1 }, { source: "/b.md", line: 2 }] },
    });
    const lenses = await call();
    const templateLens = lenses.find((l) => l.command.command === "vault-keeper.openBacklinkList");
    expect(templateLens.command.title).toContain("↗ 2 backlinks");
  });

  test("template lens shows AC count", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const templateLens = lenses.find((l) => l.command.command === "vault-keeper.openBacklinkList");
    expect(templateLens.command.title).toContain("⬆ 1 acceptance criteria");
  });

  test("template lens shows days ago when updated_at present", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const templateLens = lenses.find((l) => l.command.command === "vault-keeper.openBacklinkList");
    expect(templateLens.command.title).toMatch(/⏱ updated \d+d ago/);
  });

  test("template lens has correct range on the template: line", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const templateLens = lenses.find((l) => l.command.command === "vault-keeper.openBacklinkList");
    const lines = doc.split("\n");
    const lineIdx = lines.findIndex((l) => /^template:/.test(l));
    expect(templateLens.range.start.line).toBe(lineIdx);
    expect(templateLens.range.start.character).toBe(0);
    expect(templateLens.range.end.character).toBe(1);
  });

  test("no updated_at → days ago omitted from title", async () => {
    const docNoDate = `---
id: prd-002
template: templates/prd-template.md
status: draft
---

`;
    const call = setup(docNoDate, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const templateLens = lenses.find((l) => l.command.command === "vault-keeper.openBacklinkList");
    expect(templateLens.command.title).not.toContain("⏱");
  });
});

// ── Tests: ## Acceptance Criteria lens ───────────────────────────────────

describe("code-lens — ## Acceptance Criteria", () => {
  const doc = `---
id: prd-003
---

## Acceptance Criteria

### AC1 — Feature X — \`must\` · \`draft\`

Description.

`;

  test("lens appears with correct command", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const acLens = lenses.find((l) => l.command.command === "vault-keeper.runTestsForDoc");
    expect(acLens).toBeDefined();
    expect(acLens.command.title).toBe("▶ Run test cases for all ACs");
  });

  test("lens range is on ## Acceptance Criteria line", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const acLens = lenses.find((l) => l.command.command === "vault-keeper.runTestsForDoc");
    const lines = doc.split("\n");
    const lineIdx = lines.findIndex((l) => l === "## Acceptance Criteria");
    expect(acLens.range.start.line).toBe(lineIdx);
  });
});

// ── Tests: ## Ship Timeline lens ─────────────────────────────────────────

describe("code-lens — ## Ship Timeline", () => {
  const docUnlocked = `---
id: prd-004
---

## Ship Timeline

Some description.

`;

  const docLocked = `---
id: prd-005
---

## Ship Timeline

**Target ship date**: 2026-06-01 · Locked at: 2026-05-01T00:00:00Z · Locked by: @alice

`;

  test("shows lock lens when ship timeline is not locked", async () => {
    const call = setup(docUnlocked, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const lens = lenses.find((l) => l.command.command === "vault-keeper.toggleShipTimelineLock");
    expect(lens).toBeDefined();
    expect(lens.command.title).toBe("🔒 Lock target date");
  });

  test("shows unlock lens when ship timeline is locked", async () => {
    const call = setup(docLocked, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const lens = lenses.find((l) => l.command.command === "vault-keeper.toggleShipTimelineLock");
    expect(lens).toBeDefined();
    expect(lens.command.title).toBe("🔓 Unlock target");
  });

  test("lens range is on ## Ship Timeline line", async () => {
    const call = setup(docUnlocked, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const lens = lenses.find((l) => l.command.command === "vault-keeper.toggleShipTimelineLock");
    const lines = docUnlocked.split("\n");
    const lineIdx = lines.findIndex((l) => l === "## Ship Timeline");
    expect(lens.range.start.line).toBe(lineIdx);
    expect(lens.range.start.character).toBe(0);
    expect(lens.range.end.character).toBe(1);
  });
});

// ── Tests: ## Decision Log lens ───────────────────────────────────────────

describe("code-lens — ## Decision Log", () => {
  const doc = `---
id: t-007
---

## Decision Log

| Decision | By | At |
|---|---|---|
| Use Postgres | @alice | 2026-01-01 |

`;

  test("lens appears above ## Decision Log with add-entry command", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const lens = lenses.find((l) => l.command.command === "vault-keeper.addDecision");
    expect(lens).toBeDefined();
    expect(lens.command.title).toBe("+ Add decision entry");
  });

  test("lens range is on ## Decision Log line", async () => {
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    const lens = lenses.find((l) => l.command.command === "vault-keeper.addDecision");
    const lines = doc.split("\n");
    const lineIdx = lines.findIndex((l) => l === "## Decision Log");
    expect(lens.range.start.line).toBe(lineIdx);
  });
});

// ── Tests: multiple lenses in one document ────────────────────────────────

describe("code-lens — multiple lenses in one doc", () => {
  const fullDoc = `---
id: prd-010
template: templates/prd-template.md
status: draft
updated_at: 2026-04-01T00:00:00+07:00
---

## Acceptance Criteria

### AC1 — Login — \`must\` · \`draft\`

Description.

## Ship Timeline

Some description.

## Decision Log

| Decision | By | At |
|---|---|---|
| Chose approach A | @alice | 2026-01-01 |

`;

  test("returns all expected lenses", async () => {
    const call = setup(fullDoc, {
      vaultIndex: { backlinks: [{ source: "/x.md", line: 1 }] },
    });
    const lenses = await call();
    const commands = lenses.map((l) => l.command.command);
    expect(commands).toContain("vault-keeper.openBacklinkList");
    expect(commands).toContain("vault-keeper.runTestsForDoc");
    expect(commands).toContain("vault-keeper.toggleShipTimelineLock");
    expect(commands).toContain("vault-keeper.addDecision");
  });

  test("each lens uri argument matches doc uri", async () => {
    const call = setup(fullDoc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    for (const lens of lenses) {
      if (lens.command.arguments) {
        expect(lens.command.arguments[0]).toBe(URI);
      }
    }
  });
});

// ── Tests: error resilience ───────────────────────────────────────────────

describe("code-lens — error resilience", () => {
  test("no throw on doc with no frontmatter", async () => {
    const doc = `# Heading only

## Acceptance Criteria

### AC1 — X — \`must\` · \`draft\`

`;
    const call = setup(doc, { vaultIndex: { backlinks: [] } });
    const lenses = await call();
    expect(Array.isArray(lenses)).toBe(true);
  });

  test("no throw when vaultIndex is null", async () => {
    const doc = `---
id: t-008
template: templates/task-template.md
---

## Decision Log

`;
    const connection = makeConnection();
    const docs = makeDocs(doc, URI);
    register({ connection, docs, vaultIndex: null, projectRoot: PROJECT_ROOT });
    const lenses = await connection.callLens({ textDocument: { uri: URI } });
    expect(Array.isArray(lenses)).toBe(true);
  });
});

// ── Tests: non-vault URI rejected (isVaultUri negative branch) ────────────
// Regression guard for the reject path: a lens-worthy doc that EXISTS but
// whose URI resolves OUTSIDE projectRoot must yield [] solely because of the
// isVaultUri gate (not the no-doc / empty-text paths). If the gate is removed
// this test fails (returns populated lenses).

describe("code-lens — non-vault URI rejected", () => {
  test("lens-worthy doc OUTSIDE projectRoot returns [] (relative starts with ..)", async () => {
    const outsideUri = "file:///elsewhere/test.md"; // relative("/vault", ...) → "../elsewhere/test.md"
    const lensWorthy = `---
id: prd-001
template: templates/prd-template.md
status: draft
updated_at: 2026-01-01T00:00:00+07:00
---

## Acceptance Criteria

### AC1 — Login — \`must\` · \`draft\`

Description.

`;
    const connection = makeConnection();
    const docs = { get: (u) => (u === outsideUri ? { getText: () => lensWorthy, uri: u } : null) };
    register({
      connection,
      docs,
      vaultIndex: makeVaultIndex({ backlinks: [{ source: "/a.md", line: 1 }] }),
      projectRoot: PROJECT_ROOT,
    });
    const lenses = await connection.callLens({ textDocument: { uri: outsideUri } });
    expect(lenses).toEqual([]);
  });
});
