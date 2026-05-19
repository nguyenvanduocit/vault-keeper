/**
 * template-section-rules.js — Extract per-section validation rules from
 * template body via AST.
 *
 * Templates declare inline rules using fenced code blocks with lang "yaml"
 * and meta "section-rules" within each H2 section:
 *
 *   ## Acceptance Criteria
 *   ```yaml section-rules
 *   required: true
 *   heading_format: "### AC<n> — <text> — `<priority>` · `<status>`"
 *   valid_priorities: [must, should, nice]
 *   ```
 *
 * This module parses the template body AST, extracts those blocks, and
 * returns a map keyed by snake_case section name → rules object.  The
 * shape matches body-parser's `formatHints` convention so it can be
 * passed through directly.
 *
 * Also exposes `getRequiredSections()` to derive the list of required
 * H2 sections from `required: true` flags — replacing the frontmatter
 * `required_body_sections` array.
 */

import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";
import matter from "gray-matter";

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Load section rules from a template file on disk.
 *
 * @param {string} templatePath - absolute or repo-relative path
 * @param {string} [projectRoot] - repo root for relative resolution
 * @returns {Promise<Record<string, object>>} snake_case section name → rules
 */
export async function loadTemplateSectionRules(templatePath, projectRoot = process.cwd()) {
  if (!templatePath) return {};

  const absPath = isAbsolute(templatePath)
    ? templatePath
    : join(projectRoot, templatePath);

  let content;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    return {};
  }

  let body;
  try {
    body = matter(content).content || "";
  } catch {
    return {};
  }

  return parseSectionRules(body);
}

/**
 * Parse section rules from markdown body content (frontmatter stripped).
 *
 * @param {string} markdownBody
 * @returns {Record<string, object>} snake_case section name → rules
 */
export function parseSectionRules(markdownBody) {
  if (!markdownBody) return {};

  let tree;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(markdownBody);
  } catch {
    return {};
  }

  const children = Array.isArray(tree?.children) ? tree.children : [];
  const result = {};

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== "heading" || node.depth !== 2) continue;

    const headingText = toString(node).trim();
    const key = _toSnakeCase(headingText);

    // Collect subtree until next H2.
    const subtree = [];
    for (let j = i + 1; j < children.length; j++) {
      if (children[j].type === "heading" && children[j].depth === 2) break;
      subtree.push(children[j]);
    }

    // Find first ```yaml section-rules code block.
    for (const child of subtree) {
      if (
        child.type === "code" &&
        child.lang === "yaml" &&
        child.meta === "section-rules"
      ) {
        try {
          const parsed = matter(`---\n${child.value}\n---`);
          if (parsed.data && typeof parsed.data === "object") {
            result[key] = parsed.data;
          }
        } catch {
          // YAML parse error — skip silently.
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Derive a `required_body_sections` list from section rules.
 * Returns heading strings like `"## Relationships"` for sections
 * with `required: true`.
 *
 * @param {Record<string, object>} sectionRules - output of parseSectionRules
 * @returns {string[]}
 */
export function getRequiredSections(sectionRules) {
  return Object.entries(sectionRules)
    .filter(([, rules]) => rules.required === true)
    .map(([key]) => `## ${_toHeadingCase(key)}`);
}

// ── Internals ─────────────────────────────────────────────────────────────

function _toSnakeCase(text) {
  return text.toLowerCase().replace(/\s+/g, "_");
}

function _toHeadingCase(snakeCase) {
  return snakeCase
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
