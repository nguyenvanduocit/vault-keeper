/**
 * vault-index.js — Lazy vault index for cross-document LSP operations.
 *
 * Provides:
 *   - Workspace symbol search (by task id, title, filename)
 *   - Backlink graph (incoming references via body markdown links)
 *   - Frontmatter cache (for hover previews of link targets)
 *   - Doc resolution by id (t-044, prd-001, etc.)
 *
 * The index is built lazily on first cross-doc request, then incrementally
 * updated on didSave events. Full rebuild is ~500ms for ~1000 docs (async
 * readFile + gray-matter parse, no body-parser needed).
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, dirname, basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import { loadVaultConfig } from "../lib/vault-config.js";

/**
 * Regex to extract markdown links: [text](path.md) or [text](path.md#anchor)
 * Skips URLs (http/https), code fences are NOT filtered — cheap tradeoff for speed.
 */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+\.md(?:#[^)]*)?)\)/g;

/**
 * Generic ID literal: `<lowercase-prefix>-<digits>`. Matches any
 * `prd-001`, `t-042`, `dibb-005`, `adr-013`, … pattern in body text. The
 * vault's filename naming convention (per template) decides which prefixes
 * are real — discovery is plugin-side, validation is template-side.
 */
const TASK_ID_RE = /\b([a-z]+)-(\d{3,})\b/gi;

export class VaultIndex {
  /** @param {string} projectRoot — absolute path to the vault repo root */
  constructor(projectRoot) {
    this._root = projectRoot;
    // Vault content root from `.claude/vault-keeper.json` vaultRoot.
    this._vaultRoot = join(projectRoot, loadVaultConfig(projectRoot).vaultRoot);
    /** @type {Map<string, DocEntry>} absPath → { id, title, template, status, owner, fm, outLinks } */
    this._docs = new Map();
    /** @type {Map<string, Array<{source: string, line: number}>>} absPath(target) → incoming refs */
    this._incoming = new Map();
    this._loaded = false;
    this._loading = null;
  }

  /** Ensure the index is populated. Safe to call multiple times (idempotent). */
  async ensureLoaded() {
    if (this._loaded) return;
    if (this._loading) return this._loading;
    this._loading = this._buildIndex();
    await this._loading;
    this._loaded = true;
    this._loading = null;
  }

  /** Refresh a single file's entry after didSave. */
  async refreshFile(absPath) {
    if (!absPath.startsWith(this._vaultRoot) || !absPath.endsWith(".md")) return;
    // Remove old outgoing edges from this file
    this._removeOutgoingEdges(absPath);
    // Re-parse and re-index
    const entry = await this._parseFile(absPath);
    if (entry) {
      this._docs.set(absPath, entry);
      this._indexOutgoingLinks(absPath, entry);
    } else {
      this._docs.delete(absPath);
    }
  }

  /**
   * Search vault docs matching `query` (case-insensitive substring).
   * Returns SymbolInformation-compatible objects.
   */
  search(query) {
    const q = (query || "").toLowerCase().trim();
    if (!q) return [];
    const results = [];
    for (const [absPath, entry] of this._docs) {
      const matchesId = entry.id && entry.id.toLowerCase().includes(q);
      const matchesTitle = entry.title && entry.title.toLowerCase().includes(q);
      const matchesFilename = basename(absPath).toLowerCase().includes(q);
      if (matchesId || matchesTitle || matchesFilename) {
        results.push({
          name: entry.title || entry.id || basename(absPath, ".md"),
          kind: 1, // SymbolKind.File
          location: {
            uri: pathToFileURL(absPath).href,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 0 },
            },
          },
          containerName: relative(this._root, dirname(absPath)),
        });
      }
      if (results.length >= 50) break; // cap results
    }
    return results;
  }

  /**
   * Resolve an id like "t-044" or "prd-001" to an absolute path.
   * Returns null if not found.
   */
  resolveId(id) {
    if (!id) return null;
    const needle = id.toLowerCase().trim();
    for (const [absPath, entry] of this._docs) {
      if (entry.id && entry.id.toLowerCase() === needle) return absPath;
      const fname = basename(absPath).toLowerCase();
      if (fname.startsWith(`${needle}-`) || fname.startsWith(`${needle}.`)) return absPath;
      if (fname.includes(`-${needle}-`) || fname.includes(`-${needle}.`)) return absPath;
    }
    return null;
  }

  /**
   * Get backlinks (incoming references) for a target file.
   * Returns Array<{source: string, line: number}> where source is absPath.
   */
  getBacklinks(targetAbsPath) {
    return this._incoming.get(targetAbsPath) || [];
  }

  /** Get cached frontmatter for a file. Returns null if not indexed. */
  getFrontmatter(absPath) {
    const entry = this._docs.get(absPath);
    return entry ? entry.fm : null;
  }

  /** Get full entry for a file. */
  getEntry(absPath) {
    return this._docs.get(absPath) || null;
  }

  /**
   * Enumerate all indexed entries.
   * Returns Array<{ absPath: string, id, title, template, status, owner, phase, fm, outLinks }>.
   */
  allEntries() {
    return [...this._docs.entries()].map(([absPath, entry]) => ({ absPath, ...entry }));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  async _buildIndex() {
    const files = await this._walkDir(this._vaultRoot);
    // Parse all files in parallel (batched to avoid fd exhaustion)
    const BATCH = 100;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const entries = await Promise.all(batch.map((f) => this._parseFile(f)));
      for (let j = 0; j < batch.length; j++) {
        if (entries[j]) {
          this._docs.set(batch[j], entries[j]);
        }
      }
    }
    // Build incoming link graph
    for (const [absPath, entry] of this._docs) {
      this._indexOutgoingLinks(absPath, entry);
    }
  }

  /** Recursively walk a directory for .md files, skipping excluded dirs. */
  async _walkDir(dir) {
    const results = [];
    const SKIP = new Set(["codebase", "node_modules", ".git", ".omc"]);
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".specify") continue;
        const full = join(d, e.name);
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) stack.push(full);
        } else if (e.isFile() && e.name.endsWith(".md")) {
          results.push(full);
        }
      }
    }
    return results;
  }

  /** Parse a single file → DocEntry or null on error. */
  async _parseFile(absPath) {
    let content;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      return null;
    }
    let fm, body;
    try {
      const parsed = matter(content);
      fm = parsed.data || {};
      body = parsed.content || "";
    } catch {
      return null;
    }

    // Extract id from filename: any `<prefix>-<digits>` shape, optionally
    // preceded by a `YYYY-MM-DD-` date stamp. Examples: `prd-001-foo.md` →
    // `prd-001`, `2026-05-01-adr-007-bar.md` → `adr-007`. Vault-agnostic —
    // the prefix vocabulary is whatever the templates' filename patterns use.
    const fname = basename(absPath, ".md");
    let id = null;
    const idMatch = fname.match(/^(?:\d{4}-\d{2}-\d{2}-)?([a-z]+-\d+)/i);
    if (idMatch) id = idMatch[1];

    // Extract title: frontmatter.title or first H1
    let title = fm.title || null;
    if (!title) {
      const h1 = body.match(/^#\s+(.+)$/m);
      if (h1) title = h1[1].trim();
    }
    if (!title) title = fname;

    // Extract outgoing markdown links from body
    const outLinks = [];
    let m;
    MD_LINK_RE.lastIndex = 0;
    const lines = body.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      MD_LINK_RE.lastIndex = 0;
      while ((m = MD_LINK_RE.exec(line)) !== null) {
        const rawPath = m[2].split("#")[0]; // strip anchor
        if (rawPath.startsWith("http")) continue;
        // Resolve relative path to absolute
        const resolved = resolve(dirname(absPath), rawPath);
        outLinks.push({ target: resolved, line: lineIdx, raw: rawPath });
      }
    }

    return {
      id,
      title,
      template: fm.template || null,
      status: fm.status || null,
      owner: fm.owner || null,
      phase: fm.phase || null,
      fm,
      outLinks,
    };
  }

  /** Index outgoing links from a file into the incoming graph. */
  _indexOutgoingLinks(absPath, entry) {
    for (const link of entry.outLinks) {
      if (!this._incoming.has(link.target)) {
        this._incoming.set(link.target, []);
      }
      this._incoming.get(link.target).push({ source: absPath, line: link.line });
    }
  }

  /** Remove all outgoing edges originating from `absPath` before re-indexing. */
  _removeOutgoingEdges(absPath) {
    const oldEntry = this._docs.get(absPath);
    if (!oldEntry) return;
    for (const link of oldEntry.outLinks) {
      const arr = this._incoming.get(link.target);
      if (!arr) continue;
      const filtered = arr.filter((r) => r.source !== absPath);
      if (filtered.length === 0) {
        this._incoming.delete(link.target);
      } else {
        this._incoming.set(link.target, filtered);
      }
    }
  }
}
