/**
 * completion.js — LSP completionProvider for the vault.
 *
 * Provides context-aware completions for:
 *   1. Markdown link paths — after `](` in body
 *   2. Heading anchor IDs — after `#` inside `](path#`
 *   3. Enum values — after any frontmatter key whose template schema declares `enum`
 *   4. Template paths — after `template:` in frontmatter
 *
 * NOTE: `getPositionContext` from position-context.js is designed for hover/
 * definition (complete closed tokens). For completion triggers the token is
 * mid-typed, so we do our own regex-based cursor detection from the line prefix
 * up to `position.character`. We still use getPositionContext for the
 * `frontmatter-key` detection since it handles YAML indentation correctly.
 */

import { CompletionItemKind } from "vscode-languageserver/node.js";
import { relative, basename, dirname, resolve, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { glob } from "glob";
import { getPositionContext } from "../position-context.js";
import { loadTemplateRules } from "../../lib/template-rules.js";
import { loadVaultConfig } from "../../lib/vault-config.js";

export const capability = {
  completionProvider: {
    triggerCharacters: ["*", "#", "(", "/", ":"],
    resolveProvider: false,
  },
};

/**
 * Register the completion handler on the LSP connection.
 *
 * @param {{ connection, docs, vaultIndex, projectRoot }} deps
 */
export function register({ connection, docs, vaultIndex, projectRoot }) {
  connection.onCompletion(async (params) => {
    try {
      return await computeCompletions(params, { connection, docs, vaultIndex, projectRoot });
    } catch (err) {
      connection.console.error(`completion error: ${err.stack || err}`);
      return [];
    }
  });
}

// ── Core dispatcher ──────────────────────────────────────────────────────────

async function computeCompletions(params, { docs, vaultIndex, projectRoot }) {
  const doc = docs.get(params.textDocument.uri);
  if (!doc) return [];

  const text = doc.getText();
  const position = params.position;
  const lines = text.split("\n");
  const lineIdx = position.line;
  if (lineIdx < 0 || lineIdx >= lines.length) return [];

  const line = lines[lineIdx];
  // Prefix = everything on this line up to (not including) the cursor
  const prefix = line.slice(0, position.character);

  // ── 1. Detect cursor context from line prefix ──────────────────────────────

  // AC anchor: `](path#` or `](path/to/file.md#`
  const anchorM = prefix.match(/\]\(([^)]+)#([^)]*)$/);
  if (anchorM) {
    const targetRawPath = anchorM[1];
    return completionsForAnchor(targetRawPath, params.textDocument.uri, vaultIndex, projectRoot);
  }

  // Markdown link path: `](`
  const linkM = prefix.match(/\]\(([^)]*)$/);
  if (linkM) {
    const typed = linkM[1];
    return completionsForLinkPath(typed, params.textDocument.uri, vaultIndex, projectRoot);
  }

  // Frontmatter key-value: use getPositionContext for reliable frontmatter detection
  const ctx = getPositionContext(text, position);
  if (ctx.type === "frontmatter-key") {
    const key = ctx.key;
    if (key === "template") return completionsForTemplate(projectRoot);
    // Generic enum completion — any field with an `enum` constraint gets completions.
    return completionsForEnum(key, text, projectRoot);
  }

  // Also detect value side of frontmatter key (cursor on value part).
  // Match any key, not just hardcoded names — the template schema declares
  // which fields have enum constraints.
  const fmValueM = prefix.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*['"]?([^'"]*)?$/);
  if (fmValueM && isInFrontmatter(lines, lineIdx)) {
    const key = fmValueM[1];
    if (key === "template") return completionsForTemplate(projectRoot);
    return completionsForEnum(key, text, projectRoot);
  }

  return [];
}

// ── Completion builders ──────────────────────────────────────────────────────

/**
 * Markdown link path completions — vault docs by relative path from current file.
 */
async function completionsForLinkPath(typed, docUri, vaultIndex, projectRoot) {
  if (!vaultIndex || !projectRoot) return [];

  try {
    await vaultIndex.ensureLoaded();
  } catch {
    return [];
  }

  const docPath = uriToAbsPath(docUri);
  const docDir = docPath ? dirname(docPath) : projectRoot;
  // Vault content root — Resolves from .claude/vault-keeper.json (default ".")
  // per vault via `.claude/vault-keeper.json` vaultRoot. Used only for
  // proximity-sort tier-folder extraction below.
  const vaultContentRoot = join(projectRoot, loadVaultConfig(projectRoot).vaultRoot);

  // Current doc's tier folder (e.g. "02-product") for proximity sort
  const docTierFolder = docPath ? getTierFolder(docPath, vaultContentRoot) : null;

  const typedLower = typed.toLowerCase();
  const items = [];

  for (const entry of vaultIndex.allEntries()) {
    const relFromDoc = relative(docDir, entry.absPath);
    if (typedLower && !relFromDoc.toLowerCase().includes(typedLower)) continue;

    const tplName = entry.template
      ? basename(entry.template, ".md").replace(/-template$/, "")
      : "unknown";

    const entryTierFolder = getTierFolder(entry.absPath, vaultContentRoot);
    const sameTier = entryTierFolder && entryTierFolder === docTierFolder;

    items.push({
      label: relFromDoc,
      kind: CompletionItemKind.File,
      detail: tplName,
      documentation: entry.title ? { kind: "plaintext", value: entry.title } : undefined,
      insertText: relFromDoc,
      // Sort same-tier entries first
      sortText: (sameTier ? "0" : "1") + relFromDoc.toLowerCase(),
    });
  }

  // Cap to avoid flooding the UI
  items.sort((a, b) => (a.sortText || "").localeCompare(b.sortText || ""));
  return items.slice(0, 200);
}

/**
 * AC anchor completions — headings from target file matching `### AC\d+` pattern.
 */
async function completionsForAnchor(targetRawPath, docUri, vaultIndex, projectRoot) {
  if (!projectRoot) return [];

  const docPath = uriToAbsPath(docUri);
  if (!docPath) return [];

  const targetAbs = resolve(dirname(docPath), targetRawPath);

  // Try to read target file content
  let content = null;
  if (vaultIndex) {
    try {
      await vaultIndex.ensureLoaded();
    } catch {
      // non-fatal
    }
  }

  if (!existsSync(targetAbs)) return [];
  try {
    content = readFileSync(targetAbs, "utf-8");
  } catch {
    return [];
  }

  // Extract headings that look like AC anchors: ### AC1, ### AC-1, ## Acceptance Criteria
  const items = [];
  const headingRe = /^(#{2,4})\s+(.+)$/gm;
  let m;
  while ((m = headingRe.exec(content)) !== null) {
    const headingText = m[2].trim();
    // Generate slug as GitHub/markdown does: lowercase, spaces → hyphens, strip non-alphanum
    const slug = headingText
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");

    items.push({
      label: slug,
      kind: CompletionItemKind.Reference,
      detail: headingText,
      insertText: slug,
    });
  }

  return items;
}

/**
 * Enum completions for any frontmatter field whose template schema declares
 * an `enum` constraint. Handles both shorthand (`enum: [a, b]`) and
 * expanded form (`enum: { value: [a, b], severity: "warning" }`).
 */
async function completionsForEnum(fieldName, docText, projectRoot) {
  if (!projectRoot) return [];

  const rules = await getDocTemplateRules(docText, projectRoot);
  if (!rules || !rules.fields) return [];

  const spec = rules.fields[fieldName];
  if (!spec || typeof spec !== "object") return [];

  // Extract enum values — handle shorthand and expanded form.
  let values = spec.enum;
  if (values && typeof values === "object" && !Array.isArray(values) && "value" in values) {
    values = values.value;
  }
  if (!Array.isArray(values)) return [];

  return values.map((val) => ({
    label: String(val),
    kind: CompletionItemKind.EnumMember,
    detail: fieldName,
    insertText: String(val),
  }));
}

/**
 * Template path completions — templates/*-template.md.
 */
async function completionsForTemplate(projectRoot) {
  if (!projectRoot) return [];

  let files;
  try {
    files = await glob("templates/*-template.md", { cwd: projectRoot });
  } catch {
    return [];
  }

  return files.map((f) => ({
    label: f,
    kind: CompletionItemKind.Module,
    detail: basename(f, ".md").replace(/-template$/, ""),
    insertText: f,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine if line `lineIdx` is inside frontmatter (between `---` fences).
 */
function isInFrontmatter(lines, lineIdx) {
  if (lines.length < 3 || lines[0].trim() !== "---") return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lineIdx > 0 && lineIdx < i;
    }
  }
  return false;
}

/**
 * Extract the template path from raw doc text.
 */
function extractTemplatePath(docText) {
  const m = docText.match(/^template:\s*['"]?([^\s'"]+)/m);
  return m ? m[1] : null;
}

/**
 * Load template rules for the current doc (by sniffing frontmatter `template:` field).
 */
async function getDocTemplateRules(docText, projectRoot) {
  const templatePath = extractTemplatePath(docText);
  if (!templatePath) return null;
  try {
    return await loadTemplateRules(templatePath, projectRoot);
  } catch {
    return null;
  }
}

/**
 * Determine the vault tier for the current doc (e.g. "PRODUCT", "ENGINEERING").
 */
async function getDocTier(docText, projectRoot) {
  const rules = await getDocTemplateRules(docText, projectRoot);
  return rules?.tier || null;
}

/**
 * Extract the immediate top-level folder name from an absPath under
 * vaultContentRoot. e.g. /root/vault/section/subdir/foo.md → "section".
 */
function getTierFolder(absPath, vaultContentRoot) {
  const rel = relative(vaultContentRoot, absPath);
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : null;
}

/**
 * Convert a file:// URI to an absolute path, or return null.
 */
function uriToAbsPath(uri) {
  if (!uri || !uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
