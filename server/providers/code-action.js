/**
 * server/providers/code-action.js — LSP codeActionProvider for vault.
 *
 * Quick-fixes for diagnostics emitted by server/validator.js + lib/validators.js.
 *
 * DISPATCH STRATEGY
 * diagnostics.js sets `code = issue.field || "vault-keeper"`. Each fixer
 * matches on BOTH:
 *   - `code` (the field dot-path or synthetic tag)
 *   - optionally a message regex to narrow within the same field
 *
 * FIXERS IMPLEMENTED
 *   code ∈ templateOnlyFields (validation_rules, template_version,
 *        template_id, fields, strict, sections, tier) — delete the leaked
 *        key from frontmatter.
 *   code="filename" — rename file to kebab-case using WorkspaceEdit rename.
 *   code="<field>" + msg starts "Required field" — insert placeholder.
 *   code contains path + msg starts "Relative path found:" — rewrite single
 *        path to vault-absolute form.
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, basename, join, resolve as resolvePath } from "node:path";

// ── Capability ────────────────────────────────────────────────────────────────

export const capability = {
  codeActionProvider: {
    codeActionKinds: ["quickfix", "source.fixAll"],
    resolveProvider: false,
  },
};

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * @param {{ connection: any, docs: any, vaultIndex: any, projectRoot: string }} args
 */
