/**
 * Public programmatic API contract — every export advertised in
 * `docs/programmatic-usage.md` MUST resolve, and importing the barrel must
 * NOT trigger any CLI side-effect (chdir / exit / network).
 *
 * This test pins three things:
 *   1. The named exports from the barrel (`lib/index.js`) are present and
 *      callable.
 *   2. Each subpath in the `exports` map resolves to a module with at least
 *      one expected named export.
 *   3. Importing the orchestrator (cli/validate-documents.js) does not run
 *      its CLI `main()` — verified indirectly: cwd is unchanged after import.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf-8"));

// We import via repo-relative file paths (Bun doesn't resolve the package
// name to itself by default). The `exports` map is asserted independently
// by reading package.json.

describe("public API — barrel", () => {
  test("lib/index.js re-exports the documented surface", async () => {
    const cwdBefore = process.cwd();
    const mod = await import("../lib/index.js");

    // cwd must NOT have moved as a side-effect of import.
    expect(process.cwd()).toBe(cwdBefore);

    // I/O
    expect(typeof mod.parseDocument).toBe("function");
    expect(typeof mod.resolveDocPath).toBe("function");

    // Template rules
    expect(typeof mod.loadTemplateRules).toBe("function");
    expect(typeof mod.parseBodySchema).toBe("function");
    expect(typeof mod.findSectionRuleBlocks).toBe("function");

    // Schema engine
    expect(typeof mod.applyFieldSchema).toBe("function");
    expect(typeof mod.applyBodySchema).toBe("function");
    expect(typeof mod.validateTemplateSchema).toBe("function");
    expect(typeof mod.validateBodyTemplateSchema).toBe("function");

    // Pure validators
    expect(typeof mod.validateTemplateField).toBe("function");
    expect(typeof mod.validateTemplateMetaLeak).toBe("function");
    expect(typeof mod.validateSlug).toBe("function");
    expect(typeof mod.validatePaths).toBe("function");
    expect(typeof mod.validateSectionRulesLeak).toBe("function");
    expect(typeof mod.suggestSlug).toBe("function");
    expect(typeof mod.stripCodeRegions).toBe("function");
    expect(typeof mod.inferDocType).toBe("function");
    expect(typeof mod.isTemplateFile).toBe("function");
    expect(typeof mod.isTemplateInstance).toBe("function");
    expect(typeof mod.findTemplateMetaLeaks).toBe("function");
    expect(mod.CONFIG).toBeDefined();

    // Formatter
    expect(typeof mod.formatVaultDocument).toBe("function");
    expect(typeof mod.formatVaultDocumentAsync).toBe("function");

    // Conditional DSL
    expect(typeof mod.evaluateCondition).toBe("function");
    expect(typeof mod.getField).toBe("function");

    // Vault config
    expect(typeof mod.resolveProjectRoot).toBe("function");
    expect(typeof mod.loadVaultConfig).toBe("function");

    // Orchestrator
    expect(typeof mod.validateDocument).toBe("function");
    expect(typeof mod.findDocuments).toBe("function");
    expect(typeof mod.findAllFiles).toBe("function");
    // LSP-side validator
    expect(typeof mod.validateBuffer).toBe("function");

    // Utility
    expect(typeof mod.deepFreeze).toBe("function");

    // Version
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.VERSION).toBe(pkg.version);
  });

  test("barrel exports are callable in their pure form", async () => {
    const { applyFieldSchema, suggestSlug, evaluateCondition, getField } =
      await import("../lib/index.js");

    // applyFieldSchema — empty schema => no issues
    const issues = applyFieldSchema({}, { template: "foo.md" }, "foo.md");
    expect(Array.isArray(issues)).toBe(true);

    // suggestSlug
    expect(suggestSlug("My Note Title")).toBe("my-note-title");

    // conditional DSL
    expect(evaluateCondition("status in ['draft']", { status: "draft" })).toBe(
      true,
    );
    expect(getField({ a: { b: 1 } }, "a.b")).toBe(1);
  });
});

describe("public API — exports map", () => {
  const expectedSubpaths = {
    ".": ["applyFieldSchema", "validateDocument"],
    "./doc-io": ["parseDocument", "resolveDocPath"],
    "./schema-engine": ["applyFieldSchema", "applyBodySchema", "validateTemplateSchema", "validateBodyTemplateSchema"],
    "./template-rules": ["loadTemplateRules"],
    "./template-section-rules": [
      "parseBodySchema",
      "findSectionRuleBlocks",
    ],
    "./formatter": ["formatVaultDocument", "formatVaultDocumentAsync"],
    "./conditional-eval": ["evaluate", "getField"],
    "./validators": ["validateSlug", "validateSectionRulesLeak", "CONFIG"],
    "./vault-config": ["resolveProjectRoot", "loadVaultConfig"],
    "./utils": ["deepFreeze"],
    "./orchestrator": ["validateDocument", "findDocuments", "findAllFiles"],
    "./lsp-validator": ["validateBuffer"],
  };

  test("every advertised subpath is declared in package.json", () => {
    expect(pkg.exports).toBeDefined();
    for (const subpath of Object.keys(expectedSubpaths)) {
      expect(pkg.exports[subpath]).toBeDefined();
    }
  });

  test("every advertised subpath resolves and exposes its named exports", async () => {
    for (const [subpath, expectedExports] of Object.entries(expectedSubpaths)) {
      const target = pkg.exports[subpath];
      // Convert the package-relative path to an absolute file path for
      // dynamic import. The exports map values are always strings here.
      const abs = resolve(REPO, target);
      const mod = await import(abs);
      for (const name of expectedExports) {
        expect(mod[name]).toBeDefined();
      }
    }
  });

  test("deep-path back-compat — lib/cli/server wildcards still resolve", () => {
    expect(pkg.exports["./lib/*"]).toBe("./lib/*");
    expect(pkg.exports["./cli/*"]).toBe("./cli/*");
    expect(pkg.exports["./server/*"]).toBe("./server/*");
  });

  test("package.json is exposed via the exports map", () => {
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });
});

describe("public API — orchestrator side-effect safety", () => {
  test("importing the orchestrator does not change cwd or env", async () => {
    const cwdBefore = process.cwd();
    const envBefore = process.env.CLAUDE_PROJECT_DIR;
    await import("../cli/validate-documents.js");
    expect(process.cwd()).toBe(cwdBefore);
    expect(process.env.CLAUDE_PROJECT_DIR).toBe(envBefore);
  });
});
