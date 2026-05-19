/**
 * completion.js — LSP completionProvider for the vault.
 *
 * Provides context-aware completions for:
 *   1. Predicate names  — after `**` in body bullet lines (typed edges)
 *   2. Markdown link paths — after `](` in body
 *   3. AC anchor IDs — after `#` inside `](path#`
 *   4. Status enums — after `status:` in frontmatter
 *   5. Phase enums — after `phase:` in frontmatter
 *   6. Person @handles — after `@` in body
 *   7. Template paths — after `template:` in frontmatter
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
    triggerCharacters: ["*", "@", "#", "(", "/", ":"],
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

  // Person handle: `@` (may have partial handle after it)
  const handleM = prefix.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
  if (handleM) {
    const typed = handleM[1];
    return completionsForHandle(typed, projectRoot);
  }

  // Frontmatter key-value: use getPositionContext for reliable frontmatter detection
  const ctx = getPositionContext(text, position);
  if (ctx.type === "frontmatter-key") {
    const key = ctx.key;
    if (key === "status") return completionsForEnum("status", text, projectRoot);
    if (key === "phase") return completionsForEnum("phase", text, projectRoot);
    if (key === "template") return completionsForTemplate(projectRoot);
    return [];
  }

  // Also detect value side of frontmatter key: `status: ` (cursor on value part)
  const fmValueM = prefix.match(/^(status|phase|template):\s*['"]?([^'"]*)?$/);
  if (fmValueM && isInFrontmatter(lines, lineIdx)) {
    const key = fmValueM[1];
    if (key === "status") return completionsForEnum("status", text, projectRoot);
    if (key === "phase") return completionsForEnum("phase", text, projectRoot);
    if (key === "template") return completionsForTemplate(projectRoot);
    return [];
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
 * Status or phase enum completions from template's field_rules.
 */
async function completionsForEnum(fieldName, docText, projectRoot) {
  if (!projectRoot) return [];

  const rules = await getDocTemplateRules(docText, projectRoot);
  if (!rules) return [];

  const fieldRule = (rules.field_rules || []).find((r) => r.field === fieldName);
  if (!fieldRule || !Array.isArray(fieldRule.values)) return [];

  return fieldRule.values.map((val) => ({
    label: val,
    kind: CompletionItemKind.EnumMember,
    detail: fieldName,
    insertText: val,
  }));
}

/**
 * Person @handle completions — filenames in product-data/people/*.md.
 */
async function completionsForHandle(typed, projectRoot) {
  if (!projectRoot) return [];

  let files;
  try {
    files = await glob("product-data/people/*.md", { cwd: projectRoot });
  } catch {
    return [];
  }

  const typedLower = typed.toLowerCase();
  const items = [];
  for (const f of files) {
    const handle = basename(f, ".md");
    if (typedLower && !handle.toLowerCase().startsWith(typedLower)) continue;
    items.push({
      label: `@${handle}`,
      kind: CompletionItemKind.Variable, // CompletionItemKind.User is not in vscode-languageserver v9
      detail: "person",
      insertText: `@${handle}`,
    });
  }

  return items;
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
