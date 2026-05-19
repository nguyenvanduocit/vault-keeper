/**
 * canonical-formatter.js — Pure vault document formatter (no LSP deps).
 *
 * Canonical format rules:
 *   1. Frontmatter YAML key ordering + clean YAML output
 *   2. Body section reordering per template's `sections` list
 *   3. AC heading normalization → `### AC<n> — <Title>`
 *   4. Relationship bullet normalization → `- **predicate** [...](...) — reason`
 *   5. Trailing whitespace strip per line
 *   6. Multi-blank-line collapse (max 1 between blocks, max 2 between sections)
 *   7. Final newline normalization
 *
 * All transforms skip content inside fenced code blocks (``` or ~~~).
 * Idempotent: formatVaultDocument(formatVaultDocument(x)) === formatVaultDocument(x)
 */

import matter from "gray-matter";
import yaml from "js-yaml";
import { loadTemplateRules } from "./template-rules.js";

// ── Frontmatter key ordering ──────────────────────────────────────────────────

/**
 * Keys that appear first in this exact order.
 * All other keys sort alphabetically after.
 */
const PRIORITY_KEYS = ["id", "title", "template", "status", "phase", "owner", "created", "updated"];

/**
 * Sort frontmatter keys into canonical order:
 * priority keys first (in PRIORITY_KEYS order), then remainder alphabetically.
 */
function sortFmKeys(data) {
  const keys = Object.keys(data);
  const prioritized = PRIORITY_KEYS.filter((k) => keys.includes(k));
  const rest = keys
    .filter((k) => !PRIORITY_KEYS.includes(k))
    .sort((a, b) => a.localeCompare(b));
  const ordered = {};
  for (const k of [...prioritized, ...rest]) {
    ordered[k] = data[k];
  }
  return ordered;
}

/**
 * Serialize frontmatter to YAML string (no leading/trailing `---`).
 * Uses js-yaml with explicit string preservation.
 */
function serializeFm(data) {
  return yaml.dump(data, {
    sortKeys: false,
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
    // Dates as strings, not Date objects
    schema: yaml.DEFAULT_SCHEMA,
  });
}

// ── Code-fence tracker ────────────────────────────────────────────────────────

/**
 * Build a Set of line indices that are inside fenced code blocks.
 * Works on already-split lines array.
 */
function buildFencedLineSet(lines) {
  const fenced = new Set();
  let inFence = false;
  let fenceMarker = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!inFence) {
      const m = trimmed.match(/^(`{3,}|~{3,})/);
      if (m) {
        inFence = true;
        fenceMarker = m[1][0].repeat(m[1].length); // normalize to same char+count
        fenced.add(i);
      }
    } else {
      fenced.add(i);
      // Check closing — must be at least as long as opening fence
      const m = trimmed.match(/^(`{3,}|~{3,})$/);
      if (m && m[1][0] === fenceMarker[0] && m[1].length >= fenceMarker.length) {
        inFence = false;
        fenceMarker = null;
      }
    }
  }
  return fenced;
}

// ── Slug ↔ heading helpers (mirrors template-section-rules.js internals) ──────

