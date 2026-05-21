/**
 * template-section-rules.js — Parse template body into a BodySchemaNode tree.
 *
 * Uses `parseHeadingTree` from `body-shapes.js` for heading structure.
 * For each heading, locates its `yaml section-rules` fenced code block,
 * parses the YAML into a SectionRules map, and attaches it.
 *
 * 100% generic — zero section names, zero field names, zero domain knowledge.
 *
 * Also preserves `findSectionRuleBlocks` (used by `lib/validators.js`
 * for leak detection in authored documents).
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import matter from "gray-matter";
import { parseHeadingTree } from "./body-shapes.js";

// ── Public API ────────────────────────────────────────────────────────────

/**
 * @typedef {object} SectionRules
 * @property {boolean}  [required]    - section must be present
 * @property {boolean}  [repeatable]  - heading is a pattern-placeholder
 * @property {object}   [heading]     - { pattern?, enum? }
 * @property {object}   [table]       - { columns?, rows?, strict? }
 *                                       columns: [string] (shorthand) or
 *                                                [{ name, required?, values? }]
 *                                       values: { required?, pattern?, enum?,
 *                                                 unique?, type?, min?, max? }
 *                                       rows: { min?, max? }
 *                                       strict: reject undeclared columns
 * @property {object}   [list]        - { items?: { required?, pattern?, enum? },
 *                                         min?, max?, unique? }
 * @property {object}   [code]        - { lang?, min?, max?, content?: { pattern? } }
 * @property {string}   [formula]     - arithmetic/comparison expression
 * @property {number}   [min]         - min cardinality (repeatable)
 * @property {number}   [max]         - max cardinality (repeatable)
 * @property {string}   [severity]    - override default severity
 * @property {string}   [message]     - override default message
 */

/**
 * @typedef {object} BodySchemaNode
 * @property {number} depth       - heading depth (1-6)
 * @property {string} text        - heading text from template
 * @property {SectionRules|null} sectionRules - parsed section-rules, or null
 * @property {BodySchemaNode[]} children - nested deeper-depth schema nodes
 */

/**
 * Parse a template's markdown body into a BodySchemaNode tree.
 *
 * Walks the heading tree produced by `parseHeadingTree`. For each heading,
 * searches its `contentNodes` for the first `yaml section-rules` fenced
 * code block, parses the YAML, and attaches it as `sectionRules`.
 *
 * Returns the children array (not the virtual root), matching the shape
 * `applyBodySchema` and `validateBodyTemplateSchema` in schema-engine expect.
 *
 * @param {string} templateBodyMarkdown - raw markdown body (frontmatter stripped)
 * @returns {BodySchemaNode[]}
 */
export function parseBodySchema(templateBodyMarkdown) {
  if (typeof templateBodyMarkdown !== "string" || templateBodyMarkdown.length === 0) {
    return [];
  }

  const headingRoot = parseHeadingTree(templateBodyMarkdown);
  return _convertChildren(headingRoot.children);
}

/**
 * Find every `yaml section-rules` fenced code block in a markdown body.
 *
 * The `section-rules` fence is a template-authoring construct — templates
 * declare per-section validation rules with it (see `parseBodySchema`).
 * An authored document must never carry one; its presence means a template
 * fragment was copy-pasted into a document. This locates every such block so
 * the validator can flag it.
 *
 * Detection stays equivalence-tight with `parseBodySchema`: only an exact
 * `lang === "yaml"` + `meta === "section-rules"` fence counts. A near-miss
 * (`yaml SectionRules`, `yaml section-rules extra`, …) is not the recognized
 * construct — `parseBodySchema` would ignore it too — so flagging it would
 * be a phantom error. Keep this exact-match; do not loosen it.
 *
 * @param {string} markdownBody - markdown body (frontmatter stripped)
 * @returns {{line: number}[]} 1-indexed body-relative line of each block's
 *   opening fence; empty when none / on parse failure.
 */
export function findSectionRuleBlocks(markdownBody) {
  if (!markdownBody) return [];

  let tree;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(markdownBody);
  } catch {
    return [];
  }

  const blocks = [];
  _collectSectionRuleBlocks(tree, blocks);
  return blocks;
}

// ── Internals ─────────────────────────────────────────────────────────────

/**
 * Recursively convert HeadingNode children into BodySchemaNode children.
 *
 * @param {import('./body-shapes.js').HeadingNode[]} headingNodes
 * @returns {BodySchemaNode[]}
 */
function _convertChildren(headingNodes) {
  if (!Array.isArray(headingNodes)) return [];

  const result = [];
  for (const hNode of headingNodes) {
    const sectionRules = _extractSectionRules(hNode.contentNodes);
    result.push({
      depth: hNode.depth,
      text: hNode.text,
      sectionRules,
      children: _convertChildren(hNode.children),
    });
  }
  return result;
}

/**
 * Extract SectionRules from a heading's content nodes by finding the first
 * `yaml section-rules` fenced code block and parsing its YAML.
 *
 * Scans content nodes directly (not via findCodeFences, which doesn't
 * expose the `meta` property needed for exact `section-rules` matching).
 *
 * @param {import('mdast').Content[]} contentNodes
 * @returns {SectionRules|null}
 */
function _extractSectionRules(contentNodes) {
  if (!Array.isArray(contentNodes)) return null;

  for (const node of contentNodes) {
    if (
      node.type === "code" &&
      node.lang === "yaml" &&
      node.meta === "section-rules"
    ) {
      return _parseYamlSectionRules(node.value);
    }
  }

  return null;
}

/**
 * Parse a YAML string from a section-rules fence into a SectionRules object.
 * Returns null on parse failure (silent skip per spec).
 *
 * @param {string} yamlString
 * @returns {SectionRules|null}
 */
function _parseYamlSectionRules(yamlString) {
  if (!yamlString || typeof yamlString !== "string") return null;

  try {
    const parsed = matter(`---\n${yamlString}\n---`);
    if (parsed.data && typeof parsed.data === "object" && Object.keys(parsed.data).length > 0) {
      return parsed.data;
    }
    return null;
  } catch {
    // YAML parse error — silent skip.
    return null;
  }
}

/**
 * Recursively collect `yaml section-rules` code nodes into `out`.
 * Recursive (not a flat children scan) because a section-rules fence may sit
 * inside a list item or blockquote, not only at the document's top level.
 */
function _collectSectionRuleBlocks(node, out) {
  if (!node || typeof node !== "object") return;
  if (
    node.type === "code" &&
    node.lang === "yaml" &&
    node.meta === "section-rules"
  ) {
    out.push({ line: node.position?.start?.line ?? 1 });
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) _collectSectionRuleBlocks(child, out);
  }
}
