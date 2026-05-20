/**
 * inlay-hint.js — LSP inlayHintProvider for vault documents.
 *
 * Currently a no-op skeleton. All prior inlay hints depended on the
 * domain-specific body parser (`lib/body-parser.js`, now deleted):
 *
 *   1. ## Relationships heading → (N outgoing, M incoming)
 *   2. ### ACk — title heading  → (implementing: X, verified by: Y)
 *   3. Each relationship bullet  → (status: S, phase: P)
 *   4. frontmatter `status:` line → (in this phase: Xd, total: Yd)
 *
 * Those hints carried hardcoded domain words (status, phase, AC,
 * relationships). The composable schema engine validates body structure
 * generically but does not expose the parsed-section data needed for
 * inline decorations. Future work may reintroduce generic inlay hints
 * driven by template-declared body schema and body-shapes.js parsers.
 *
 * The provider registration and capability are preserved so the LSP
 * handshake stays stable — clients that registered for inlay hints
 * simply receive an empty array.
 */

import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";
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
  return vaultFolders.some(
    (f) => f === "." || posix === f || posix.startsWith(`${f}/`),
  );
}

/**
 * @param {{ connection: object, docs: object, vaultIndex: object, projectRoot: string }} ctx
 */
export function register({ connection, docs, vaultIndex, projectRoot }) {
  const vaultFolders = projectRoot
    ? loadVaultConfig(projectRoot).vaultFolders
    : [];

  connection.languages.inlayHint.on(async (params) => {
    try {
      const doc = docs.get(params.textDocument.uri);
      if (!doc) return [];

      if (projectRoot && !isVaultUri(params.textDocument.uri, projectRoot, vaultFolders)) {
        return [];
      }

      // No generic inlay hints implemented yet — return empty.
      return [];
    } catch (err) {
      connection.console?.error?.(`inlayHint error: ${err.stack || err}`);
      return [];
    }
  });
}
