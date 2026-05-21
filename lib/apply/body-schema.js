/**
 * Body validation orchestrator (spec §6).
 *
 * Walks a template heading tree and matches it against the parsed
 * document body. Repeatable schemas claim all unclaimed doc headings
 * at the same depth; non-repeatable schemas match by normalized
 * heading text. For each matched section the orchestrator dispatches
 * to the structural primitives (`table`, `list`, `code`, `formula`)
 * to validate section content.
 *
 * `frontmatter` threads through so the `formula` primitive can
 * evaluate expressions against frontmatter values (after the
 * formula-on-table extraction was removed in v0.10).
 */

import { issue } from "../helpers/issue.js";
import { headingLabel, headingPath } from "../helpers/heading-path.js";
import { normalizeConstraint } from "../helpers/constraint.js";
import { BODY_SECTION_PRIMITIVES, PRIMITIVES } from "../primitives/index.js";
import { evaluate as conditionalEvaluate } from "../conditional-eval.js";
import {
  parseHeadingTree,
  parseTable,
  parseList,
  findCodeFences,
} from "../body-shapes.js";

/** Normalize a heading for case- and whitespace-insensitive matching. */
function normalizeHeading(s) {
  return (s || "").toLowerCase().trim();
}

/**
 * Validate a markdown document body against a body schema.
 *
 * @param {BodySchemaNode[]} templateBodySchema - template heading tree children
 * @param {string} docMarkdownBody - raw document body markdown
 * @param {object} [docMeta] - additional context (reserved)
 * @param {object} [frontmatter={}] - parsed document frontmatter
 * @returns {BodyIssue[]}
 */
export function applyBodySchema(templateBodySchema, docMarkdownBody, docMeta, frontmatter = {}) {
  if (!Array.isArray(templateBodySchema) || templateBodySchema.length === 0) {
    return [];
  }

  const docTree = parseHeadingTree(docMarkdownBody || "");
  const issues = [];

  // Templates typically have a single H1 title heading that wraps all
  // H2 section definitions. Documents also have an H1 title (their own
  // name). The H1 text will never match (template title ≠ document
  // title), so we unwrap: use the H1's children as the effective
  // schema and match them against the document's H1 children. Purely
  // structural — no domain knowledge.
  let effectiveSchema = templateBodySchema;
  let effectiveDocNodes = docTree.children;
  let effectiveContentNodes = docTree.contentNodes;

  if (
    effectiveSchema.length === 1 &&
    effectiveSchema[0].depth === 1 &&
    effectiveDocNodes.length === 1 &&
    effectiveDocNodes[0].depth === 1
  ) {
    effectiveSchema = effectiveSchema[0].children || [];
    effectiveContentNodes = effectiveDocNodes[0].contentNodes || [];
    effectiveDocNodes = effectiveDocNodes[0].children || [];
  }

  validateChildren(effectiveSchema, effectiveDocNodes, effectiveContentNodes, [], issues, frontmatter);

  return issues;
}

export async function applyBodySchemaAsync(templateBodySchema, docMarkdownBody, docMeta, frontmatter = {}) {
  if (!Array.isArray(templateBodySchema) || templateBodySchema.length === 0) {
    return [];
  }

  const docTree = parseHeadingTree(docMarkdownBody || "");
  const issues = [];

  let effectiveSchema = templateBodySchema;
  let effectiveDocNodes = docTree.children;
  let effectiveContentNodes = docTree.contentNodes;

  if (
    effectiveSchema.length === 1 &&
    effectiveSchema[0].depth === 1 &&
    effectiveDocNodes.length === 1 &&
    effectiveDocNodes[0].depth === 1
  ) {
    effectiveSchema = effectiveSchema[0].children || [];
    effectiveContentNodes = effectiveDocNodes[0].contentNodes || [];
    effectiveDocNodes = effectiveDocNodes[0].children || [];
  }

  await validateChildrenAsync(effectiveSchema, effectiveDocNodes, effectiveContentNodes, [], issues, frontmatter);

  return issues;
}

