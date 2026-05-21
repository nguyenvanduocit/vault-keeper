/**
 * vault-index.js — Pure-function vault link index for CLI consumers.
 *
 * The LSP keeps its own stateful `VaultIndex` class in server/ for didSave
 * incremental updates; this file exposes only the one-shot link walk that
 * the entropy engine needs.
 *
 * No caching, no class instances — call it once per measurement run.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { walkVaultMarkdown } from './walk-vault.js';

/** Match `[text](path.md)` and `[text](path.md#anchor)`. Skips URLs. */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

/**
 * Walk a vault root for .md files, count incoming markdown body links by
 * resolved absolute target path.
 *
 * @param {string} vaultRoot — absolute path to walk
 * @param {{ excludePatterns?: string[] }} [opts] — minimatch globs matched
 *   against paths relative to `vaultRoot`; default `[]` (no excludes)
 * @returns {Promise<Map<string, number>>} target absPath → incoming count
 */
export async function countIncomingLinks(vaultRoot, opts = {}) {
  const files = await walkVaultMarkdown(vaultRoot, {
    excludePatterns: opts.excludePatterns ?? [],
  });
  const counts = new Map();

  // NOTE: Promise.all here is unbounded. Practically safe because libuv's
  // threadpool (default UV_THREADPOOL_SIZE=4) queues the readFile work, but
  // a vault with 5000+ docs on a future I/O backend could exhaust fds. If
  // perf complaints surface, switch to a small concurrency pool (e.g.
  // process in batches of 100). Tracking: revisit if scan latency > 5s.
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
