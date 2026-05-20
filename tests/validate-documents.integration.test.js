/**
 * Integration tests for .claude/skills/tools/validate-documents.js — functions
 * that touch the filesystem.
 *
 * Each test runs inside an isolated temp directory created in beforeEach and
 * removed in afterEach. process.cwd() is also redirected so that validators
 * (which resolve paths via process.cwd()) see the fixture vault as their root.
 *
 * Pure-function coverage lives in validate-documents.test.js.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDocument,
  validateDocument,
  findDocuments,
} from "../cli/validate-documents.js";
import { _resetVaultConfigCache } from "../lib/vault-config.js";

// ────────────────────────────────────────────────────────────────────────────
// Per-test sandbox: temp dir + cwd redirection
// ────────────────────────────────────────────────────────────────────────────

// Pinned fixture config so these tests assert validator behavior against a
// known folder→regex map regardless of what lib/vault-config.js defaults to.
const TEST_CONFIG_PATH = resolve(
  fileURLToPath(new URL("./fixtures/test-vault-paths.json", import.meta.url)),
);

let SANDBOX;
let ORIGINAL_CWD;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "vault-keeper-test-"));
  ORIGINAL_CWD = process.cwd();
  process.chdir(SANDBOX);
  // Drop the test fixture config into the sandbox so the validator sees
  // product-knowledge paths as content folders / named conventions.
  mkdirSync(join(SANDBOX, ".claude"), { recursive: true });
  copyFileSync(TEST_CONFIG_PATH, join(SANDBOX, ".claude", "vault-keeper.json"));
  _resetVaultConfigCache();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  rmSync(SANDBOX, { recursive: true, force: true });
  _resetVaultConfigCache();
});

/** Write a markdown file (with directory creation) inside the sandbox. */
function writeDoc(relPath, content) {
  const abs = join(SANDBOX, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return relPath; // most validate-documents APIs expect cwd-relative paths
}

/** Build a frontmatter + body string. */
function md(frontmatter, body = "Body.") {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

// ────────────────────────────────────────────────────────────────────────────
// parseDocument
// ────────────────────────────────────────────────────────────────────────────

describe("parseDocument", () => {
  test("parses frontmatter and body from a valid markdown file", async () => {
    const path = writeDoc(
      "doc.md",
      md(`title: Hello\nstatus: draft`, "# Hello\n\nBody text."),
    );
    const result = await parseDocument(path);

    expect(result.error).toBeUndefined();
    expect(result.filepath).toBe(path);
    expect(result.frontmatter).toEqual({ title: "Hello", status: "draft" });
    expect(result.body).toContain("# Hello");
    expect(result.body).toContain("Body text.");
  });

  test("returns {error} when file does not exist", async () => {
    const result = await parseDocument("does-not-exist.md");
    expect(result.error).toBeDefined();
    expect(result.frontmatter).toBeUndefined();
  });

  test("returns frontmatter={} and full body when file has no frontmatter", async () => {
    const path = writeDoc("plain.md", "# Plain\n\nNo frontmatter here.");
    const result = await parseDocument(path);

    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("# Plain");
  });

  test("returns {error} when YAML is malformed", async () => {
    const path = writeDoc(
      "broken.md",
      "---\nbad: [unclosed\n---\nbody\n",
    );
    const result = await parseDocument(path);
    expect(result.error).toBeDefined();
  });

  test("YAML unquoted date is parsed into a JS Date object (gray-matter contract)", async () => {
    // Pinning this behaviour is what motivates the validateDates Date-aware
    // branch — if gray-matter ever changes parsing, this test fires loudly.
    const path = writeDoc("dated.md", md(`created: 2026-01-01`));
    const result = await parseDocument(path);
    expect(result.frontmatter.created).toBeInstanceOf(Date);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateDocument — end-to-end on real files
// ────────────────────────────────────────────────────────────────────────────

describe("validateDocument (end-to-end)", () => {
  test("template file under templates/ is skipped (not validated)", async () => {
    // Note: skipping happens BEFORE parsing, so even malformed YAML in a
    // template doesn't cause a parse-failure result.
    const path = writeDoc(
      "templates/prd.md",
      md(`template: scaffold\nstatus: WHATEVER\nowner: [@handle]`),
    );

    const result = await validateDocument(path);
    expect(result.skipped).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.docType).toBe("template");
    expect(result.errors).toEqual([]);
  });

  test("template carrying a `yaml section-rules` fence is still skipped (not flagged)", async () => {
    // Regression guard: the section-rules fence is legitimate inside a
    // template. isTemplateFile() must short-circuit before the leak rule runs.
    const path = writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
fields:
  template:
    required: true
---
## Acceptance Criteria

\`\`\`yaml section-rules
required: true
\`\`\`
`,
    );

    const result = await validateDocument(path);
    expect(result.skipped).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("document body carrying a `yaml section-rules` fence → section-rules-leak error", async () => {
    writeDoc(
      "templates/note-template.md",
      `---
template_id: note
fields:
  template:
    required: true
---
body
`,
    );

    const notePath = writeDoc(
      "product-knowledge/notes/my-note.md",
      `---
template: templates/note-template.md
---
## Acceptance Criteria

\`\`\`yaml section-rules
required: true
\`\`\`
`,
    );

    const result = await validateDocument(notePath);
    expect(result.valid).toBe(false);
    const leaks = result.errors.filter(
      (e) => e.error_type === "section-rules-leak",
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0].level).toBe("error");
    expect(leaks[0].field).toBe("body");
  });

  test("fully valid PRD against its template's rules → valid: true", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
fields:
  template:
    required: true
  status:
    required: true
    enum: [draft, review, approved]
  owner:
    required: true
  created:
    required: true
  updated:
    required: true
---
body
`,
    );

    const prdPath = writeDoc(
      "product-knowledge/02-product/prds/2026-01-01-prd-001-x.md",
      md(`template: templates/prd-template.md
status: draft
owner: Duoc
created: "2026-01-01T00:00:00+07:00"
updated: "2026-01-01T00:00:00+07:00"`),
    );

    const result = await validateDocument(prdPath);
    expect(result.valid).toBe(true);
    expect(result.docType).toBe("prd");
    expect(result.errors).toEqual([]);
  });

  test("PRD missing rice_score (per its template's fields) → error", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
fields:
  template:
    required: true
  status:
    required: true
  owner:
    required: true
  created:
    required: true
  updated:
    required: true
  rice_score:
    required: true
---
body
`,
    );

    const prdPath = writeDoc(
      "product-knowledge/02-product/prds/2026-01-01-prd-001-x.md",
      md(`template: templates/prd-template.md
status: draft
owner: Duoc
created: "2026-01-01"
updated: "2026-01-01"`),
    );

    const result = await validateDocument(prdPath);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("rice_score");
  });

  test("PRD with bad filename → pattern-mismatch error (template-declared path shape)", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
fields:
  template:
    required: true
  status:
    required: true
  $path:
    pattern: "^product-knowledge/02-product/prds/(?:\\\\d{4}-\\\\d{2}-\\\\d{2}-)?prd-\\\\d{3}-[a-z0-9-]+\\\\.md$"
---
body
`,
    );

    const prdPath = writeDoc(
      "product-knowledge/02-product/prds/random-name.md",
      md(`template: templates/prd-template.md
status: draft
owner: Duoc
created: "2026-01-01"
updated: "2026-01-01"`),
    );

    const result = await validateDocument(prdPath);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("$path");
    const pathErr = result.errors.find((e) => e.field === "$path");
    expect(pathErr.error_type).toBe("pattern-mismatch");
  });

  test("PRD with quoted YAML date strings pass field pattern validation", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
fields:
  template:
    required: true
  status:
    required: true
  owner:
    required: true
  created:
    required: true
    pattern: "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"
  updated:
    required: true
    pattern: "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"
---
body
`,
    );

    // Quoted dates stay as strings through gray-matter, so pattern matching works.
    // Unquoted YAML dates are parsed into JS Date objects (gray-matter contract),
    // and the new schema engine's pattern check uses String(value) which yields
    // the verbose Date string — a behavior gap vs the old engine's Date bypass.
    const prdPath = writeDoc(
      "product-knowledge/02-product/prds/2026-01-01-prd-001-x.md",
      md(`template: templates/prd-template.md
status: draft
owner: Duoc
created: "2026-01-01"
updated: "2026-01-01"`),
    );

    const result = await validateDocument(prdPath);
    const dateErrors = result.errors.filter(
      (e) => e.field === "created" || e.field === "updated",
    );
    expect(dateErrors).toEqual([]);
  });

  test("doc whose template does not exist → hard error", async () => {
    // No more migration fallback: an unresolvable template is now a validation
    // error. The actionable error names the offending template path so the
    // author can fix it.
    const path = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-x.md",
      md(`template: templates/missing-template.md
status: draft
owner: Duoc
created: "2026-01-01T00:00:00+07:00"
updated: "2026-01-01T00:00:00+07:00"`),
    );

    const result = await validateDocument(path);
    expect(result.rulesSource).toBeNull();
    expect(result.errors.some((e) =>
      e.field === "template"
      && /Cannot load schema.*missing-template\.md/.test(e.message),
    )).toBe(true);
  });

  test("doc whose template has no fields block → validates with empty schema (no error)", async () => {
    writeDoc(
      "templates/no-rules.md",
      `---\ntemplate_id: foo\n---\nbody\n`,
    );

    const path = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-x.md",
      md(`template: templates/no-rules.md
status: draft
owner: Duoc
created: "2026-01-01"
updated: "2026-01-01"`),
    );

    const result = await validateDocument(path);
    // In the new engine, a template without fields: is valid — it just has no constraints
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("conditional rule fires only when condition matches", async () => {
    writeDoc(
      "templates/with-cond.md",
      `---
template_id: cond
fields:
  template:
    required: true
  status:
    required: true
  shipped_at:
    required:
      when: "status in ['shipped']"
---
body
`,
    );

    const draftDoc = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-draft.md",
      md(`template: templates/with-cond.md\nstatus: draft`),
    );
    const shippedDoc = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-shipped.md",
      md(`template: templates/with-cond.md\nstatus: shipped`),
    );

    const draftResult = await validateDocument(draftDoc);
    const shippedResult = await validateDocument(shippedDoc);

    expect(draftResult.errors.map((e) => e.field)).not.toContain("shipped_at");
    expect(shippedResult.errors.map((e) => e.field)).toContain("shipped_at");
  });

  test("malformed file → returns parse failure as error", async () => {
    const path = writeDoc("bad.md", "---\nbroken: [oops\n---\n");
    const result = await validateDocument(path);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("Failed to parse");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findDocuments
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// findDocuments
// ────────────────────────────────────────────────────────────────────────────

describe("findDocuments", () => {
  test("targetPath pointing to a single .md file returns [that file]", async () => {
    const path = writeDoc("solo.md", md(`x: 1`));
    const docs = await findDocuments(path);
    expect(docs).toEqual([path]);
  });

  test("targetPath pointing to a directory finds all .md files recursively", async () => {
    writeDoc("vault/a.md", md(`x: 1`));
    writeDoc("vault/sub/b.md", md(`x: 2`));
    writeDoc("vault/sub/c.md", md(`x: 3`));

    const docs = await findDocuments("vault");
    expect(docs.sort()).toEqual(
      ["vault/a.md", "vault/sub/b.md", "vault/sub/c.md"].sort(),
    );
  });

  test("excludes README.md and node_modules", async () => {
    writeDoc("vault/a.md", md(`x: 1`));
    writeDoc("vault/README.md", md(`x: 1`));
    writeDoc("vault/node_modules/pkg/readme.md", md(`x: 1`));

    const docs = await findDocuments("vault");
    expect(docs).toEqual(["vault/a.md"]);
  });

  test("when no targetPath given, scans CONFIG content folders", async () => {
    writeDoc("product-knowledge/a.md", md(`x: 1`));
    writeDoc("product-knowledge/sub/b.md", md(`x: 1`));
    writeDoc("unrelated/c.md", md(`x: 1`)); // outside content folders

    const docs = await findDocuments(null);
    expect(docs.sort()).toEqual(
      ["product-knowledge/a.md", "product-knowledge/sub/b.md"].sort(),
    );
  });
});
