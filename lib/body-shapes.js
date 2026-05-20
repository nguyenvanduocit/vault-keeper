/**
 * Generic markdown shape parsers — pure infrastructure, ZERO section-type knowledge.
 *
 * Uses remark (same parser setup as the body validation pipeline).
 * All line numbers are 1-indexed, body-relative.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";

// ────────────────────────────────────────────────────────────────────────────
// AST parser (shared, same pipeline as the body validation engine)
// ────────────────────────────────────────────────────────────────────────────

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Parse markdown into an AST.
 * @param {string} markdown
 * @returns {import('mdast').Root}
 */
function parseAst(markdown) {
  return parser.parse(markdown);
}

// ────────────────────────────────────────────────────────────────────────────
// HeadingTree
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} HeadingNode
 * @property {number} depth       - heading depth (1-6)
 * @property {string} text        - raw heading text (not normalized)
 * @property {number} line        - 1-indexed body-relative line of the heading
 * @property {import('mdast').Content[]} contentNodes - AST nodes under this
 *   heading before the next heading at any depth
 * @property {HeadingNode[]} children - nested deeper-depth heading nodes
 */

/**
 * Parse a markdown body into a heading tree.
 *
 * Each node represents a heading; `contentNodes` are the AST nodes that appear
 * between this heading and the next heading (at any depth). `children` are
 * headings at a deeper depth nested under this one.
 *
 * Top-level content nodes (before the first heading) are returned as
 * `{ depth: 0, text: '', line: 1, contentNodes: [...], children: [...] }`.
 *
 * @param {string} markdownBody - raw markdown (frontmatter stripped)
 * @returns {HeadingNode} - a virtual root node (depth 0) containing the tree
 */
export function parseHeadingTree(markdownBody) {
  if (typeof markdownBody !== "string" || markdownBody.length === 0) {
    return { depth: 0, text: "", line: 1, contentNodes: [], children: [] };
  }

  const tree = parseAst(markdownBody);
  const children = Array.isArray(tree?.children) ? tree.children : [];

  // Virtual root
  const root = { depth: 0, text: "", line: 1, contentNodes: [], children: [] };

  // Stack of open heading nodes, from outermost (shallowest) to innermost.
  // The root is always at the bottom of the stack.
  const stack = [root];

  for (const node of children) {
    if (node.type === "heading") {
      const depth = node.depth;
      const text = toString(node);
      const line = node.position?.start?.line ?? 1;

      const headingNode = { depth, text, line, contentNodes: [], children: [] };

      // Pop stack until we find a parent whose depth < this heading's depth.
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }

      // The top of the stack is the parent.
      stack[stack.length - 1].children.push(headingNode);
      stack.push(headingNode);
    } else {
      // Content node — belongs to the most recent heading (top of stack).
      stack[stack.length - 1].contentNodes.push(node);
    }
  }

  return root;
}

// ────────────────────────────────────────────────────────────────────────────
// Table parser
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ParsedTable
 * @property {string[]} headers - lowercased, trimmed header texts
 * @property {string[][]} rows  - array of row arrays; each cell is trimmed text
 * @property {number} line      - 1-indexed body-relative line of the table node
 */

/**
 * Parse a GFM table AST node into headers + rows.
 *
 * @param {import('mdast').Table} node - a `table` AST node
 * @returns {ParsedTable|null} - null if the node is not a valid table
 */
export function parseTable(node) {
  if (!node || node.type !== "table") return null;
  const tableRows = Array.isArray(node.children) ? node.children : [];
  if (tableRows.length === 0) return null;

  const headerRow = tableRows[0];
  const headerCells = Array.isArray(headerRow.children) ? headerRow.children : [];
  const headers = headerCells.map((c) => toString(c).trim().toLowerCase());

  const rows = [];
  for (let i = 1; i < tableRows.length; i++) {
    const row = tableRows[i];
    const cells = Array.isArray(row.children) ? row.children : [];
    rows.push(cells.map((c) => toString(c).trim()));
  }

  return {
    headers,
    rows,
    line: node.position?.start?.line ?? 1,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// List parser
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ParsedListItem
 * @property {string} text - plain text of the list item
 * @property {number} line - 1-indexed body-relative line
 */

/**
 * @typedef {object} ParsedList
 * @property {ParsedListItem[]} items
 */

/**
 * Parse a list AST node into items.
 *
 * @param {import('mdast').List} node - a `list` AST node
 * @returns {ParsedList|null} - null if the node is not a valid list
 */
export function parseList(node) {
  if (!node || node.type !== "list") return null;
  const listItems = Array.isArray(node.children) ? node.children : [];

  const items = [];
  for (const item of listItems) {
    items.push({
      text: toString(item).trim(),
      line: item.position?.start?.line ?? 1,
    });
  }

  return { items };
}

// ────────────────────────────────────────────────────────────────────────────
// Code fence finder
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} CodeFence
 * @property {string|null} lang  - the language tag (e.g. "yaml", "js"), or null
 * @property {string} value      - the raw content of the fenced block
 * @property {number} line       - 1-indexed body-relative line
 */

/**
 * Find all fenced code blocks among an array of AST content nodes.
 *
 * @param {import('mdast').Content[]} contentNodes
 * @returns {CodeFence[]}
 */
export function findCodeFences(contentNodes) {
  if (!Array.isArray(contentNodes)) return [];
  const fences = [];
  for (const node of contentNodes) {
    if (node.type === "code") {
      fences.push({
        lang: node.lang || null,
        value: node.value || "",
        line: node.position?.start?.line ?? 1,
      });
    }
  }
  return fences;
}