/**
 * Recursively validate document heading children against template
 * schema children at one level.
 */
function validateChildren(schemaNodes, docNodes, parentContentNodes, ancestorPath, issues, frontmatter) {
  const repeatableSchemas = schemaNodes.filter((s) => s.sectionRules?.repeatable);
  const nonRepeatableSchemas = schemaNodes.filter((s) => !s.sectionRules?.repeatable);

  const claimedDocIndices = new Set();

  // 1. Non-repeatable schema nodes — match by normalized heading text.
  for (const schema of nonRepeatableSchemas) {
    const normalizedSchemaText = normalizeHeading(schema.text);
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);

    const matchIdx = docNodes.findIndex(
      (d, idx) => !claimedDocIndices.has(idx) && d.depth === schema.depth && normalizeHeading(d.text) === normalizedSchemaText,
    );

    if (matchIdx === -1) {
      // Missing section — evaluate `required` with optional `when` gate
      if (schema.sectionRules?.required != null) {
        const norm = normalizeConstraint("required", schema.sectionRules.required);
        const isRequired = norm.value === true || norm.value === undefined;

        if (isRequired) {
          let gatePass = true;
          if (norm.when) {
            try {
              gatePass = conditionalEvaluate(norm.when, frontmatter);
            } catch {
              gatePass = false;
            }
          }

          if (gatePass) {
            const severity = norm.severity || schema.sectionRules.severity || "error";
            issues.push({
              level: severity,
              field: path,
              message: norm.message || schema.sectionRules.message || `Required section '${label}' is missing`,
              error_type: "required-missing",
            });
          }
        }
      }
      continue;
    }

    claimedDocIndices.add(matchIdx);
    const docNode = docNodes[matchIdx];

    validateSection(schema, docNode, ancestorPath, issues, frontmatter);
  }

  // 2. Repeatable schema nodes — claim all unclaimed doc headings at the same depth.
  for (const schema of repeatableSchemas) {
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);
    const rules = schema.sectionRules || {};

    const matchingDocNodes = [];
    for (let i = 0; i < docNodes.length; i++) {
      if (!claimedDocIndices.has(i) && docNodes[i].depth === schema.depth) {
        claimedDocIndices.add(i);
        matchingDocNodes.push(docNodes[i]);
      }
    }

    // Cardinality checks — evaluate `when` gate on `required` if present
    let requiredEffective = false;
    if (rules.required != null) {
      const norm = normalizeConstraint("required", rules.required);
      const isRequired = norm.value === true || norm.value === undefined;
      if (isRequired) {
        let gatePass = true;
        if (norm.when) {
          try {
            gatePass = conditionalEvaluate(norm.when, frontmatter);
          } catch {
            gatePass = false;
          }
        }
        requiredEffective = gatePass;
      }
    }
    const minCount = rules.min ?? (requiredEffective ? 1 : 0);
    const maxCount = rules.max ?? Infinity;
    const severity = rules.severity || "error";

    // Anchor cardinality issues at the first matched section when at
    // least one exists. With zero matches and minCount > 0 there is no
    // body location to point at — bodyLine is omitted.
    const cardinalityAnchor = matchingDocNodes[0]?.line ?? undefined;
    if (matchingDocNodes.length < minCount) {
      issues.push({
        level: severity,
        field: path,
        message: rules.message || `Expected at least ${minCount} '${label}' section(s), found ${matchingDocNodes.length}`,
        error_type: "cardinality",
        bodyLine: cardinalityAnchor,
      });
    }
    if (matchingDocNodes.length > maxCount) {
      issues.push({
        level: severity,
        field: path,
        message: rules.message || `Expected at most ${maxCount} '${label}' section(s), found ${matchingDocNodes.length}`,
        error_type: "cardinality",
        bodyLine: cardinalityAnchor,
      });
    }

    // Validate each matching doc node against the repeatable schema.
    for (const docNode of matchingDocNodes) {
      const itemLabel = headingLabel(docNode.depth, docNode.text);
      const itemPath = headingPath(ancestorPath, itemLabel);

      // heading pattern/enum check
      if (rules.heading) {
        const ctx = { field: itemPath, severity: rules.severity, message: rules.message };
        const headingIssues = PRIMITIVES.heading(docNode.text, rules.heading, ctx);
        for (const hi of headingIssues) {
          hi.bodyLine = docNode.line;
          issues.push(hi);
        }
      }

      // Recurse into nested template children
      if (schema.children && schema.children.length > 0) {
        validateChildren(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, itemLabel], issues, frontmatter);
      }

      // Validate section content (table, list, code, formula)
      validateSectionContent(rules, docNode, itemPath, issues, frontmatter);
    }
  }
}

