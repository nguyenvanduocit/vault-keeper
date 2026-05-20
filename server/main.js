#!/usr/bin/env node
/**
 * main.js — Vault-keeper LSP entry point.
 *
 * Validates a knowledge-vault's markdown documents against the rules each
 * document's template declares (`validation_rules` block in the template's
 * frontmatter):
 *   - required / conditional-required frontmatter fields
 *   - field-rules (regex, enum, type, min)
 *   - template-only-field leakage detection
 *   - slug + naming conventions
 *   - relative-path policy
 *   - body section-rules
 *
 * Cross-document operations:
 *   - documentSymbol — hierarchical symbol tree (frontmatter + headings)
 *   - workspaceSymbol — vault-wide search by id/title/filename
 *   - hover — validation rule info, link target preview
 *   - definition — navigate to link targets
 *   - references — backlinks via incoming markdown-link graph
 *   - implementation — delegates to definition
 *   - callHierarchy — stub (not meaningful for markdown vault)
 *
 * Per-doc only on keystroke. Full-vault checks run via the CLI validator.
 *
 * Lifecycle:
 *   - `didOpen`   → validate immediately
 *   - `didChange` → validate after a 250ms debounce
 *   - `didSave`   → validate (no debounce — user expects fresh feedback)
 *   - files outside the configured vault folders are silently ignored
 */

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  SymbolKind,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, relative, dirname, basename, sep } from "node:path";
import { existsSync, statSync, readFileSync } from "node:fs";
import { validateBuffer } from "./validator.js";
import { issuesToDiagnostics } from "./diagnostics.js";
import { buildFrontmatterLineMap } from "./frontmatter-lines.js";
import { VaultIndex } from "./vault-index.js";
import { getPositionContext } from "./position-context.js";
import { loadTemplateRules } from "../lib/template-rules.js";
import { loadVaultConfig } from "../lib/vault-config.js";

// Provider modules (Wave 1+2 LSP providers — completion, code-action,
// inlay-hint, code-lens, rename, document-formatting). Each module exports a
// static `capability` declaration and a `register({connection, docs,
// vaultIndex, projectRoot})` function. The register() call happens AFTER
// onInitialize sets up vaultIndex so closures capture live references.
import * as completionProvider from "./providers/completion.js";
import * as codeActionProvider from "./providers/code-action.js";
import * as inlayHintProvider from "./providers/inlay-hint.js";
import * as codeLensProvider from "./providers/code-lens.js";
import * as renameProvider from "./providers/rename.js";
import * as documentFormattingProvider from "./providers/document-formatting.js";

const PROVIDERS = [
  completionProvider,
  codeActionProvider,
  inlayHintProvider,
  codeLensProvider,
  renameProvider,
  documentFormattingProvider,
];

// Merge static capability declarations from all providers. Each module exports
// `capability` as a flat object that will be spread into the LSP capabilities
// reply (e.g., `{completionProvider: {triggerCharacters: [...]}}`).
const PROVIDER_CAPABILITIES = PROVIDERS.reduce(
  (acc, p) => Object.assign(acc, p.capability || {}),
  {},
);

// Version is read from package.json at runtime so the bundled LSP never drifts
// from the source-of-truth version.
//
// Two execution modes share this entry point:
//   - ESM source:  `node server/main.js`  → `import.meta.url` resolves.
//   - CJS bundle:  `node server/main.bundled.cjs` (via esbuild --format=cjs)
//                  → esbuild defines `__dirname` but rewrites `import.meta.url`
//                  to an empty placeholder. Prefer `__dirname` when present.
function resolvePkgPath() {
  if (typeof __dirname !== "undefined") {
    return resolve(__dirname, "..", "package.json");
  }
  return fileURLToPath(new URL("../package.json", import.meta.url));
}
const PKG_VERSION = JSON.parse(readFileSync(resolvePkgPath(), "utf-8")).version;

// ── Connection setup ─────────────────────────────────────────────────────────
const connection = createConnection(ProposedFeatures.all);
const docs = new TextDocuments(TextDocument);

let projectRoot = null;
/** @type {VaultIndex | null} */
let vaultIndex = null;
// Populated from lib/vault-config.js once projectRoot is resolved in
// onInitialize. A vault overrides via `.claude/vault-keeper.json` vaultFolders.
// Kept mutable (not a const literal) so the value follows the resolved root.
let VAULT_FOLDERS = loadVaultConfig().vaultFolders;

