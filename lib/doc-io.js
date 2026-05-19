/**
 * doc-io.js — Document I/O + relationship-path resolution.
 *
 * Two helpers shared by every consumer of vault markdown. Lives in `lib/`
 * so the dependency direction stays `lib ← cli` / `lib ← server`.
 */

import { readFile } from "fs/promises";
import matter from "gray-matter";

/**
 * Read a markdown file, split frontmatter from body via gray-matter.
 *
 * Returns `{ frontmatter, body, filepath }` on success or
 * `{ error: <message>, filepath }` on I/O / YAML failure. Never throws — the
 * orchestrator and rules treat parse failures as soft skips, not fatal errors.
 */
export async function parseDocument(filepath) {
  try {
    const content = await readFile(filepath, "utf-8");
    const { data: frontmatter, content: body } = matter(content);
    return { frontmatter, body, filepath };
  } catch (error) {
    return { error: error.message, filepath };
  }
}

/**
 * Normalize a relationship `link.path` value to a graph-lookup key.
 *
 * Returns null for non-document references that should be skipped:
 *   - URLs (https://...)
 *   - Placeholder strings carrying `[...]` (e.g. `[future-prd]`)
 *   - Source-code line refs (`file.go:123`)
 *
 * Strips anchor fragments so `foo.md#AC1` collapses to `foo.md` — anchor
 * resolution is the caller's job.
 */
export function resolveDocPath(linkPath) {
  if (!linkPath || typeof linkPath !== "string") return null;
  if (linkPath.startsWith("http")) return null;
  if (linkPath.includes("[") && linkPath.includes("]")) return null;
  if (/\.(go|ts|js|py|java|rb):\d/.test(linkPath)) return null;
  return linkPath.split("#")[0];
}