export function register({ connection, docs, vaultIndex, projectRoot }) {
  connection.onCodeAction(async (params) => {
    try {
      return await handleCodeAction(params, { docs, vaultIndex, projectRoot });
    } catch (err) {
      connection.console.error(`codeAction error: ${err.stack || err}`);
      return [];
    }
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleCodeAction(params, { docs, vaultIndex, projectRoot }) {
  const uri = params.textDocument.uri;
  const doc = docs.get(uri);
  if (!doc) return [];

  const text = doc.getText();
  const diags = params.context?.diagnostics ?? [];
  if (diags.length === 0) return [];

  const actions = [];
  for (const diag of diags) {
    const more = await fixersForDiagnostic(diag, uri, text, { vaultIndex, projectRoot });
    actions.push(...more);
  }
  return actions;
}

// ── Per-diagnostic fixer dispatch ─────────────────────────────────────────────

async function fixersForDiagnostic(diag, uri, text, { vaultIndex, projectRoot }) {
  const code = typeof diag.code === "string" ? diag.code : String(diag.code ?? "");
  const msg = diag.message ?? "";

  const actions = [];

  // ── Template-meta leak: delete leaked template-only key from frontmatter ───
  // code ∈ TEMPLATE_ONLY_FIELDS
  // message starts with: "Template-only field \"<key>\" leaked..."
  if (TEMPLATE_ONLY_FIELDS.has(code) && /leaked/i.test(msg)) {
    const act = fixTemplateMetaLeak(diag, uri, text, code);
    if (act) actions.push(act);
  }

  // ── Naming violation: rename file to kebab-case ───────────────────────────
  // code = "filename", message: "Filename '<seg>' violates slug convention..."
  // fix hint from validator: "Rename to '<fixedName>'"
  if (code === "filename" && /violates slug convention/i.test(msg)) {
    const act = fixNamingViolation(diag, uri, text, msg);
    if (act) actions.push(act);
  }

  // ── Missing required field: insert placeholder in frontmatter ─────────────
  // code = <field dot-path>
  // Old engine: "Missing required field: <field>"
  // New engine: "Required field '<field>' is missing"
  if (/^Missing required field:/.test(msg) || /^Required field '.+' is missing/.test(msg)) {
    const act = fixMissingRequiredField(diag, uri, text, code);
    if (act) actions.push(act);
  }

  // ── Relative path in frontmatter field: rewrite to vault-absolute ──────────
  // message: "Relative path found: ..."
  if (/^Relative path found:/.test(msg)) {
    const act = fixRelativePath(diag, uri, text, msg, projectRoot);
    if (act) actions.push(act);
  }

  return actions;
}

// ── Template-only fields set ──────────────────────────────────────────────────
// Mirrors CONFIG.templateOnlyFields from lib/validators.js, plus the new
// composable-schema template-authoring keys (fields, strict, sections, tier).
const TEMPLATE_ONLY_FIELDS = new Set([
  "validation_rules", "template_version", "template_id",
  "fields", "strict", "sections", "tier",
]);

// ══════════════════════════════════════════════════════════════════════════════
// FIXER: Template-meta leak — delete leaked key from frontmatter
// ══════════════════════════════════════════════════════════════════════════════

function fixTemplateMetaLeak(diag, uri, text, fieldKey) {
  const lines = text.split("\n");
  const fmBounds = findFmBounds(lines);
  if (!fmBounds) return null;

  // Find the line with this key in frontmatter
  const keyRe = new RegExp(`^${escapeRegex(fieldKey)}\\s*:`);
  let keyLine = -1;
  for (let i = fmBounds.openLine + 1; i < fmBounds.closeLine; i++) {
    if (keyRe.test(lines[i])) {
      keyLine = i;
      break;
    }
  }
  if (keyLine === -1) return null;

  // Also delete any indented continuation lines (multi-line YAML values)
  let blockEnd = keyLine;
  for (let i = keyLine + 1; i < fmBounds.closeLine; i++) {
    if (/^\s+/.test(lines[i]) || lines[i].trim() === "") {
      blockEnd = i;
    } else {
      break;
    }
  }

  return {
    title: `Remove template-only field "${fieldKey}" from frontmatter`,
    kind: "quickfix",
    diagnostics: [diag],
    edit: {
      changes: {
        [uri]: [
          {
            range: {
              start: { line: keyLine, character: 0 },
              end: { line: blockEnd + 1, character: 0 },
            },
            newText: "",
          },
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FIXER: Naming violation — rename file to kebab-case
// ══════════════════════════════════════════════════════════════════════════════

function fixNamingViolation(diag, uri, text, message) {
  // Validator embeds fix hint: "Rename to 'fixed-name.md' (or another...)"
  const fixMatch = message.match(/Rename to '([^']+)'/);
  if (!fixMatch) return null;

  const fixedName = fixMatch[1];
  const absPath = fileURLToPath(uri);
  const dir = dirname(absPath);
  const newAbsPath = join(dir, fixedName);
  const newUri = pathToFileURL(newAbsPath).href;

  return {
    title: `Rename file to \`${fixedName}\``,
    kind: "quickfix",
    diagnostics: [diag],
    edit: {
      documentChanges: [
        {
          kind: "rename",
          oldUri: uri,
          newUri,
          options: { overwrite: false, ignoreIfExists: false },
        },
      ],
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FIXER: Missing required field — insert placeholder in frontmatter
// ══════════════════════════════════════════════════════════════════════════════

function fixMissingRequiredField(diag, uri, text, fieldCode) {
  // fieldCode is the dot-path, e.g. "owner" or "success_metric_actual.primary.verdict"
  // We only handle top-level fields (no dot) for inline insertion.
  if (fieldCode.includes(".")) return null;

  const lines = text.split("\n");
  const fmBounds = findFmBounds(lines);
  if (!fmBounds) return null;

  // Insert just before the closing `---`
  const insertLine = fmBounds.closeLine;

  return {
    title: `Insert missing field \`${fieldCode}: TODO\``,
    kind: "quickfix",
    diagnostics: [diag],
    edit: {
      changes: {
        [uri]: [
          {
            range: {
              start: { line: insertLine, character: 0 },
              end: { line: insertLine, character: 0 },
            },
            newText: `${fieldCode}: TODO\n`,
          },
        ],
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FIXER: Relative path in frontmatter relationship — rewrite to vault-absolute
// ══════════════════════════════════════════════════════════════════════════════

function fixRelativePath(diag, uri, text, message, projectRoot) {
  // message: "Relative path found: ../foo/bar.md"
  const pathMatch = message.match(/^Relative path found:\s*(.+)$/);
  if (!pathMatch) return null;

  const relativePath = pathMatch[1].trim();
  if (!projectRoot) return null;

  // Resolve relative to the document's directory
  const docAbsPath = fileURLToPath(uri);
  const docDir = dirname(docAbsPath);

  let absTarget;
  try {
    absTarget = resolvePath(docDir, relativePath);
  } catch {
    return null;
  }

  // Make vault-absolute (relative to projectRoot)
  const vaultAbsolute = absTarget.startsWith(projectRoot)
    ? absTarget.slice(projectRoot.length).replace(/^\//, "")
    : null;
  if (!vaultAbsolute) return null;

  // Find the exact line in the document that contains the relative path
  const lines = text.split("\n");
  const diagLine = diag.range?.start?.line ?? 0;
  const lineText = lines[diagLine] ?? "";

  // Replace the relative path with the vault-absolute path on that line
  const escaped = escapeRegex(relativePath);
  if (!new RegExp(escaped).test(lineText)) return null;

  const newLineText = lineText.replace(relativePath, vaultAbsolute);

  return {
    title: `Rewrite relative path to vault-absolute: \`${vaultAbsolute}\``,
    kind: "quickfix",
    diagnostics: [diag],
    edit: {
      changes: {
        [uri]: [
          {
            range: {
              start: { line: diagLine, character: 0 },
              end: { line: diagLine, character: lineText.length },
            },
            newText: newLineText,
          },
        ],
      },
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find frontmatter bounds (0-indexed). Returns null if no valid frontmatter.
 */
function findFmBounds(lines) {
  if (!lines || lines.length < 3 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { openLine: 0, closeLine: i };
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