// ── Lifecycle ────────────────────────────────────────────────────────────────
connection.onInitialize((params) => {
  projectRoot = resolveProjectRoot(params);
  connection.console.info(
    `claude-code-vault-keeper: projectRoot=${projectRoot ?? "(unresolved)"}`,
  );
  if (projectRoot) {
    // Re-resolve vault folders against the now-known project root so a
    // foreign vault's `.claude/vault-keeper.json` takes effect.
    VAULT_FOLDERS = loadVaultConfig(projectRoot).vaultFolders;
    vaultIndex = new VaultIndex(projectRoot);
  }

  // Register provider handlers after vaultIndex is created so closures capture
  // a valid (non-null) reference. Each register() failure is isolated — a
  // single buggy provider must not crash the server.
  for (const p of PROVIDERS) {
    try {
      p.register({ connection, docs, vaultIndex, projectRoot });
    } catch (err) {
      connection.console.error(
        `provider register error: ${err.stack || err}`,
      );
    }
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      implementationProvider: true,
      callHierarchyProvider: true,
      ...PROVIDER_CAPABILITIES,
    },
    serverInfo: { name: "claude-code-vault-keeper", version: PKG_VERSION },
  };
});

connection.onInitialized(() => {
  connection.console.info("claude-code-vault-keeper: initialized, ready for documents");
});

// ── Validation pipeline ──────────────────────────────────────────────────────
// Per-document debounce. We use a Map keyed by URI so different files don't
// cancel each other's pending validations.
const pendingTimers = new Map();
const DEBOUNCE_MS = 250;

function scheduleValidation(document, { immediate = false } = {}) {
  const uri = document.uri;
  const prior = pendingTimers.get(uri);
  if (prior) clearTimeout(prior);
  if (immediate) {
    pendingTimers.delete(uri);
    validate(document).catch((err) =>
      connection.console.error(`validation error: ${err.stack || err}`),
    );
    return;
  }
  const t = setTimeout(() => {
    pendingTimers.delete(uri);
    validate(document).catch((err) =>
      connection.console.error(`validation error: ${err.stack || err}`),
    );
  }, DEBOUNCE_MS);
  pendingTimers.set(uri, t);
}

async function validate(document) {
  const uri = document.uri;
  const filepath = uriToRepoPath(uri, projectRoot);

  // Non-vault file (README, CLAUDE.md, design notes outside vault, ...) — clear
  // any prior diagnostics from a previous session and bail. We publish an
  // empty array explicitly so stale diagnostics on a renamed/moved file don't
  // linger in the editor.
  if (!filepath || !isVaultFile(filepath)) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  const text = document.getText();
  const { issues, lineMap } = await validateBuffer({
    text,
    filepath,
    projectRoot,
  });

  const diagnostics = issuesToDiagnostics(issues, lineMap, text);
  connection.sendDiagnostics({ uri, diagnostics });
}

// ── Document events ──────────────────────────────────────────────────────────
docs.onDidOpen(({ document }) => scheduleValidation(document, { immediate: true }));
docs.onDidChangeContent(({ document }) => scheduleValidation(document));
docs.onDidSave(({ document }) => {
  scheduleValidation(document, { immediate: true });
  // Refresh vault index for this file
  if (vaultIndex && document.uri.startsWith("file://")) {
    const absPath = fileURLToPath(document.uri);
    vaultIndex.refreshFile(absPath).catch((err) =>
      connection.console.error(`vault index refresh error: ${err.stack || err}`),
    );
  }
});
docs.onDidClose(({ document }) => {
  // Clear diagnostics on close so a closed file doesn't carry stale state in
  // the editor's problems panel.
  const t = pendingTimers.get(document.uri);
  if (t) clearTimeout(t);
  pendingTimers.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

// ── documentSymbol ──────────────────────────────────────────────────────────
connection.onDocumentSymbol(async (params) => {
  try {
    const doc = docs.get(params.textDocument.uri);
    if (!doc) return [];
    const text = doc.getText();
    return buildDocumentSymbols(text);
  } catch (err) {
    connection.console.error(`documentSymbol error: ${err.stack || err}`);
    return [];
  }
});

/**
 * Build hierarchical DocumentSymbol[] from frontmatter + markdown headings.
 */
function buildDocumentSymbols(text) {
  const symbols = [];
  const lines = text.split("\n");

  // 1. Frontmatter symbol tree
  const fmBounds = findFmBounds(lines);
  if (fmBounds) {
    const fmChildren = [];
    for (let i = fmBounds.openLine + 1; i < fmBounds.closeLine; i++) {
      const keyMatch = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (keyMatch) {
        fmChildren.push({
          name: keyMatch[1],
          kind: SymbolKind.Field,
          range: lineRange(i, lines[i]),
          selectionRange: lineRange(i, lines[i]),
        });
      }
    }
    symbols.push({
      name: "frontmatter",
      kind: SymbolKind.Object,
      range: {
        start: { line: fmBounds.openLine, character: 0 },
        end: { line: fmBounds.closeLine, character: lines[fmBounds.closeLine].length },
      },
      selectionRange: lineRange(fmBounds.openLine, lines[fmBounds.openLine]),
      children: fmChildren,
    });
  }

  // 2. Markdown heading symbols (hierarchical)
  const bodyStart = fmBounds ? fmBounds.closeLine + 1 : 0;
  const headingStack = []; // [{depth, symbol}]
  const topHeadings = [];

  for (let i = bodyStart; i < lines.length; i++) {
    const hMatch = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!hMatch) continue;
    const depth = hMatch[1].length;
    const title = hMatch[2].trim();
    const sym = {
      name: title,
      kind: SymbolKind.String,
      range: lineRange(i, lines[i]),
      selectionRange: lineRange(i, lines[i]),
      children: [],
    };

    // Find the right parent: pop stack until we find a shallower heading
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].depth >= depth) {
      headingStack.pop();
    }

    if (headingStack.length > 0) {
      headingStack[headingStack.length - 1].symbol.children.push(sym);
    } else {
      topHeadings.push(sym);
    }
    headingStack.push({ depth, symbol: sym });
  }

  symbols.push(...topHeadings);

  // Clean up empty children arrays (LSP clients may render them oddly)
  cleanEmptyChildren(symbols);
  return symbols;
}

