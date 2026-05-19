/**
 * frontmatter-lines.js — map YAML frontmatter dot-paths to source lines.
 *
 * The validators emit issues keyed by a `field` dot-path like
 * `metric.primary.verdict`. LSP diagnostics need a `range` — we have to
 * translate that path back to a 0-indexed line in the markdown source.
 *
 * `gray-matter` returns the parsed object but discards positions. To recover
 * them we re-parse the frontmatter region with the `yaml` package, which
 * preserves CST `range` offsets on every Pair / Scalar node.
 *
 * Algorithm:
 *   1. Locate the `---` fences that delimit frontmatter (markdown convention).
 *   2. Slice the YAML region. Track its starting offset in the full document
 *      (lines BEFORE the inner YAML — usually 1, for the opening `---`).
 *   3. yaml.parseDocument(yamlText) → Document with CST attached.
 *   4. Walk the YAMLMap recursively, building `dotPath → [keyOffset, keyEndOffset]`.
 *      - For each Pair: the key's offset is the line where authors look.
 *      - When the value is itself a YAMLMap, recurse with `parent.child` path.
 *      - Sequence (YAMLSeq) items get no dot-path index (we don't yet need it).
 *   5. Convert offsets to lines using a precomputed array of line-start offsets.
 *
 * Edge cases:
 *   - No frontmatter at all → return empty map; callers fall back to line 0.
 *   - Malformed YAML (yaml.parseDocument throws) → empty map; caller falls back.
 *   - Field that exists only nested inside an array entry → not mapped (yet).
 */

import { parseDocument, isMap, isSeq, isPair, isScalar } from "yaml";

/**
 * Build a line-map for the given document text. Returns an object with:
 *   - `lineFor(dotPath: string): number|null`   — 0-indexed line of the key
 *   - `fmEndLine: number`                       — 0-indexed line of closing `---`
 *   - `hasFrontmatter: boolean`
 */
export function buildFrontmatterLineMap(text) {
  const empty = {
    lineFor: () => null,
    fmEndLine: 0,
    hasFrontmatter: false,
  };
  if (typeof text !== "string" || text.length === 0) return empty;

  // Markdown frontmatter must start at byte 0 with `---\n` (or `---\r\n`).
  // Anything else means "no frontmatter".
  const fenceOpen = /^---\r?\n/;
  const openMatch = text.match(fenceOpen);
  if (!openMatch) return empty;

  const yamlStartOffset = openMatch[0].length;

  // Find closing `---` on its own line (preceded by newline, followed by
  // newline or EOF). `gray-matter` uses the same convention.
  const closeRe = /\r?\n---(\r?\n|$)/g;
  closeRe.lastIndex = yamlStartOffset;
  const closeMatch = closeRe.exec(text);
  if (!closeMatch) return empty;

  const yamlEndOffset = closeMatch.index; // BEFORE the closing newline+`---`
  const yamlText = text.slice(yamlStartOffset, yamlEndOffset);

  // Precompute line starts for the whole document — converts offset → line in O(log n).
  const lineStarts = computeLineStarts(text);

  // If the YAML region itself is malformed (mid-edit syntax error), yaml
  // throws. We surface frontmatter presence but cannot resolve any path → all
  // path queries return null, and the caller's own null-handling kicks in.
  let doc;
  try {
    doc = parseDocument(yamlText, { keepSourceTokens: false });
  } catch {
    return {
      lineFor: () => null,
      fmEndLine: offsetToLine(lineStarts, closeMatch.index + 1),
      hasFrontmatter: true,
    };
  }

  // Walk the map and collect dotPath → absolute-document-offset.
  const pathToOffset = new Map();
  if (doc && doc.contents && isMap(doc.contents)) {
    collect(doc.contents, "", pathToOffset, yamlStartOffset);
  }

  // Offset of the `---` line that closes frontmatter (line of "---", not the
  // newline before it). closeMatch.index points at the `\n` before `---`.
  const fmEndLine = offsetToLine(lineStarts, closeMatch.index + 1);

  return {
    lineFor(dotPath) {
      if (!dotPath || typeof dotPath !== "string") return null;
      const off = pathToOffset.get(dotPath);
      if (off === undefined) return null;
      return offsetToLine(lineStarts, off);
    },
    fmEndLine,
    hasFrontmatter: true,
  };
}

/**
 * Recursively walk a YAMLMap, populating `out[dotPath] = keyOffset` for every
 * pair encountered. Nested maps recurse with the path extended; sequences are
 * NOT indexed per-item (consumers don't need that yet).
 *
 * `yamlBase` is the absolute offset (in the *outer* markdown text) where the
 * inner YAML region starts — yaml package offsets are relative to its input,
 * so we add `yamlBase` to convert back to document-absolute offsets.
 */
function collect(mapNode, prefix, out, yamlBase) {
  if (!isMap(mapNode) || !Array.isArray(mapNode.items)) return;
  for (const pair of mapNode.items) {
    if (!isPair(pair) || !pair.key) continue;
    const key = isScalar(pair.key) ? String(pair.key.value ?? "") : null;
    if (!key) continue;

    // Pair.key.range = [start, valueEnd, nodeEnd] in yaml-relative offsets.
    // Use start (where the key identifier begins).
    const keyRange = pair.key.range;
    if (!keyRange || keyRange.length < 1) continue;

    const dotPath = prefix ? `${prefix}.${key}` : key;
    out.set(dotPath, yamlBase + keyRange[0]);

    // Recurse into nested maps so `success_metric_actual.primary.verdict`
    // resolves to the deepest key. Sequence items skipped (the validator
    // identifies them by parent path, e.g. `relationships.user_stories`,
    // and line=parent key line is the right diagnostic surface anyway).
    if (pair.value && isMap(pair.value)) {
      collect(pair.value, dotPath, out, yamlBase);
    }
  }
}

/**
 * Pre-compute an array of offsets where each line starts. lineStarts[0] is
 * always 0 (start of doc). Subsequent entries are the offset *after* each
 * `\n` in the text. With this, offset→line is binary search.
 */
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Binary search lineStarts for the line containing `offset`. 0-indexed. */
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
