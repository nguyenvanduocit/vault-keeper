/**
 * position-context.js — Determine what semantic element is at a given position.
 *
 * Given a document text and a Position {line, character}, returns a descriptor:
 *   - { type: "frontmatter-key", key: "status", dotPath: "status" }
 *   - { type: "markdown-link", text: "title", path: "../path.md", fullMatch: "[title](../path.md)" }
 *   - { type: "task-id", id: "t-044" }
 *   - { type: "unknown" }
 */

/**
 * @param {string} text — full document text
 * @param {{ line: number, character: number }} position — 0-indexed
 * @returns {PositionContext}
 */
export function getPositionContext(text, position) {
  const lines = text.split("\n");
  const lineIdx = position.line;
  const char = position.character;

  if (lineIdx < 0 || lineIdx >= lines.length) return { type: "unknown" };
  const line = lines[lineIdx];

  // Determine if we're inside frontmatter (between --- fences)
  const fmBounds = findFrontmatterBounds(lines);

  if (fmBounds && lineIdx > fmBounds.openLine && lineIdx < fmBounds.closeLine) {
    // Inside frontmatter — check if cursor is on a key
    const keyMatch = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (keyMatch) {
      const keyStart = keyMatch[1].length;
      const keyEnd = keyStart + keyMatch[2].length;
      if (char >= keyStart && char <= keyEnd) {
        // Build dot-path by walking parent indentation
        const dotPath = buildDotPath(lines, lineIdx, fmBounds);
        return { type: "frontmatter-key", key: keyMatch[2], dotPath };
      }
    }
  }

  // Check for markdown link: [text](path)
  const linkCtx = findMarkdownLinkAt(line, char);
  if (linkCtx) return linkCtx;

  // Check for task-id literal: [spdeoc]-NNN, tc-NNN, tp-NNN (domain-specific prefixes, post Wave 2)
  const taskIdRe = /\b(?:tc|tp|[spdeoc])-(\d{3,})\b/gi;
  let m;
  while ((m = taskIdRe.exec(line)) !== null) {
    if (char >= m.index && char <= m.index + m[0].length) {
      return { type: "task-id", id: m[0].toLowerCase() };
    }
  }

  return { type: "unknown" };
}

/**
 * Find the opening and closing `---` fence lines of frontmatter.
 * Returns { openLine, closeLine } or null.
 */
function findFrontmatterBounds(lines) {
  if (lines.length < 3 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return { openLine: 0, closeLine: i };
    }
  }
  return null;
}

/**
 * Build a dot-path for a YAML key at `lineIdx` by looking at indentation
 * levels of ancestor keys above it.
 */
function buildDotPath(lines, lineIdx, fmBounds) {
  const targetLine = lines[lineIdx];
  const targetIndent = targetLine.search(/\S/);
  const keyMatch = targetLine.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
  if (!keyMatch) return null;

  const parts = [keyMatch[2]];
  let currentIndent = targetIndent;

  // Walk upward to find parent keys
  for (let i = lineIdx - 1; i > fmBounds.openLine; i--) {
    const line = lines[i];
    const indent = line.search(/\S/);
    if (indent < 0) continue; // blank line
    if (indent < currentIndent) {
      const parentKey = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
      if (parentKey) {
        parts.unshift(parentKey[2]);
        currentIndent = indent;
        if (indent === 0) break;
      }
    }
  }

  return parts.join(".");
}

/**
 * Check if position `char` falls within a markdown link on `line`.
 * Returns { type: "markdown-link", text, path, range } or null.
 */
function findMarkdownLinkAt(line, char) {
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (char >= start && char < end) {
      return {
        type: "markdown-link",
        text: m[1],
        path: m[2].split("#")[0], // strip anchor
        anchor: m[2].includes("#") ? m[2].split("#")[1] : null,
        fullMatch: m[0],
        matchStart: start,
        matchEnd: end,
      };
    }
  }
  return null;
}