function cleanEmptyChildren(syms) {
  for (const s of syms) {
    if (s.children && s.children.length === 0) {
      delete s.children;
    } else if (s.children) {
      cleanEmptyChildren(s.children);
    }
  }
}

function lineRange(lineNum, lineText) {
  return {
    start: { line: lineNum, character: 0 },
    end: { line: lineNum, character: (lineText || "").length },
  };
}

function findFmBounds(lines) {
  if (lines.length < 3 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { openLine: 0, closeLine: i };
  }
  return null;
}

// ── workspaceSymbol ─────────────────────────────────────────────────────────
connection.onWorkspaceSymbol(async (params) => {
  try {
    if (!vaultIndex) return [];
    await vaultIndex.ensureLoaded();
    return vaultIndex.search(params.query);
  } catch (err) {
    connection.console.error(`workspaceSymbol error: ${err.stack || err}`);
    return [];
  }
});

// ── hover ───────────────────────────────────────────────────────────────────
connection.onHover(async (params) => {
  try {
    const doc = docs.get(params.textDocument.uri);
    if (!doc) return null;
    const text = doc.getText();
    const ctx = getPositionContext(text, params.position);

    if (ctx.type === "frontmatter-key") {
      return await hoverFrontmatterKey(text, ctx);
    }
    if (ctx.type === "markdown-link") {
      return await hoverMarkdownLink(params.textDocument.uri, ctx);
    }
    if (ctx.type === "task-id") {
      return await hoverTaskId(ctx);
    }
    return null;
  } catch (err) {
    connection.console.error(`hover error: ${err.stack || err}`);
    return null;
  }
});

