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
 *        template_id) — delete the leaked key from frontmatter.
 *   code="filename" — rename file to kebab-case using WorkspaceEdit rename.
 *   code="<field>" + msg starts "Missing required field:" — insert placeholder.
 *   code="body" + msg starts "Found" + "relative path" — body relative-path
 *        (aggregated warning, no specific range; documented as skipped below).
 *   code ∈ relationship field + msg contains "relative path" — rewrite single
 *        frontmatter relationship path to vault-absolute form.
 *
 * FIXERS NOT IMPLEMENTED (documented here)
 *   "Broken markdown link" (V8 in task description) — the per-doc validator
 *        does NOT emit a broken-link Diagnostic (hover surfaces it, but hover
 *        is not a Diagnostic). body-parser.js emits no broken-link warnings
 *        either. No triggering Diagnostic → nothing to hook into.
 *   V3 AC anchor resolution — requires cross-doc vault scan (not safe at
 *        keystroke cadence); the CLI validator handles it, not the LSP.
 *   V1, V4, V6, V12, V15 — semantic analysis beyond line-range edits; safe
 *        quick-fixes cannot be derived from the diagnostic alone.
 *   Body relative-path batch fix (code="body") — the warning is aggregated
 *        ("Found N relative path(s)"); there is no per-match range to fix
 *        individually without a full body re-parse.
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

  // ── V14: legacy frontmatter relationships → move to body ## Relationships ──
  // code = "relationships.<key>" where <key> is a legacy predicate key.
  // V14 message: "V14: legacy frontmatter field 'relationships.<key>' removed..."
  if (code.startsWith("relationships.") && /^V14:/.test(msg)) {
    const act = fixV14LegacyRelationships(diag, uri, text);
    if (act) actions.push(act);
  }

  // ── Template-meta leak: delete leaked template-only key from frontmatter ───
  // code ∈ { "validation_rules", "template_version", "template_id" }
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
  // code = <field dot-path>, message: "Missing required field: <field>"
  if (/^Missing required field:/.test(msg)) {
    const act = fixMissingRequiredField(diag, uri, text, code);
    if (act) actions.push(act);
  }

  // ── Relative path in frontmatter relationship: rewrite to vault-absolute ──
  // code = "relationships.<predicate>[<n>].path", message: "Relative path found: ..."
  if (code.startsWith("relationships.") && /^Relative path found:/.test(msg)) {
    const act = fixRelativePath(diag, uri, text, msg, projectRoot);
    if (act) actions.push(act);
  }

  return actions;
}

// ── Template-only fields set ──────────────────────────────────────────────────
const TEMPLATE_ONLY_FIELDS = new Set(["validation_rules", "template_version", "template_id"]);

// ══════════════════════════════════════════════════════════════════════════════
// FIXER: V14 — move frontmatter relationships block to body ## Relationships
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Delete the frontmatter `relationships:` block (all indented lines under it)
 * and insert a `## Relationships` section in the body if one doesn't already
 * exist, with the extracted edges as plain markdown list items.
 */
function fixV14LegacyRelationships(diag, uri, text) {
  const lines = text.split("\n");

  // ── 1. Locate and extract the frontmatter relationships block ─────────────
  const fmBounds = findFmBounds(lines);
  if (!fmBounds) return null;

  // Find `relationships:` key line within frontmatter
  let relKeyLine = -1;
  for (let i = fmBounds.openLine + 1; i < fmBounds.closeLine; i++) {
    if (/^relationships\s*:/.test(lines[i])) {
      relKeyLine = i;
      break;
    }
  }
  if (relKeyLine === -1) return null;

  // Collect all lines belonging to this block (key + indented children)
  let blockEnd = relKeyLine;
  for (let i = relKeyLine + 1; i < fmBounds.closeLine; i++) {
    if (/^\s+/.test(lines[i]) || lines[i].trim() === "") {
      blockEnd = i;
    } else {
      break; // next top-level key
    }
  }

  // Extract relationship edges for the body section
  const edgeLines = extractRelationshipEdges(lines, relKeyLine, blockEnd);

  // ── 2. Build TextEdits ────────────────────────────────────────────────────
  const textEdits = [];

  // Delete frontmatter block (relKeyLine … blockEnd inclusive, keep the
  // next line intact by deleting whole lines)
  textEdits.push({
    range: {
      start: { line: relKeyLine, character: 0 },
      end: { line: blockEnd + 1, character: 0 },
    },
    newText: "",
  });

  // Insert body ## Relationships section
  const bodyInsert = buildRelationshipsSection(edgeLines, lines, fmBounds.closeLine);
  textEdits.push(bodyInsert);

  return {
    title: "Move `relationships:` frontmatter to body ## Relationships section (V14)",
    kind: "quickfix",
    diagnostics: [diag],
    edit: {
      changes: { [uri]: textEdits },
    },
  };
}

/**
 * Parse YAML-style edge items from the frontmatter relationships block.
 * Returns array of strings like "  predicate: path" for body insertion.
 */
function extractRelationshipEdges(lines, keyLine, blockEnd) {
  const edges = [];
  let currentPredicate = null;

  for (let i = keyLine + 1; i <= blockEnd; i++) {
    const line = lines[i];
    // Predicate key (2 spaces indent): "  implements:"
    const predMatch = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*$/);
    if (predMatch) {
      currentPredicate = predMatch[1];
      continue;
    }
    // Path item (4 spaces indent): "    - path: product-knowledge/..."
    const pathMatch = line.match(/^\s+- path:\s*(.+)$/);
    if (pathMatch && currentPredicate) {
      edges.push({ predicate: currentPredicate, path: pathMatch[1].trim() });
    }
    // Inline path: "  implements:" "    - path: foo" already handled above
  }
  return edges;
}

/**
 * Build a TextEdit that inserts ## Relationships into the body.
 * Idempotent: if the section already exists, appends items instead.
 */
function buildRelationshipsSection(edges, lines, fmCloseLine) {
  // Check if body already has ## Relationships
  const existingIdx = lines.findIndex(
    (l, i) => i > fmCloseLine && /^##\s+Relationships\s*$/.test(l),
  );

  if (existingIdx >= 0) {
    // Append after the heading (skip any existing content until next heading
    // or end of file)
    let insertLine = existingIdx + 1;
    while (
      insertLine < lines.length &&
      !/^#{1,6}\s/.test(lines[insertLine]) &&
      !/^<!--/.test(lines[insertLine])
    ) {
      insertLine++;
    }
    const newText = edges
      .map((e) => `- ${e.predicate}: [[${e.path}]]\n`)
      .join("");
    return {
      range: {
        start: { line: insertLine, character: 0 },
        end: { line: insertLine, character: 0 },
      },
      newText: newText ? newText + "\n" : "",
    };
  }

  // Insert before <!-- Auto-generated --> or at end of file
  const autoGenIdx = lines.findIndex((l) => /^<!--\s*Auto-generated/i.test(l));
  const insertLine = autoGenIdx >= 0 ? autoGenIdx : lines.length;

  const section =
    "\n## Relationships\n\n" +
    edges.map((e) => `- ${e.predicate}: [[${e.path}]]`).join("\n") +
    "\n";

  return {
    range: {
      start: { line: insertLine, character: 0 },
      end: { line: insertLine, character: 0 },
    },
    newText: section,
  };
}

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