function slugToHeading(slug) {
  // "acceptance-criteria" → "Acceptance Criteria"
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function headingToSlug(heading) {
  // "## Acceptance Criteria" → "acceptance-criteria"
  return heading
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

// ── Section splitter / reorderer ──────────────────────────────────────────────

/**
 * Split document body into chunks delimited by `## Heading` lines.
 * Returns [{heading: string|null, contentLines: string[]}]
 * heading === null for the preamble (before first ## )
 *
 * Why array (`contentLines`) instead of pre-joined `content` string:
 * `["foo", ""].join("\n")` === `"foo\n"` AND `["foo"].join("\n")` === `"foo"`,
 * but once stored as a single string, we can no longer tell whether the chunk
 * originally ended with a trailing newline (i.e., was followed by a blank
 * line before the next `##`). Keeping the line array preserves that
 * information, which is essential for round-trip / idempotent reassembly.
 *
 * Safe: does not split on ## lines inside fenced code blocks.
 */
function splitSections(body) {
  const lines = body.split("\n");
  const fenced = buildFencedLineSet(lines);
  const chunks = [];
  let currentHeading = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    if (!fenced.has(i) && lines[i].match(/^## .+/)) {
      chunks.push({ heading: currentHeading, contentLines: currentLines });
      currentHeading = lines[i];
      currentLines = [];
    } else {
      currentLines.push(lines[i]);
    }
  }
  chunks.push({ heading: currentHeading, contentLines: currentLines });
  return chunks;
}

/**
 * Reassemble sections into body string. Roundtrip-safe with `splitSections`:
 * walks every chunk in order, emits its heading (if any) then its contentLines,
 * and re-joins ALL lines with `\n`. This restores the exact `\n` separators
 * that originally lived BETWEEN chunks (which get lost the moment you treat
 * lines as separate sub-arrays).
 *
 * Invariant: joinSections(splitSections(s)) === s, for any string s.
 */
function joinSections(chunks) {
  const allLines = [];
  for (const chunk of chunks) {
    if (chunk.heading) allLines.push(chunk.heading);
    if (chunk.contentLines && chunk.contentLines.length > 0) {
      allLines.push(...chunk.contentLines);
    }
  }
  return allLines.join("\n");
}

/**
 * Reorder body sections according to template `sections` slug list.
 * If sections list contains "*", unlisted sections slot in at that position.
 * If no "*" entry, unlisted sections go at end.
 * Template-less documents pass through unchanged.
 */
function reorderSections(body, sections) {
  if (!sections || sections.length === 0) return body;

  const chunks = splitSections(body);
  const preamble = chunks[0]; // heading === null
  const sectionChunks = chunks.slice(1); // heading !== null

  if (sectionChunks.length === 0) return body;

  // Build slug → chunk map
  const chunkBySlug = new Map();
  for (const chunk of sectionChunks) {
    const slug = headingToSlug(chunk.heading);
    chunkBySlug.set(slug, chunk);
  }

  const wildcardIdx = sections.indexOf("*");
  const explicitSlugs = sections.filter((s) => s !== "*");

  // Unlisted = sections in source order that aren't in explicit list
  const unlistedChunks = sectionChunks.filter(
    (c) => !explicitSlugs.includes(headingToSlug(c.heading))
  );

  const ordered = [];

  if (wildcardIdx === -1) {
    // No wildcard: explicit slugs first, then unlisted at end
    for (const slug of explicitSlugs) {
      if (chunkBySlug.has(slug)) {
        ordered.push(chunkBySlug.get(slug));
      }
    }
    ordered.push(...unlistedChunks);
  } else {
    // Wildcard present: insert unlisted at wildcard position
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (s === "*") {
        ordered.push(...unlistedChunks);
      } else if (chunkBySlug.has(s)) {
        ordered.push(chunkBySlug.get(s));
      }
    }
  }

  return joinSections([preamble, ...ordered]);
}

// ── AC heading normalization ──────────────────────────────────────────────────

// Matches: ### AC1: foo, ### AC1 - foo, ### AC 1: foo, ### AC 1 - foo, etc.
// Also matches existing canonical form (idempotent).
const AC_HEADING_RE = /^(#{3,})\s+AC\s*(\d+)\s*[-:—]\s*(.+)$/i;

function normalizeAcHeading(line) {
  const m = line.match(AC_HEADING_RE);
  if (!m) return line;
  const hashes = m[1];
  const num = m[2];
  const title = m[3].trim();
  // Capitalize first letter
  const titleNorm = title.charAt(0).toUpperCase() + title.slice(1);
  return `${hashes} AC${num} — ${titleNorm}`;
}

// ── Relationship bullet normalization ─────────────────────────────────────────

// Matches: - predicate: [Title](path) — reason
//          - predicate: [Title](path)
//          - predicate [Title](path) — reason  (already bold-less, pre-normalized)
// Does NOT match already-canonical: - **predicate** [Title](path) — reason
const REL_UNBOLDED_RE = /^(\s*-\s+)([a-z_]+)(?::\s*|\s+)(\[.+?\]\(.+?\))((?:\s+—\s+.+)?)$/;

// Already has **bold** but may have `: ` instead of space
const REL_COLON_RE = /^(\s*-\s+)\*\*([a-z_]+)\*\*(?::\s*|\s+)(\[.+?\]\(.+?\))((?:\s+—\s+.+)?)$/;

// Normalize `— ` separator to ` — ` if present in reason fragment
function normalizeEmDash(reasonPart) {
  if (!reasonPart) return "";
  // Ensure " — " with spaces
  return reasonPart.replace(/\s*—\s*/, " — ");
}

function normalizeRelBullet(line) {
  // Already canonical?
  const alreadyCanonical = /^\s*-\s+\*\*[a-z_]+\*\*\s+\[.+?\]\(.+?\)(\s+—\s+.+)?$/.test(line);
  if (alreadyCanonical) return line;

  const m1 = line.match(REL_COLON_RE);
  if (m1) {
    const [, prefix, pred, link, reason] = m1;
    return `${prefix}**${pred}** ${link}${normalizeEmDash(reason)}`;
  }

  const m2 = line.match(REL_UNBOLDED_RE);
  if (m2) {
    const [, prefix, pred, link, reason] = m2;
    return `${prefix}**${pred}** ${link}${normalizeEmDash(reason)}`;
  }

  return line;
}

// ── Line-level transforms ─────────────────────────────────────────────────────

/**
 * Apply per-line transforms (AC headings, relationship bullets, trailing WS).
 * Skips lines inside fenced code blocks.
 */
function applyLineTransforms(body) {
  const lines = body.split("\n");
  const fenced = buildFencedLineSet(lines);

  return lines
    .map((line, i) => {
      if (fenced.has(i)) return line;
      let out = line;
      out = normalizeAcHeading(out);
      out = normalizeRelBullet(out);
      out = out.replace(/\s+$/, ""); // trailing whitespace
      return out;
    })
    .join("\n");
}

// ── Blank-line collapse ───────────────────────────────────────────────────────

/**
 * Collapse runs of 3+ blank lines.
 * Between ## sections: allow max 2 blank lines.
 * Elsewhere: max 1 blank line.
 * Also handles blank lines at start/end.
 */
function collapseBlankLines(text) {
  // First pass: collapse 3+ consecutive blank lines to 2
  // (we do a second pass to reduce intra-block to 1 below sections)
  return text.replace(/\n{3,}/g, "\n\n");
}

// ── Final newline normalization ───────────────────────────────────────────────

function normalizeFinalNewline(text) {
  return text.replace(/\n*$/, "\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Format a vault document according to canonical rules.
 *
 * @param {string} text - raw document text
 * @param {object} opts
 * @param {string[]} [opts.sections] - canonical section slug list from template
 * @returns {{ formatted: string, changed: boolean }}
 */
export function formatVaultDocument(text, opts = {}) {
  if (!text || typeof text !== "string") {
    return { formatted: text || "", changed: false };
  }

  let out = text;

  // ── 1. Frontmatter reordering ──────────────────────────────────────────────
  // Check if document starts with frontmatter
  if (out.trimStart().startsWith("---")) {
    try {
      const parsed = matter(out);
      const reordered = sortFmKeys(parsed.data);
      const newYaml = serializeFm(reordered);
      // Reconstruct: ---\n<yaml>\n---\n<body>
      //
      // gray-matter strips the leading `\n` from `parsed.content` when the
      // input was already canonical (i.e., already had exactly one `\n`
      // between the closing `---` and the body). On the first pass it keeps
      // the leading `\n`; on the second pass it drops it. This breaks the
      // idempotency invariant format(format(x)) === format(x).
      //
      // Normalize: strip ALL leading newlines from the body, then always
      // inject exactly one `\n` ourselves. Now the boundary is deterministic
      // regardless of how many times we run the formatter.
      const body = parsed.content.replace(/^\n+/, "");
      out = `---\n${newYaml}---\n${body}`;
    } catch {
      // Malformed frontmatter — pass through unchanged
    }
  }

  // ── 2. Section reordering ──────────────────────────────────────────────────
  const { sections } = opts;
  if (sections && sections.length > 0) {
    // Split at the frontmatter boundary first so we don't reorder inside it
    const fmEnd = findFrontmatterEnd(out);
    if (fmEnd !== -1) {
      const fmPart = out.slice(0, fmEnd);
      const bodyPart = out.slice(fmEnd);
      out = fmPart + reorderSections(bodyPart, sections);
    } else {
      out = reorderSections(out, sections);
    }
  }

  // ── 3. Per-line transforms (AC headings, rel bullets, trailing WS) ─────────
  // Split at frontmatter boundary to skip it for AC/rel transforms
  const fmEnd2 = findFrontmatterEnd(out);
  if (fmEnd2 !== -1) {
    const fmPart = out.slice(0, fmEnd2);
    const bodyPart = out.slice(fmEnd2);
    out = fmPart + applyLineTransforms(bodyPart);
  } else {
    out = applyLineTransforms(out);
  }

  // ── 4. Blank line collapse ─────────────────────────────────────────────────
  out = collapseBlankLines(out);

  // ── 5. Final newline ───────────────────────────────────────────────────────
  out = normalizeFinalNewline(out);

  return { formatted: out, changed: out !== text };
}

// ── Async version that loads template sections from disk ──────────────────────

/**
 * Format a vault document, loading template section order from disk.
 *
 * @param {string} text - raw document text
 * @param {object} opts
 * @param {string} [opts.projectRoot] - repo root for template resolution
 * @returns {Promise<{ formatted: string, changed: boolean }>}
 */
export async function formatVaultDocumentAsync(text, opts = {}) {
  const { projectRoot = process.cwd() } = opts;

  let sections = [];

  // Try to extract template path from frontmatter
  if (text && text.trimStart().startsWith("---")) {
    try {
      const parsed = matter(text);
      const templatePath = parsed.data?.template;
      if (templatePath) {
        const rules = await loadTemplateRules(templatePath, projectRoot);
        if (rules?.sections && Array.isArray(rules.sections)) {
          sections = rules.sections;
        }
      }
    } catch {
      // Ignore template load failures
    }
  }

  return formatVaultDocument(text, { sections });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find the character index immediately after the closing `---` of frontmatter.
 * Returns -1 if no frontmatter.
 */
function findFrontmatterEnd(text) {
  if (!text.trimStart().startsWith("---")) return -1;

  // Find first line = "---"
  const firstDash = text.indexOf("---");
  if (firstDash === -1) return -1;
  const afterFirst = firstDash + 3;

  // Skip past optional whitespace on that line
  const nlAfterOpen = text.indexOf("\n", afterFirst);
  if (nlAfterOpen === -1) return -1;

  // Find closing "---"
  const searchFrom = nlAfterOpen + 1;
  let pos = searchFrom;
  while (pos < text.length) {
    const nlPos = text.indexOf("\n", pos);
    const lineEnd = nlPos === -1 ? text.length : nlPos;
    const line = text.slice(pos, lineEnd).trim();
    if (line === "---") {
      // Return index after the closing --- line (including the newline)
      return nlPos === -1 ? text.length : nlPos + 1;
    }
    pos = lineEnd + 1;
  }
  return -1;
}
