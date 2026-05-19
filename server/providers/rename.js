/**
 * rename.js — LSP renameProvider + fileOperations.willRename for the vault.
 *
 * Handles three rename targets:
 *   1. @handle  — updates all @handle occurrences vault-wide + renames the
 *                 product-data/people/<handle>.md file + updates frontmatter handle: field.
 *   2. title:   — updates only the frontmatter title: field in-place (no propagation).
 *   3. id:      — updates [t-NNN] / t-NNN references in all vault body files.
 *
 * willRenameFiles — when a .md file is renamed via the editor file tree, this
 *   produces TextEdits replacing old relative paths with new relative paths in
 *   every document that links to the renamed file.
 *
 * Known limitations:
 *   - @handle occurrences inside fenced code blocks are also replaced (cheap tradeoff).
 *   - Renaming a doc title does not propagate to link labels in referrers.
 *   - Renaming an id: field does not rename the file itself (file rename is out of scope).
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname, relative, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { TextEdit, RenameFile } from "vscode-languageserver/node.js";

// ── Capability advertisement ─────────────────────────────────────────────────

export const capability = {
  renameProvider: { prepareProvider: true },
  workspace: {
    fileOperations: {
      willRename: { filters: [{ pattern: { glob: "**/*.md" } }] },
    },
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * @param {{ connection: any, docs: any, vaultIndex: import('../vault-index.js').VaultIndex, projectRoot: string }} opts
 */
export function register({ connection, docs, vaultIndex, projectRoot }) {
  // ── onPrepareRename ────────────────────────────────────────────────────────
  connection.onPrepareRename(async (params) => {
    try {
      const doc = docs.get(params.textDocument.uri);
      if (!doc) return null;
      const text = doc.getText();
      const ctx = getRenameContext(text, params.position);
      if (!ctx) return null;
      return ctx.range;
    } catch (err) {
      connection.console.error(`prepareRename error: ${err.stack || err}`);
      return null;
    }
  });

  // ── onRenameRequest ────────────────────────────────────────────────────────
  connection.onRenameRequest(async (params) => {
    try {
      const doc = docs.get(params.textDocument.uri);
      if (!doc) return null;
      const text = doc.getText();
      const ctx = getRenameContext(text, params.position);
      if (!ctx) return null;

      const docAbsPath = fileURLToPath(params.textDocument.uri);
      const newName = params.newName.trim();

      if (ctx.kind === "handle") {
        return await renameHandle(ctx, newName, docAbsPath, vaultIndex, projectRoot, connection);
      }
      if (ctx.kind === "title") {
        return renameTitleInPlace(ctx, newName, params.textDocument.uri);
      }
      if (ctx.kind === "id") {
        return await renameId(ctx, newName, vaultIndex, projectRoot, connection);
      }
      return null;
    } catch (err) {
      connection.console.error(`renameRequest error: ${err.stack || err}`);
      return null;
    }
  });

  // ── onWillRenameFiles ──────────────────────────────────────────────────────
  connection.workspace.onWillRenameFiles(async (params) => {
    try {
      if (!vaultIndex || !projectRoot) return null;
      await vaultIndex.ensureLoaded();

      const documentChanges = [];

      for (const { oldUri, newUri } of params.files) {
        if (!oldUri.endsWith(".md") || !newUri.endsWith(".md")) continue;

        const oldAbsPath = fileURLToPath(oldUri);
        const newAbsPath = fileURLToPath(newUri);
        const backlinks = vaultIndex.getBacklinks(oldAbsPath);

        for (const bl of backlinks) {
          try {
            const referrerDir = dirname(bl.source);
            const newRelPath = relative(referrerDir, newAbsPath);
            const oldRelPath = bl.rawPath || relative(referrerDir, oldAbsPath);

            // Read referrer to find exact link position
            const referrerUri = pathToFileURL(bl.source).href;
            let referrerText;
            const liveDoc = docs.get(referrerUri);
            if (liveDoc) {
              referrerText = liveDoc.getText();
            } else {
              referrerText = await readFile(bl.source, "utf-8");
            }

            const edits = buildLinkReplacementEdits(referrerText, oldAbsPath, referrerDir, newRelPath);
            if (edits.length > 0) {
              documentChanges.push({
                textDocument: { uri: referrerUri, version: null },
                edits,
              });
            }
          } catch (err) {
            connection.console.warn(
              `willRenameFiles: skipping referrer ${bl.source}: ${err.message}`,
            );
          }
        }
      }

      return documentChanges.length > 0 ? { documentChanges } : null;
    } catch (err) {
      connection.console.error(`willRenameFiles error: ${err.stack || err}`);
      return null;
    }
  });
}

