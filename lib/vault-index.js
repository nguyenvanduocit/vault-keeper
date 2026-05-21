/**
 * vault-index.js — Pure-function vault link index for CLI consumers.
 *
 * The LSP keeps its own stateful `VaultIndex` class in server/ for didSave
 * incremental updates; this file exposes only the one-shot link walk that
 * the entropy engine needs.
 *
 * No caching, no class instances — call it once per measurement run.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

/** Match `[text](path.md)` and `[text](path.md#anchor)`. Skips URLs. */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

const SKIP_DIRS = new Set(['node_modules', '.git', '.omc', '.vault-keeper']);

/**
 * Walk a vault root for .md files, count incoming markdown body links by
 * resolved absolute target path.
 *
 * @param {string} vaultRoot — absolute path to walk
 * @returns {Promise<Map<string, number>>} target absPath → incoming count
 */
export async function countIncomingLinks(vaultRoot) {
  const files = await walkMarkdown(vaultRoot);
  const counts = new Map();

  await Promise.all(
    files.map(async (absPath) => {
      let body;
      try {
        body = await readFile(absPath, 'utf-8');
      } catch {
        return;
      }
      MD_LINK_RE.lastIndex = 0;
      let m;
      while ((m = MD_LINK_RE.exec(body)) !== null) {
        const rawPath = m[2].split('#')[0];
        if (rawPath.startsWith('http')) continue;
        const target = resolve(dirname(absPath), rawPath);
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }),
  );

  return counts;
}

async function walkMarkdown(root) {
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
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}