/**
 * Validate a non-repeatable matched section's content and recurse
 * into its children.
 */
function validateSection(schema, docNode, ancestorPath, issues, frontmatter) {
  const label = headingLabel(schema.depth, schema.text);
  const path = headingPath(ancestorPath, label);
  const rules = schema.sectionRules || {};

  validateSectionContent(rules, docNode, path, issues, frontmatter);

  if (schema.children && schema.children.length > 0) {
    validateChildren(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, label], issues, frontmatter);
  }
}

/**
 * Validate section content against registered section-rules primitives.
 * Each primitive owns how to select its input from the heading node, so adding
 * a validator does not require another `if (rules.foo)` block here.
 */
function validateSectionContent(rules, docNode, path, issues, frontmatter = {}) {
  const severity = rules.severity || "error";

  const selectors = { parseTable, parseList, findCodeFences };

  for (const primitive of BODY_SECTION_PRIMITIVES) {
    if (rules[primitive.name] === undefined) continue;
    if (primitive.async) {
      issues.push(issue(
        severity,
        path,
        `Body validator '${primitive.name}' requires applyBodySchemaAsync`,
        "async-validator-unavailable",
      ));
      continue;
    }

    const selected = primitive.select
      ? primitive.select({ docNode, frontmatter, ...selectors })
      : { value: undefined, anchorLine: docNode.line ?? undefined };
    const ctx = { field: path, severity, message: rules.message };
    const primitiveIssues = primitive.validate(selected.value, rules[primitive.name], ctx);

    for (const pi of primitiveIssues) {
      if (pi.bodyLine == null) pi.bodyLine = selected.anchorLine;
      issues.push(pi);
    }
  }
}

