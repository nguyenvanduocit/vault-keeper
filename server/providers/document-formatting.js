/**
 * document-formatting.js — LSP documentFormattingProvider for vault.
 *
 * Registers `onDocumentFormatting` on the LSP connection and returns the
 * canonical-formatted document as a single whole-document TextEdit.
 *
 * Wire-up: caller does `register({ connection, docs, vaultIndex, projectRoot })`.
 * The capability export is for future wiring in main.js.
 *
 * Returns null (not []) when the document is already canonical — LSP clients
 * interpret null as "no edits needed" without triggering a "formatted" flash.
 */

import { fileURLToPath } from "node:url";
import { formatVaultDocumentAsync } from "../../lib/canonical-formatter.js";

export const capability = { documentFormattingProvider: true };

/**
 * Register the documentFormatting handler.
 *
 * @param {{ connection: object, docs: object, vaultIndex: object, projectRoot: string }} ctx
 */
export function register({ connection, docs, vaultIndex: _vaultIndex, projectRoot }) {
  connection.onDocumentFormatting(async (params) => {
    try {
      const uri = params.textDocument.uri;
      const doc = docs.get(uri);
      if (!doc) return null;

      const text = doc.getText();
      if (!text) return null;

      const { formatted, changed } = await formatVaultDocumentAsync(text, {
        projectRoot: projectRoot ?? process.cwd(),
      });

      if (!changed) return null;

      // Single whole-document TextEdit — simplest and always correct.
      const lines = text.split("\n");
      const lastLine = lines.length - 1;
      const lastChar = lines[lastLine].length;

      return [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: lastLine, character: lastChar },
          },
          newText: formatted,
        },
      ];
    } catch (err) {
      connection.console.error(`documentFormatting error: ${err.stack || err}`);
      return null;
    }
  });
}
