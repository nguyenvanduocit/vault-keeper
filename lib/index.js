/**
 * Public programmatic API for claude-code-vault-keeper.
 *
 * Every function the CLI and LSP build on is re-exported here so external
 * scripts (custom reporters, dashboards, CI gates, editor integrations) can
 * `import { … } from 'claude-code-vault-keeper'` without reaching into
 * internal file paths.
 *
 * Full reference: see `docs/programmatic-usage.md`.
 *
 * Stability:
 *   - Re-exports below are part of the public contract — semver applies.
 *   - The `./lib/*` deep-import wildcard was removed in v0.11.0. External
 *     consumers must use the named entry points listed in `package.json`
 *     exports (`./schema-engine`, `./validators`, `./template-rules`, ...);
 *     paths inside `lib/` are private and may move without notice.
 *
 * The orchestrator (`validateDocument`, `findDocuments`, `findAllFiles`)
 * lives under `cli/` for historical reasons but is pure as imported — its
 * direct-entry guard prevents `main()` from running when imported as a module.
 */

// ── Document I/O ──────────────────────────────────────────────────────────
export { parseDocument, resolveDocPath } from "./doc-io.js";

// ── Template rules ────────────────────────────────────────────────────────
export { loadTemplateRules } from "./template-rules.js";
export {
  parseBodySchema,
  findSectionRuleBlocks,
} from "./template-section-rules.js";

// ── Schema engine (composable validation primitives) ──────────────────────
export {
  applyFieldSchema,
  applyBodySchema,
  applyBodySchemaAsync,
  validateTemplateSchema,
  validateBodyTemplateSchema,
} from "./schema-engine.js";

// ── Validators (pure) ─────────────────────────────────────────────────────
export {
  CONFIG,
  validateTemplateField,
  validateTemplateMetaLeak,
  validateSlug,
  validatePaths,
  validateSectionRulesLeak,
  suggestSlug,
  stripCodeRegions,
  inferDocType,
  isTemplateFile,
  isTemplateInstance,
  findTemplateMetaLeaks,
} from "./validators.js";

// ── Canonical formatter ───────────────────────────────────────────────────
export {
  formatVaultDocument,
  formatVaultDocumentAsync,
} from "./canonical-formatter.js";

// ── Conditional DSL (used inside template field schema) ───────────────────
export { evaluate as evaluateCondition, getField } from "./conditional-eval.js";

// ── Vault config ──────────────────────────────────────────────────────────
export { resolveProjectRoot, loadVaultConfig } from "./vault-config.js";

// ── Utils ─────────────────────────────────────────────────────────────────
export { deepFreeze } from "./utils.js";

// ── High-level orchestrator (CLI-shaped, but importable as a function) ────
//
// Lives under cli/ because it is the entry point validate-documents.js runs;
// the module has an `__isDirectEntry()` guard so importing it does NOT
// execute `main()` / touch process.cwd. Safe to use from any script.
export {
  validateDocument,
  findDocuments,
  findAllFiles,
  main as runValidateCli,
} from "../cli/validate-documents.js";

// ── LSP-side per-buffer validator (no FS scan) ────────────────────────────
//
// Mirror of validateDocument that operates on in-memory text — feed it the
// raw buffer + filepath and it returns the same issue shape as the CLI,
// without reading the file. Useful for editor integrations that haven't
// flushed the buffer to disk yet.
export { validateBuffer } from "../server/validator.js";

// ── Package metadata ──────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const __pkg = JSON.parse(readFileSync(join(__pkgRoot, "package.json"), "utf-8"));

/** Package version string (matches `package.json#version`). */
export const VERSION = __pkg.version;