async function validateChildrenAsync(schemaNodes, docNodes, parentContentNodes, ancestorPath, issues, frontmatter) {
  const repeatableSchemas = schemaNodes.filter((s) => s.sectionRules?.repeatable);
  const nonRepeatableSchemas = schemaNodes.filter((s) => !s.sectionRules?.repeatable);

  const claimedDocIndices = new Set();

  for (const schema of nonRepeatableSchemas) {
    const normalizedSchemaText = normalizeHeading(schema.text);
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);

    const matchIdx = docNodes.findIndex(
      (d, idx) => !claimedDocIndices.has(idx) && d.depth === schema.depth && normalizeHeading(d.text) === normalizedSchemaText,
    );

    if (matchIdx === -1) {
      if (schema.sectionRules?.required != null) {
        const norm = normalizeConstraint("required", schema.sectionRules.required);
        const isRequired = norm.value === true || norm.value === undefined;

        if (isRequired) {
          let gatePass = true;
          if (norm.when) {
            try {
              gatePass = conditionalEvaluate(norm.when, frontmatter);
            } catch {
              gatePass = false;
            }
          }

          if (gatePass) {
            const severity = norm.severity || schema.sectionRules.severity || "error";
            issues.push({
              level: severity,
              field: path,
              message: norm.message || schema.sectionRules.message || `Required section '${label}' is missing`,
              error_type: "required-missing",
            });
          }
        }
      }
      continue;
    }

    claimedDocIndices.add(matchIdx);
    await validateSectionAsync(schema, docNodes[matchIdx], ancestorPath, issues, frontmatter);
  }

  for (const schema of repeatableSchemas) {
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);
    const rules = schema.sectionRules || {};

    const matchingDocNodes = [];
    for (let i = 0; i < docNodes.length; i++) {
      if (!claimedDocIndices.has(i) && docNodes[i].depth === schema.depth) {
        claimedDocIndices.add(i);
        matchingDocNodes.push(docNodes[i]);
      }
    }

    let requiredEffective = false;
    if (rules.required != null) {
      const norm = normalizeConstraint("required", rules.required);
      const isRequired = norm.value === true || norm.value === undefined;
      if (isRequired) {
        let gatePass = true;
        if (norm.when) {
          try {
            gatePass = conditionalEvaluate(norm.when, frontmatter);
          } catch {
            gatePass = false;
          }
        }
        requiredEffective = gatePass;
      }
    }
    const minCount = rules.min ?? (requiredEffective ? 1 : 0);
    const maxCount = rules.max ?? Infinity;
    const severity = rules.severity || "error";
    const cardinalityAnchor = matchingDocNodes[0]?.line ?? undefined;

    if (matchingDocNodes.length < minCount) {
      issues.push({
        level: severity,
        field: path,
        message: rules.message || `Expected at least ${minCount} '${label}' section(s), found ${matchingDocNodes.length}`,
        error_type: "cardinality",
        bodyLine: cardinalityAnchor,
      });
    }
    if (matchingDocNodes.length > maxCount) {
      issues.push({
        level: severity,
        field: path,
        message: rules.message || `Expected at most ${maxCount} '${label}' section(s), found ${matchingDocNodes.length}`,
        error_type: "cardinality",
        bodyLine: cardinalityAnchor,
      });
    }

    for (const docNode of matchingDocNodes) {
      const itemLabel = headingLabel(docNode.depth, docNode.text);
      const itemPath = headingPath(ancestorPath, itemLabel);

      if (rules.heading) {
        const ctx = { field: itemPath, severity: rules.severity, message: rules.message };
        const headingIssues = PRIMITIVES.heading(docNode.text, rules.heading, ctx);
        for (const hi of headingIssues) {
          hi.bodyLine = docNode.line;
          issues.push(hi);
        }
      }

      if (schema.children && schema.children.length > 0) {
        await validateChildrenAsync(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, itemLabel], issues, frontmatter);
      }

      await validateSectionContentAsync(rules, docNode, itemPath, issues, frontmatter);
    }
  }
}

async function validateSectionAsync(schema, docNode, ancestorPath, issues, frontmatter) {
  const label = headingLabel(schema.depth, schema.text);
  const path = headingPath(ancestorPath, label);
  const rules = schema.sectionRules || {};

  await validateSectionContentAsync(rules, docNode, path, issues, frontmatter);

  if (schema.children && schema.children.length > 0) {
    await validateChildrenAsync(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, label], issues, frontmatter);
  }
}

async function validateSectionContentAsync(rules, docNode, path, issues, frontmatter = {}) {
  const severity = rules.severity || "error";
  const selectors = { parseTable, parseList, findCodeFences };

  for (const primitive of BODY_SECTION_PRIMITIVES) {
    if (rules[primitive.name] === undefined) continue;

    const selected = primitive.select
      ? primitive.select({ docNode, frontmatter, ...selectors })
      : { value: undefined, anchorLine: docNode.line ?? undefined };
    const ctx = { field: path, severity, message: rules.message };
    const primitiveIssues = await primitive.validate(selected.value, rules[primitive.name], ctx);

    for (const pi of primitiveIssues) {
      if (pi.bodyLine == null) pi.bodyLine = selected.anchorLine;
      issues.push(pi);
    }
  }
}
