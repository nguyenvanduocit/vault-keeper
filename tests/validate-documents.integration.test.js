/**
 * Integration tests for .claude/skills/tools/validate-documents.js — functions
 * that touch the filesystem.
 *
 * Each test runs inside an isolated temp directory created in beforeEach and
 * removed in afterEach. process.cwd() is also redirected so that
 * validateLinkExistence (which resolves links via process.cwd()) sees the
 * fixture vault as its root.
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
  validateLinkExistence,
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
// validateLinkExistence — directed-edge graph
// ────────────────────────────────────────────────────────────────────────────

describe("validateLinkExistence", () => {
  test("no relationships → no issues", async () => {
    expect(await validateLinkExistence({}, "any.md")).toEqual([]);
  });

  test("link target exists → no issues", async () => {
    writeDoc("dibb.md", md(`template: templates/dibb.md`));
    const prdPath = writeDoc("prd.md", md(`template: templates/prd.md`));

    const issues = await validateLinkExistence(
      { relationships: { implements_bet: [{ path: "dibb.md", title: "DIBB" }] } },
      prdPath,
    );
    expect(issues).toEqual([]);
  });

  test("link target does not exist → broken-link error", async () => {
    const prdPath = writeDoc("prd.md", md(`template: templates/prd.md`));

    const issues = await validateLinkExistence(
      { relationships: { implements_bet: [{ path: "ghost.md" }] } },
      prdPath,
    );
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].level).toBe("error");
    expect(issues[0].message).toMatch(/Broken link/);
  });

  test("relationships entry with no path is skipped silently", async () => {
    const path = writeDoc("x.md", md(`template: templates/x.md`));
    const issues = await validateLinkExistence(
      { relationships: { implements_bet: [{ title: "no path" }] } },
      path,
    );
    expect(issues).toEqual([]);
  });

  test("reference to a template file does not error when the template exists", async () => {
    // validateLinkExistence only checks file existence. Edges to
    // templates are file-system-valid even if semantically dubious (other
    // validators flag those).
    writeDoc(
      "templates/prd-template.md",
      md(`template_id: prd\ndocument_type: prd-template`, "Template scaffold."),
    );
    const sourcePath = writeDoc(
      "product-knowledge/02-product/decisions/decision-001.md",
      md(`template: templates/product-decision-template.md`),
    );

    const issues = await validateLinkExistence(
      {
        relationships: {
          references: [{ path: "templates/prd-template.md" }],
          blocked_by: [{ path: "templates/prd-template.md" }],
        },
      },
      sourcePath,
    );
    expect(issues).toEqual([]);
  });

  test("reference to a MISSING template still produces a broken-link error", async () => {
    const sourcePath = writeDoc(
      "product-knowledge/02-product/decisions/decision-002.md",
      md(`template: templates/product-decision-template.md`),
    );

    const issues = await validateLinkExistence(
      {
        relationships: {
          references: [{ path: "templates/does-not-exist.md" }],
        },
      },
      sourcePath,
    );

    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].level).toBe("error");
    expect(issues[0].message).toMatch(/Broken link/);
  });

  test("multiple relationship types are all checked for link existence", async () => {
    writeDoc("dep.md", md(`template: templates/x.md`));
    const path = writeDoc("a.md", md(`template: templates/x.md`));
    const issues = await validateLinkExistence(
      {
        relationships: {
          depends_on: [{ path: "dep.md" }],
          references: [{ path: "missing.md" }],
        },
      },
      path,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("relationships.references");
    expect(issues[0].message).toMatch(/Broken link/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateDocument — end-to-end on real files
// ────────────────────────────────────────────────────────────────────────────

/** Tiny YAML-fragment helper for required_fields list. */
const yamlList = (arr) => arr.map((s) => `    - ${s}`).join("\n");

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
validation_rules:
  required_fields:
${yamlList(["template"])}
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
validation_rules:
  required_fields:
${yamlList(["template"])}
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
    // Modern schema: rice_score, relationships.* moved to body
    // sections. Template's required_fields are frontmatter-only identity
    // fields. The body-side tracing (relationships, AC) is covered by V13 /
    // V1 rules — not enforced here because this test only exercises
    // frontmatter-level required_fields against a minimal template.
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
validation_rules:
  required_fields:
${yamlList([
  "template",
  "status",
  "owner",
  "created",
  "updated",
])}
  field_rules:
    - field: status
      values: [draft, review, approved]
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
    expect(result.rulesSource).toBe("templates/prd-template.md");
    expect(result.errors).toEqual([]);
  });

  test("PRD missing rice_score (per its template's required_fields) → error", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
validation_rules:
  required_fields:
${yamlList(["template", "status", "owner", "created", "updated", "rice_score"])}
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

  test("PRD with bad filename → path_regex error (template-declared path shape)", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
validation_rules:
  required_fields: [template, status]
  path_regex: "^product-knowledge/02-product/prds/(?:\\\\d{4}-\\\\d{2}-\\\\d{2}-)?prd-\\\\d{3}-[a-z0-9-]+\\\\.md$"
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
    expect(result.errors.map((e) => e.field)).toContain("location");
    const locationErr = result.errors.find((e) => e.field === "location");
    expect(locationErr.error_type).toBe("path-regex-mismatch");
  });

  test("PRD with unquoted YAML date (parsed as Date) is accepted by field_rules.regex", async () => {
    writeDoc(
      "templates/prd-template.md",
      `---
template_id: prd
validation_rules:
  required_fields: [template, status, owner, created, updated]
  field_rules:
    - field: created
      regex: "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"
    - field: updated
      regex: "^\\\\d{4}-\\\\d{2}-\\\\d{2}$"
---
body
`,
    );

    const prdPath = writeDoc(
      "product-knowledge/02-product/prds/2026-01-01-prd-001-x.md",
      md(`template: templates/prd-template.md
status: draft
owner: Duoc
created: 2026-01-01
updated: 2026-01-01`),
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
      && /Cannot load validation_rules.*missing-template\.md/.test(e.message),
    )).toBe(true);
  });

  test("doc whose template has no validation_rules block → hard error", async () => {
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
    expect(result.rulesSource).toBeNull();
    expect(result.errors.some((e) =>
      e.field === "template"
      && /no-rules\.md.*missing validation_rules/.test(e.message),
    )).toBe(true);
  });

  test("conditional rule fires only when condition matches", async () => {
    writeDoc(
      "templates/with-cond.md",
      `---
template_id: cond
validation_rules:
  required_fields: [template, status]
  conditional_required_fields:
    - condition: "status in ['shipped']"
      field: shipped_at
      required: true
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

  test("conditional body_section: rule fires when condition matches and section missing", async () => {
    writeDoc(
      "templates/prd-cond.md",
      `---
template_id: prd-cond
validation_rules:
  required_fields: [template, status]
  field_rules:
    - field: status
      values: [draft, approved, in_progress, shipped]
  conditional_required_fields:
    - condition: "status not in ['draft']"
      field: "body_section:## Ship Timeline"
      required: true
---
body
`,
    );

    // Draft status — condition false → no error about Ship Timeline
    const draftPath = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-draft-cond.md",
      md(`template: templates/prd-cond.md\nstatus: draft`, "## Other\n\nBody."),
    );
    const draftResult = await validateDocument(draftPath);
    const draftShipIssues = draftResult.errors.filter(
      (e) => e.field === "body_section:## Ship Timeline",
    );
    expect(draftShipIssues).toEqual([]);

    // Approved status — condition true, section missing → error
    const approvedPath = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-approved-cond.md",
      md(`template: templates/prd-cond.md\nstatus: approved`, "## Other\n\nBody."),
    );
    const approvedResult = await validateDocument(approvedPath);
    const approvedShipIssues = approvedResult.errors.filter(
      (e) => e.field === "body_section:## Ship Timeline",
    );
    expect(approvedShipIssues).toHaveLength(1);
    expect(approvedShipIssues[0].message).toContain("Ship Timeline");

    // Approved status with section present → no error
    const withSectionPath = writeDoc(
      "product-knowledge/01-strategy/dibbs/2026-01-01-dibb-001-with-ship.md",
      md(
        `template: templates/prd-cond.md\nstatus: approved`,
        "## Ship Timeline\n\n**Target ship date**: 2026-06-15\n",
      ),
    );
    const withSectionResult = await validateDocument(withSectionPath);
    const withSectionShipIssues = withSectionResult.errors.filter(
      (e) => e.field === "body_section:## Ship Timeline",
    );
    expect(withSectionShipIssues).toEqual([]);
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
