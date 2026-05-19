/**
 * code-lens.js — LSP codeLensProvider for vault documents.
 *
 * Displays clickable action lines above specific heading/frontmatter positions:
 *   1. Above frontmatter `template:` line → backlink count, AC count, last-updated age
 *   2. Above `## Acceptance Criteria`     → "▶ Run test cases for all ACs"
 *   3. Above `## Ship Timeline`           → lock/unlock target date toggle
 *   4. Above `## Decision Log`            → "+ Add decision entry"
 *
 * Commands are client-side stubs — LSP surfaces them for discoverability;
 * the editor extension may handle or silently no-op them.
 */

import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
import matter from "gray-matter";
import { parseBody } from "../../lib/body-parser.js";
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

      // Strip frontmatter to get body for body-parser
      let body = text;
      let fmEndLine = -1;
      let fm = {};
      if (lines[0] === "---") {
        const closeIdx = lines.findIndex((l, i) => i > 0 && l === "---");
        if (closeIdx > 0) {
          fmEndLine = closeIdx;
          body = lines.slice(closeIdx + 1).join("\n");
          try {
            const parsed = matter(text);
            fm = parsed.data || {};
          } catch {
            fm = {};
          }
        }
      }

      const parsedBody = await parseBody(body);

      let absPath = null;
      if (vaultIndex && params.textDocument.uri.startsWith("file://")) {
        absPath = fileURLToPath(params.textDocument.uri);
      }

      const lenses = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ── 1. Above `template:` frontmatter line ────────────────────────────
        if (i > 0 && i <= fmEndLine && /^template:\s*/.test(line)) {
          const backlinkCount = (absPath && vaultIndex)
            ? vaultIndex.getBacklinks(absPath).length
            : 0;
          const acCount = parsedBody.acceptanceCriteria.length;

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
            `⬆ ${acCount} acceptance criteria`,
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
          continue;
        }

        // ── 2. Above `## Acceptance Criteria` ───────────────────────────────
        if (/^## Acceptance Criteria\s*$/.test(line)) {
          lenses.push({
            range: zeroRange(i),
            command: {
              title: "▶ Run test cases for all ACs",
              command: "vault-keeper.runTestsForDoc",
              arguments: [params.textDocument.uri],
            },
          });
          continue;
        }

        // ── 3. Above `## Ship Timeline` ──────────────────────────────────────
        if (/^## Ship Timeline\s*$/.test(line)) {
          const locked = Boolean(parsedBody.shipTimeline?.locked_at);
          lenses.push({
            range: zeroRange(i),
            command: {
              title: locked ? "🔓 Unlock target" : "🔒 Lock target date",
              command: "vault-keeper.toggleShipTimelineLock",
              arguments: [params.textDocument.uri],
            },
          });
          continue;
        }

        // ── 4. Above `## Decision Log` ───────────────────────────────────────
        if (/^## Decision Log\s*$/.test(line)) {
          lenses.push({
            range: zeroRange(i),
            command: {
              title: "+ Add decision entry",
              command: "vault-keeper.addDecision",
              arguments: [params.textDocument.uri],
            },
          });
          continue;
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
