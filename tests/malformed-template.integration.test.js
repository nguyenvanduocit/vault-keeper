/**
 * Integration test: malformed templates must produce structured
 * `template-schema-invalid` errors — never crash the validation engine.
 *
 * Covers BOTH the CLI path (validateDocument) and the LSP path (validateBuffer)
 * to prove that neither throws when fed a deliberately broken template containing:
 *   - Uncompilable regex (`[unclosed`)
 *   - Non-array enum (`123`)
 *   - `min` without a declared `type`
 *   - Unknown primitive (`flibbertigibbet`)
 *   - Synthetic field misuse (`$path: { required: true }`)
 *   - Malformed formula expression (`a + + b`)
 *   - Unknown section-rules key (`notaprimitive`)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { validateDocument } from "../cli/validate-documents.js";
import { validateBuffer } from "../server/validator.js";
import { _resetVaultConfigCache } from "../lib/vault-config.js";

// ────────────────────────────────────────────────────────────────────────────
// Per-test sandbox
// ────────────────────────────────────────────────────────────────────────────

let SANDBOX;
let ORIGINAL_CWD;

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "vault-keeper-malformed-"));
  ORIGINAL_CWD = process.cwd();
  process.chdir(SANDBOX);

  // Minimal vault config so validators resolve paths correctly.
  mkdirSync(join(SANDBOX, ".claude"), { recursive: true });
  writeFileSync(
    join(SANDBOX, ".claude", "vault-keeper.json"),
    JSON.stringify({
      vaultFolders: ["docs"],
      excludePatterns: [],
    }),
    "utf-8",
  );

  _resetVaultConfigCache();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  rmSync(SANDBOX, { recursive: true, force: true });
  _resetVaultConfigCache();
});

/** Write a file inside the sandbox (creating directories as needed). */
function writeFile(relPath, content) {
  const abs = join(SANDBOX, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return relPath;
}

// ────────────────────────────────────────────────────────────────────────────
// Broken template content
// ────────────────────────────────────────────────────────────────────────────

const BROKEN_TEMPLATE = `---
template_id: broken
fields:
  title:
    type: string
    pattern: "[unclosed"
  priority:
    enum: 123
  score:
    min: 0
  mood:
    flibbertigibbet: true
  $path:
    required: true
---
# {{title}}

## Metrics

\`\`\`yaml section-rules
table:
  columns: [Metric, Value]
formula: "a + + b"
notaprimitive: true
\`\`\`

| Metric | Value |
|--------|-------|
| a      | 1     |
`;

const DOC_USING_BROKEN_TEMPLATE = `---
template: templates/broken-template.md
title: Test Doc
priority: high
score: 5
mood: happy
---
# Test Doc

## Metrics

| Metric | Value |
|--------|-------|
| a      | 1     |
`;

// ────────────────────────────────────────────────────────────────────────────
// CLI path: validateDocument
// ────────────────────────────────────────────────────────────────────────────

describe("malformed template — CLI validateDocument", () => {
  test("produces structured template-schema-invalid errors, never throws", async () => {
    writeFile("templates/broken-template.md", BROKEN_TEMPLATE);
    const docPath = writeFile("docs/test-doc.md", DOC_USING_BROKEN_TEMPLATE);

    // This MUST NOT throw — that is the primary assertion.
    const result = await validateDocument(docPath, { projectRoot: SANDBOX });

    expect(result).toBeDefined();
    expect(result.valid).toBe(false);

    const allIssues = [...result.errors, ...result.warnings];
    const schemaErrors = allIssues.filter(
      (i) => i.error_type === "template-schema-invalid",
    );

    // Must contain structured errors naming each broken construct
    expect(schemaErrors.length).toBeGreaterThanOrEqual(1);

    // Verify specific broken constructs are reported
    const messages = schemaErrors.map((e) => e.message).join("\n");

    // Uncompilable regex on `title.pattern`
    expect(messages).toMatch(/pattern/i);

    // Non-array enum on `priority`
    expect(messages).toMatch(/enum/i);

    // min without type on `score`
    expect(messages).toMatch(/min/i);

    // Unknown primitive `flibbertigibbet` on `mood`
    expect(messages).toMatch(/flibbertigibbet/i);

    // Synthetic field misuse `$path.required`
    expect(messages).toMatch(/\$path/);

    // All schema errors must have level "error"
    for (const e of schemaErrors) {
      expect(e.level).toBe("error");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// LSP path: validateBuffer
// ────────────────────────────────────────────────────────────────────────────

describe("malformed template — LSP validateBuffer", () => {
  test("produces structured template-schema-invalid errors, never throws", async () => {
    writeFile("templates/broken-template.md", BROKEN_TEMPLATE);

    // validateBuffer takes in-memory text, not a file path.
    const { issues, skipped } = await validateBuffer({
      text: DOC_USING_BROKEN_TEMPLATE,
      filepath: "docs/test-doc.md",
      projectRoot: SANDBOX,
    });

    expect(skipped).toBe(false);

    const schemaErrors = issues.filter(
      (i) => i.error_type === "template-schema-invalid",
    );

    // Must contain structured errors naming each broken construct
    expect(schemaErrors.length).toBeGreaterThanOrEqual(1);

    const messages = schemaErrors.map((e) => e.message).join("\n");

    // Same broken constructs surfaced as in CLI
    expect(messages).toMatch(/pattern/i);
    expect(messages).toMatch(/enum/i);
    expect(messages).toMatch(/min/i);
    expect(messages).toMatch(/flibbertigibbet/i);
    expect(messages).toMatch(/\$path/);

    // All schema errors must have level "error"
    for (const e of schemaErrors) {
      expect(e.level).toBe("error");
    }

    // No secondary crash-related issues — only template-schema-invalid and
    // cross-cutting validators (template-field, slug, paths, etc.)
    const crashIndicators = issues.filter(
      (i) =>
        i.message?.includes("Invalid regular expression") ||
        i.message?.includes("is not a function") ||
        i.message?.includes("Cannot read properties"),
    );
    expect(crashIndicators).toHaveLength(0);
  });
});