// ── Rename context detection ─────────────────────────────────────────────────

/**
 * Determine what is renameable at a cursor position.
 * Returns { kind, range, value } or null.
 *
 * kind: "handle" | "title" | "id"
 */
function getRenameContext(text, position) {
  const lines = text.split("\n");
  const lineIdx = position.line;
  const char = position.character;
  if (lineIdx < 0 || lineIdx >= lines.length) return null;

  const line = lines[lineIdx];

  // Detect frontmatter bounds
  const fmBounds = findFrontmatterBounds(lines);

  // Inside frontmatter?
  if (fmBounds && lineIdx > fmBounds.openLine && lineIdx < fmBounds.closeLine) {
    // title: field
    const titleMatch = line.match(/^title:\s*(.+)$/);
    if (titleMatch) {
      const keyName = "title";
      const keyEnd = line.indexOf(":") + 1;
      if (char > line.indexOf(keyName) && char <= line.length) {
        const valueStart = keyEnd + (line[keyEnd] === " " ? 1 : 0);
        return {
          kind: "title",
          range: {
            start: { line: lineIdx, character: valueStart },
            end: { line: lineIdx, character: line.length },
          },
          value: titleMatch[1].trim(),
        };
      }
    }

    // id: field
    const idMatch = line.match(/^id:\s*(.+)$/);
    if (idMatch) {
      const keyEnd = line.indexOf(":") + 1;
      if (char > line.indexOf("id") && char <= line.length) {
        const valueStart = keyEnd + (line[keyEnd] === " " ? 1 : 0);
        return {
          kind: "id",
          range: {
            start: { line: lineIdx, character: valueStart },
            end: { line: lineIdx, character: line.length },
          },
          value: idMatch[1].trim(),
        };
      }
    }
  }

  // @handle detection in body (and frontmatter handle: value)
  const handleRe = /@([\w-]+)/g;
  let m;
  while ((m = handleRe.exec(line)) !== null) {
    const start = m.index; // position of '@'
    const end = start + m[0].length;
    if (char >= start && char < end) {
      return {
        kind: "handle",
        range: {
          start: { line: lineIdx, character: start },
          end: { line: lineIdx, character: end },
        },
        value: m[1], // without '@'
      };
    }
  }

  return null;
}

function findFrontmatterBounds(lines) {
  if (lines.length < 3 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { openLine: 0, closeLine: i };
  }
  return null;
}

// ── Handle rename ────────────────────────────────────────────────────────────

async function renameHandle(ctx, newHandle, docAbsPath, vaultIndex, projectRoot, connection) {
  const oldHandle = ctx.value; // e.g. "alice"
  // newHandle may come with or without '@'
  const cleanNew = newHandle.startsWith("@") ? newHandle.slice(1) : newHandle;
  const oldAtHandle = `@${oldHandle}`;
  const newAtHandle = `@${cleanNew}`;

  const documentChanges = [];

  if (!vaultIndex || !projectRoot) return null;
  await vaultIndex.ensureLoaded();

  // 1. Scan all vault docs for @handle occurrences
  for (const entry of vaultIndex.allEntries()) {
    const absPath = entry.absPath;
    try {
      // Get body text: check cached body first, then read file
      let fileText = entry.body ?? null;
      if (fileText == null) {
        fileText = await readFile(absPath, "utf-8");
      }

      const edits = buildHandleReplacementEdits(fileText, oldAtHandle, newAtHandle);

      // Also update frontmatter handle: field if this is the people file
      const fm = entry.fm || {};
      if (fm.handle === oldHandle) {
        // Find handle: line in frontmatter
        const lines = fileText.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^handle:\s*(.+)$/);
          if (m && m[1].trim() === oldHandle) {
            const valueStart = lines[i].indexOf(m[1]);
            edits.push({
              range: {
                start: { line: i, character: valueStart },
                end: { line: i, character: valueStart + m[1].trim().length },
              },
              newText: cleanNew,
            });
            break;
          }
        }
      }

      if (edits.length > 0) {
        const uri = pathToFileURL(absPath).href;
        documentChanges.push({
          textDocument: { uri, version: null },
          edits,
        });
      }
    } catch (err) {
      connection.console.warn(`renameHandle: skipping ${absPath}: ${err.message}`);
    }
  }

  // 2. Rename the product-data/people/<handle>.md file if it exists
  const peopleDir = resolve(projectRoot, "product-data", "people");
  const oldPeoplePath = resolve(peopleDir, `${oldHandle}.md`);
  const newPeoplePath = resolve(peopleDir, `${cleanNew}.md`);

  // Only add RenameFile if the old file is actually indexed (exists)
  if (vaultIndex.getEntry(oldPeoplePath)) {
    documentChanges.push(
      RenameFile.create(
        pathToFileURL(oldPeoplePath).href,
        pathToFileURL(newPeoplePath).href,
        { ignoreIfExists: false, overwrite: false },
      ),
    );
  }

  return documentChanges.length > 0 ? { documentChanges } : null;
}