async function hoverFrontmatterKey(text, ctx) {
  // Parse the doc's template to get schema fields
  let templatePath = null;
  const tplMatch = text.match(/^template:\s*['"]?([^\s'"]+)/m);
  if (tplMatch) templatePath = tplMatch[1];

  if (!templatePath || !projectRoot) {
    return { contents: { kind: "markdown", value: `**${ctx.key}**` } };
  }

  const rules = await loadTemplateRules(templatePath, projectRoot);
  if (!rules) {
    return { contents: { kind: "markdown", value: `**${ctx.key}**` } };
  }

  // Look up the field spec from the composable `fields` schema.
  // `fields` is Record<string, object> where each value has primitive keys
  // like type, enum, pattern, min, max, required, description, exists.
  const fieldKey = ctx.dotPath || ctx.key;
  const spec = (rules.fields || {})[fieldKey] || (rules.fields || {})[ctx.key];

  const parts = [`**${fieldKey}**`];
  if (spec && typeof spec === "object") {
    // Description primitive (metadata-only, never emits validation issues).
    const desc = extractPrimitiveValue(spec, "description");
    if (desc) parts.push("", desc);

    const type = extractPrimitiveValue(spec, "type");
    if (type) parts.push("", `Type: \`${type}\``);

    const pattern = extractPrimitiveValue(spec, "pattern");
    if (pattern) parts.push("", `Pattern: \`${pattern}\``);

    const enumVal = extractPrimitiveValue(spec, "enum");
    if (Array.isArray(enumVal)) parts.push("", `Allowed: \`${enumVal.join("`, `")}\``);

    const min = extractPrimitiveValue(spec, "min");
    if (min !== undefined && min !== null) parts.push("", `Min: \`${min}\``);

    const max = extractPrimitiveValue(spec, "max");
    if (max !== undefined && max !== null) parts.push("", `Max: \`${max}\``);

    // Required — may be boolean shorthand or expanded { value, when }.
    const req = extractPrimitiveValue(spec, "required");
    if (req === true) parts.push("", "_Required field_");
  }

  return { contents: { kind: "markdown", value: parts.join("\n") } };
}

/**
 * Extract the effective value of a primitive from a field spec.
 *
 * Handles both shorthand (`type: "string"`) and expanded form
 * (`type: { value: "string", severity: "warning" }`).
 *
 * @param {object} fieldSpec - the field constraint object
 * @param {string} primitiveName - the primitive key to extract
 * @returns {*} the value, or undefined if absent
 */
function extractPrimitiveValue(fieldSpec, primitiveName) {
  if (!(primitiveName in fieldSpec)) return undefined;
  const raw = fieldSpec[primitiveName];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    return raw.value;
  }
  return raw;
}

async function hoverMarkdownLink(docUri, ctx) {
  if (!projectRoot || ctx.path.startsWith("http")) return null;

  const docPath = fileURLToPath(docUri);
  const targetAbs = resolve(dirname(docPath), ctx.path);

  if (!existsSync(targetAbs)) {
    return { contents: { kind: "markdown", value: `**Broken link**: \`${ctx.path}\` — target not found` } };
  }

  // Read target frontmatter for preview
  let targetFm = null;
  if (vaultIndex) {
    await vaultIndex.ensureLoaded();
    targetFm = vaultIndex.getFrontmatter(targetAbs);
  }
  if (!targetFm) {
    // Fallback: read directly
    try {
      const content = readFileSync(targetAbs, "utf-8");
      const matter = await import("gray-matter");
      targetFm = matter.default(content).data || {};
    } catch {
      targetFm = {};
    }
  }

  const title = targetFm.title || basename(targetAbs, ".md");
  const template = targetFm.template
    ? basename(targetFm.template, ".md").replace(/-template$/, "")
    : "unknown";

  const parts = [`**${title}** (${template})`];
  if (targetFm.status) parts.push(`status: \`${targetFm.status}\``);
  if (targetFm.phase) parts.push(`phase: \`${targetFm.phase}\``);
  if (targetFm.owner) parts.push(`owner: ${targetFm.owner}`);

  return { contents: { kind: "markdown", value: parts.join("  \n") } };
}

async function hoverTaskId(ctx) {
  if (!vaultIndex) return null;
  await vaultIndex.ensureLoaded();
  const absPath = vaultIndex.resolveId(ctx.id);
  if (!absPath) {
    return { contents: { kind: "markdown", value: `**${ctx.id}** — _Not found in vault_` } };
  }
  const entry = vaultIndex.getEntry(absPath);
  const parts = [`**${ctx.id}**: ${entry?.title || basename(absPath, ".md")}`];
  if (entry?.status) parts.push(`status: \`${entry.status}\``);
  if (entry?.phase) parts.push(`phase: \`${entry.phase}\``);
  if (entry?.owner) parts.push(`owner: ${entry.owner}`);
  return { contents: { kind: "markdown", value: parts.join("  \n") } };
}

// ── definition ──────────────────────────────────────────────────────────────
connection.onDefinition(async (params) => {
  try {
    return await resolveDefinition(params);
  } catch (err) {
    connection.console.error(`definition error: ${err.stack || err}`);
    return null;
  }
});

async function resolveDefinition(params) {
  const doc = docs.get(params.textDocument.uri);
  if (!doc) return null;
  const text = doc.getText();
  const ctx = getPositionContext(text, params.position);

  if (ctx.type === "markdown-link") {
    if (!projectRoot || ctx.path.startsWith("http")) return null;
    const docPath = fileURLToPath(params.textDocument.uri);
    const targetAbs = resolve(dirname(docPath), ctx.path);
    if (!existsSync(targetAbs)) return null;
    return {
      uri: pathToFileURL(targetAbs).href,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }

  if (ctx.type === "task-id") {
    if (!vaultIndex) return null;
    await vaultIndex.ensureLoaded();
    const absPath = vaultIndex.resolveId(ctx.id);
    if (!absPath) return null;
    return {
      uri: pathToFileURL(absPath).href,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }

  return null;
}

// ── references ──────────────────────────────────────────────────────────────
connection.onReferences(async (params) => {
  try {
    if (!vaultIndex || !projectRoot) return [];
    await vaultIndex.ensureLoaded();

    const absPath = fileURLToPath(params.textDocument.uri);
    const backlinks = vaultIndex.getBacklinks(absPath);
    const results = [];

    // Include declaration (self) if requested
    if (params.context?.includeDeclaration) {
      results.push({
        uri: params.textDocument.uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      });
    }

    for (const bl of backlinks) {
      results.push({
        uri: pathToFileURL(bl.source).href,
        range: {
          start: { line: bl.line, character: 0 },
          end: { line: bl.line, character: 0 },
        },
      });
    }
    return results;
  } catch (err) {
    connection.console.error(`references error: ${err.stack || err}`);
    return [];
  }
});

// ── implementation (delegates to definition for markdown vault) ─────────────
connection.onImplementation(async (params) => {
  try {
    return await resolveDefinition(params);
  } catch (err) {
    connection.console.error(`implementation error: ${err.stack || err}`);
    return null;
  }
});

// ── callHierarchy (stub — not meaningful for markdown vault) ────────────────
connection.onRequest("textDocument/prepareCallHierarchy", () => null);
connection.onRequest("callHierarchy/incomingCalls", () => []);
connection.onRequest("callHierarchy/outgoingCalls", () => []);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve project root from initialize params, with a filesystem fallback.
 *
 * Priority:
 *   1. workspaceFolders[0].uri (modern LSP clients)
 *   2. rootUri / rootPath (legacy)
 *   3. process.cwd() if it contains `templates/` (LSP started inside repo)
 *   4. null — every validation falls back to per-doc-only with no template rules
 */
function resolveProjectRoot(params) {
  const workspace = params?.workspaceFolders?.[0]?.uri;
  if (workspace) {
    const p = fileURLToPath(workspace);
    if (isProjectRoot(p)) return p;
  }
  if (params?.rootUri) {
    const p = fileURLToPath(params.rootUri);
    if (isProjectRoot(p)) return p;
  }
  if (params?.rootPath && isProjectRoot(params.rootPath)) return params.rootPath;

  const cwd = process.cwd();
  if (isProjectRoot(cwd)) return cwd;

  return null;
}

function isProjectRoot(absPath) {
  // Either a templates/ directory (legacy convention) or an explicit
  // `.claude/vault-keeper.json` config marker counts. Single-template
  // / config-only vaults are valid roots.
  try {
    if (statSync(resolve(absPath, "templates")).isDirectory()) return true;
  } catch { /* keep checking */ }
  try {
    if (statSync(resolve(absPath, ".claude", "vault-keeper.json")).isFile()) {
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

/**
 * Convert a `file://` URI to a repo-relative POSIX path used by the validator
 * (e.g. "product-knowledge/02-product/prds/foo.md"). Returns null when the
 * URI is outside `projectRoot` or projectRoot is unresolved.
 */
function uriToRepoPath(uri, root) {
  if (!uri || !uri.startsWith("file://") || !root) return null;
  const abs = fileURLToPath(uri);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..")) return null;
  // Normalize to POSIX — validateSlug regex against `/`.
  return rel.split(sep).join("/");
}

function isVaultFile(repoPath) {
  // CLAUDE.md / CLAUDE.local.md are Claude Code agent prompts auto-loaded as
  // folder-scoped instructions — NOT vault artifacts. Skip at the LSP layer
  // so on-open / on-save validation never surfaces schema diagnostics on a
  // prompt file. README.md and BOARD.md are intentionally NOT skipped here:
  // a folder's README.md may itself be the canonical document (folder-as-
  // page pattern); the CLI validator filters non-canonical folder-meta out
  // via the bundle re-include pass in validate-documents.js, and validate-
  // Buffer relies on that downstream resolution.
  const base = basename(repoPath);
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md') return false;
  // A vaultFolder of "." means the whole repo is the vault.
  return VAULT_FOLDERS.some(
    (f) => f === '.' || repoPath === f || repoPath.startsWith(`${f}/`),
  );
}

// ── Start ────────────────────────────────────────────────────────────────────
docs.listen(connection);
connection.listen();
