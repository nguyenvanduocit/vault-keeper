/**
 * code-lens.js — LSP codeLensProvider for vault documents.
 *
 * Displays clickable action lines above specific frontmatter positions:
 *   1. Above frontmatter `template:` line → backlink count + last-updated age
 *
 * Commands are client-side stubs — LSP surfaces them for discoverability;
 * the editor extension may handle or silently no-op them.
 *
 * NOTE: Domain-specific body lenses (Acceptance Criteria, Ship Timeline,
 * Decision Log) were removed — they depended on the deleted domain-aware
 * body parser. Generic body-schema validation is handled by the composable
 * schema engine; lenses for template-declared body sections may be
 * reintroduced in a future iteration via body-shapes.js.
 */

import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "../../lib/vault-config.js";

export const capability = { codeLensProvider: { resolveProvider: false } };

/**
 * True when `uri` is a vault file under one of `vaultFolders` (relative to
 * `projectRoot`). Mirrors `isVaultFile` in server/main.js so the vault's
 * configured folders gate the provider.
 */
function isVaultUri(uri, projectRoot, vaultFolders) {
  if (!uri || !uri.startsWith("file://")) return false;
  const abs = fileURLToPath(uri);
  const rel = relative(projectRoot, abs);
  if (!rel || rel.startsWith("..")) return false;
  const posix = rel.split(sep).join("/");
  // A vaultFolder of "." means the whole repo is the vault — every
  // repo-relative path matches.
  return vaultFolders.some(
    (f) => f === "." || posix === f || posix.startsWith(`${f}/`),
  );
}

/**
 * @param {{ connection: object, docs: object, vaultIndex: object, projectRoot: string }} ctx
 */
export function register({ connection, docs, vaultIndex, projectRoot }) {
  // Resolve once at registration (projectRoot is fixed for the session) so the
  // per-line hot path below never re-reads the config file.
  const vaultFolders = projectRoot
    ? loadVaultConfig(projectRoot).vaultFolders
    : [];

  connection.onCodeLens(async (params) => {
    try {
      const doc = docs.get(params.textDocument.uri);
      if (!doc) return [];

      if (projectRoot && !isVaultUri(params.textDocument.uri, projectRoot, vaultFolders)) {
        return [];
      }

      const text = doc.getText();
      const lines = text.split("\n");

      // Find frontmatter bounds for gating the template lens
      let fmEndLine = -1;
      let fm = {};
      if (lines[0] === "---") {
        const closeIdx = lines.findIndex((l, i) => i > 0 && l === "---");
        if (closeIdx > 0) {
          fmEndLine = closeIdx;
          try {
            const parsed = matter(text);
            fm = parsed.data || {};
          } catch {
            fm = {};
          }
        }
      }

      let absPath = null;
      if (vaultIndex && params.textDocument.uri.startsWith("file://")) {
        absPath = fileURLToPath(params.textDocument.uri);
      }

      const lenses = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ── Above `template:` frontmatter line ──────────────────────────────
        if (i > 0 && i <= fmEndLine && /^template:\s*/.test(line)) {
          const backlinkCount = (absPath && vaultIndex)
            ? vaultIndex.getBacklinks(absPath).length
            : 0;

          // Days since last-updated (from fm.updated_at or fm.updated)
          let daysAgo = null;
          const updatedRaw = fm.updated_at || fm.updated || null;
          if (updatedRaw) {
            const ts = Date.parse(String(updatedRaw));
            if (!isNaN(ts)) {
              daysAgo = Math.floor((Date.now() - ts) / 86400000);
            }
          }

          const agePart = daysAgo !== null ? `⏱ updated ${daysAgo}d ago` : null;
          const titleParts = [
            `↗ ${backlinkCount} backlinks`,
            agePart,
          ].filter(Boolean);

          lenses.push({
            range: zeroRange(i),
            command: {
              title: titleParts.join(" · "),
              command: "vault-keeper.openBacklinkList",
              arguments: [params.textDocument.uri],
            },
          });
        }
      }

      return lenses;
    } catch (err) {
      connection.console?.error?.(`codeLens error: ${err.stack || err}`);
      return [];
    }
  });
}

/** 1-character range at the start of a line (CodeLens range convention). */
function zeroRange(lineNum) {
  return {
    start: { line: lineNum, character: 0 },
    end: { line: lineNum, character: 1 },
  };
}
