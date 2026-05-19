/**
 * inlay-hint.js — LSP inlayHintProvider for vault documents.
 *
 * Displays contextual ghost-text after specific heading and frontmatter lines:
 *   1. ## Relationships heading → (N outgoing, M incoming)
 *   2. ### ACk — title heading  → (implementing: X, verified by: Y)
 *   3. Each relationship bullet  → (status: S, phase: P) from target frontmatter
 *   4. frontmatter `status:` line → (in this phase: Xd, total in this status: Yd)
 *
 * Notes:
 *   - parseBody() is async; we await it inside the handler.
 *   - vaultIndex.getBacklinks / getFrontmatter are synchronous (cache reads).
 *   - Only active for product-knowledge/ vault files; others return [].
 */

import { fileURLToPath } from "node:url";
import { resolve, dirname, relative, sep } from "node:path";
import matter from "gray-matter";
import { parseBody } from "../../lib/body-parser.js";
import { loadVaultConfig } from "../../lib/vault-config.js";

export const capability = { inlayHintProvider: { resolveProvider: false } };

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
  // A vaultFolder of "." means the whole repo is the vault.
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

  connection.languages.inlayHint.on(async (params) => {
    try {
      const doc = docs.get(params.textDocument.uri);
      if (!doc) return [];

      // Only process vault files
      if (projectRoot && !isVaultUri(params.textDocument.uri, projectRoot, vaultFolders)) {
        return [];
      }

      const text = doc.getText();
      const lines = text.split("\n");

      // Strip frontmatter to get body for body-parser
      let body = text;
      let fmEndLine = -1;
      if (lines[0] === "---") {
        const closeIdx = lines.findIndex((l, i) => i > 0 && l === "---");
        if (closeIdx > 0) {
          fmEndLine = closeIdx;
          body = lines.slice(closeIdx + 1).join("\n");
        }
      }

      const parsed = await parseBody(body);

      // Resolve absolute path for backlink lookup
      let absPath = null;
      if (vaultIndex && params.textDocument.uri.startsWith("file://")) {
        absPath = fileURLToPath(params.textDocument.uri);
      }

      // Compute body-line offset (body-parser line numbers are 1-based within body)
      const bodyLineOffset = fmEndLine + 1; // lines[bodyLineOffset] = first body line

      const hints = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ── 1. ## Relationships heading ───────────────────────────────────────
        if (/^## Relationships\s*$/.test(line)) {
          const outgoing = parsed.relationships.length;
          const incoming = (absPath && vaultIndex)
            ? vaultIndex.getBacklinks(absPath).length
            : 0;
          hints.push({
            position: { line: i, character: line.length },
            label: ` (${outgoing} outgoing, ${incoming} incoming)`,
            kind: 1, // Type
            paddingLeft: false,
            paddingRight: false,
          });
          continue;
        }

        // ── 2. ### ACk — title heading ────────────────────────────────────────
        const acHeadingMatch = line.match(/^### (AC\d+(?:\.\d+)?)\s*—/);
        if (acHeadingMatch) {
          const acId = acHeadingMatch[1];
          // body-parser lines are 1-based within body; body starts at bodyLineOffset+1 in doc
          const ac = parsed.acceptanceCriteria.find((a) => {
            // ac.line is 1-based within body; i is 0-based in full doc
            return bodyLineOffset + (a.line - 1) === i;
          });
          if (ac) {
            const impl = ac.implementedBy.length;
            const verified = ac.verifiedBy.length;
            hints.push({
              position: { line: i, character: line.length },
              label: ` (implementing: ${impl}, verified by: ${verified})`,
              kind: 1,
              paddingLeft: false,
              paddingRight: false,
            });
          }
          continue;
        }

        // ── 3. Relationship bullet lines ──────────────────────────────────────
        const relBulletMatch = line.match(/^- \[([^\]]+)\]\(([^)]+)\)/);
        if (relBulletMatch && vaultIndex) {
          const rawPath = relBulletMatch[2].split("#")[0];
          // Resolve relative to the document's directory
          const docDir = absPath ? dirname(absPath) : (projectRoot || "");
          const targetAbs = resolve(docDir, rawPath);
          const fm = vaultIndex.getFrontmatter(targetAbs);
          if (fm) {
            const status = fm.status || "?";
            const phase = fm.phase || "?";
            hints.push({
              position: { line: i, character: line.length },
              label: ` (status: ${status}, phase: ${phase})`,
              kind: 1,
              paddingLeft: false,
              paddingRight: false,
            });
          }
          continue;
        }

        // ── 4. Frontmatter `status:` line ────────────────────────────────────
        if (i > 0 && i <= fmEndLine && /^status:\s*/.test(line)) {
          const { phaseHistory, statusHistory } = parsed;

          // Days in current phase: time since last phase-history entry
          let daysInPhase = null;
          if (phaseHistory.length > 0) {
            const lastPhase = phaseHistory[phaseHistory.length - 1];
            const ts = Date.parse(lastPhase.at);
            if (!isNaN(ts)) {
              daysInPhase = Math.floor((Date.now() - ts) / 86400000);
            }
          }

          // Days in current status: time since last status-history entry
          let daysInStatus = null;
          if (statusHistory.length > 0) {
            const lastStatus = statusHistory[statusHistory.length - 1];
            const ts = Date.parse(lastStatus.at);
            if (!isNaN(ts)) {
              daysInStatus = Math.floor((Date.now() - ts) / 86400000);
            }
          }

          if (daysInPhase !== null || daysInStatus !== null) {
            const phasePart = daysInPhase !== null ? `${daysInPhase}d` : "?";
            const statusPart = daysInStatus !== null ? `${daysInStatus}d` : "?";
            hints.push({
              position: { line: i, character: line.length },
              label: ` (in this phase: ${phasePart}, total in this status: ${statusPart})`,
              kind: 1,
              paddingLeft: false,
              paddingRight: false,
            });
          }
        }
      }

      return hints;
    } catch (err) {
      connection.console?.error?.(`inlayHint error: ${err.stack || err}`);
      return [];
    }
  });
}
