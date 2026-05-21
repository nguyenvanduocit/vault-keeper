/**
 * walk-vault.js — shared markdown walker for entropy + vault-index.
 *
 * Mirrors the exclusion semantics used by `cli/validate-documents.js`
 * (minimatch-style globs against repo-relative POSIX paths), but keeps the
 * hand-rolled readdir walk so we can preserve the `.specify` allowlist
 * (validator uses glob.sync which has its own dot-dir handling). Without
 * this, default excludes (`**\/README.md`, `**\/CLAUDE.md`, `**\/.vitepress/**`)
 * inflate entropy measurements and disagree with the validator on the
 * same vault.
 *
 * minimatch is reached via the `glob` package's transitive pin (glob@10
 * declares `minimatch: ^9.0.4`). Stable on this branch; revisit if `glob`
 * ever drops it.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { minimatch } from 'minimatch';

const SKIP_DIRS = new Set(['node_modules', '.git', '.omc', '.vault-keeper']);

/**
 * Recursively enumerate `.md` files under `root`, honoring excludePatterns.
 *
 * Dot-directories are skipped except `.specify` (specification dirs may
 * carry vault content). `node_modules`, `.git`, `.omc`, `.vault-keeper`
 * are always skipped. excludePatterns are matched against the path
 * relative to `root`, normalized to POSIX separators.
 *
 * @param {string} root  absolute path to walk
 * @param {{ excludePatterns?: string[] }} [opts]
 * @returns {Promise<string[]>} absolute file paths, sorted ascending
 */
export async function walkVaultMarkdown(root, opts = {}) {
  const excludePatterns = opts.excludePatterns ?? [];
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.specify') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        // Check directory against exclude patterns too, so `**/.vitepress/**`
        // prunes the whole subtree instead of paying per-file matches.
        if (isExcluded(full, root, excludePatterns)) continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (isExcluded(full, root, excludePatterns)) continue;
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

function isExcluded(absPath, root, patterns) {
  if (patterns.length === 0) return false;
  const rel = relative(root, absPath).split(/[\\/]/).join('/');
  if (!rel) return false;
  for (const p of patterns) {
    if (minimatch(rel, p, { dot: true })) return true;
  }
  return false;
}