/**
 * Find all @handle occurrences in text and return TextEdits replacing them.
 */
function buildHandleReplacementEdits(text, oldAtHandle, newAtHandle) {
  const edits = [];
  const lines = text.split("\n");
  // Escape for regex: '@alice-smith' → literal match
  const escaped = oldAtHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?![\\w-])`, "g");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      edits.push({
        range: {
          start: { line: i, character: m.index },
          end: { line: i, character: m.index + oldAtHandle.length },
        },
        newText: newAtHandle,
      });
    }
  }
  return edits;
}

// ── Title rename ─────────────────────────────────────────────────────────────

function renameTitleInPlace(ctx, newTitle, docUri) {
  const edit = TextEdit.replace(ctx.range, newTitle);
  return {
    documentChanges: [
      {
        textDocument: { uri: docUri, version: null },
        edits: [edit],
      },
    ],
  };
}

// ── ID rename ────────────────────────────────────────────────────────────────

async function renameId(ctx, newId, vaultIndex, projectRoot, connection) {
  const oldId = ctx.value.trim(); // e.g. "t-069"
  const cleanNew = newId.trim();

  if (!vaultIndex || !projectRoot) return null;
  await vaultIndex.ensureLoaded();

  const documentChanges = [];

  // Pattern: [t-069] references and bare t-069 word occurrences
  const escapedOld = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match [t-069] or bare t-069 (word boundary)
  const re = new RegExp(`\\[${escapedOld}\\]|\\b${escapedOld}\\b`, "gi");

  for (const entry of vaultIndex.allEntries()) {
    const absPath = entry.absPath;
    try {
      let fileText = entry.body ?? null;
      if (fileText == null) {
        fileText = await readFile(absPath, "utf-8");
      }

      const edits = [];
      const lines = fileText.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const matched = m[0];
          // Replace preserving bracket wrapping
          const replacement = matched.startsWith("[") ? `[${cleanNew}]` : cleanNew;
          edits.push({
            range: {
              start: { line: i, character: m.index },
              end: { line: i, character: m.index + matched.length },
            },
            newText: replacement,
          });
        }
      }

      if (edits.length > 0) {
        documentChanges.push({
          textDocument: { uri: pathToFileURL(absPath).href, version: null },
          edits,
        });
      }
    } catch (err) {
      connection.console.warn(`renameId: skipping ${absPath}: ${err.message}`);
    }
  }

  return documentChanges.length > 0 ? { documentChanges } : null;
}

// ── willRenameFiles helpers ──────────────────────────────────────────────────

/**
 * Build TextEdits for a referrer doc that replace all links pointing to
 * oldAbsPath with a new relative path.
 */
function buildLinkReplacementEdits(referrerText, oldAbsPath, referrerDir, newRelPath) {
  const edits = [];
  const lines = referrerText.split("\n");
  // Match [text](path.md) or [text](path.md#anchor)
  const linkRe = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const rawPath = m[2].split("#")[0];
      if (rawPath.startsWith("http")) continue;

      let resolvedTarget;
      try {
        resolvedTarget = resolve(referrerDir, rawPath);
      } catch {
        continue;
      }

      if (resolvedTarget !== oldAbsPath) continue;

      // Replace the path portion only — preserve label and anchor
      const anchor = m[2].includes("#") ? m[2].slice(m[2].indexOf("#")) : "";
      const newPath = newRelPath + anchor;
      // Position of '(' in the full match
      const parenStart = m.index + 1 + m[1].length + 2; // '[' + label + ']('
      const parenEnd = parenStart + m[2].length;

      edits.push({
        range: {
          start: { line: i, character: parenStart },
          end: { line: i, character: parenEnd },
        },
        newText: newPath,
      });
    }
  }
  return edits;
}
