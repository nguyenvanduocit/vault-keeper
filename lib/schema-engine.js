/**
 * Composable schema validation engine.
 *
 * A closed registry of rule primitives. Each primitive is a pure function
 * `(value, param, ctx) => Issue[]`. The engine is 100% generic — zero
 * domain knowledge (no field names, status values, section types, etc.).
 *
 * Spec references: §4 (primitives), §5 (frontmatter), §7 (engine), §8 (meta).
 */

import { evaluate as conditionalEvaluate, getField } from "./conditional-eval.js";
import { evaluate as formulaEvaluate, parse as formulaParse } from "./expression-eval.js";
import { parseHeadingTree, parseTable, parseList, findCodeFences } from "./body-shapes.js";
import { didYouMean } from "./fuzzy-suggest.js";
import { issue } from "./helpers/issue.js";
import { headingLabel, headingPath } from "./helpers/heading-path.js";
import {
  MODIFIER_KEYS,
  normalizeConstraint,
  isSyntaxError,
} from "./helpers/constraint.js";
import {
  PRIMITIVES,
  // chronological exports
  TIME_RE,
  DATETIME_RE,
  toComparableTime,
  formatDateLike,
  beforePrimitive,
  afterPrimitive,
  // scalar exports
  VALID_TYPES,
  scalarPrimitives,
  // structural primitives + their inner-key allow-lists
  headingPrimitive,
  tablePrimitive,
  TABLE_INNER_KEYS,
  TABLE_COLUMN_INNER_KEYS,
  TABLE_VALUES_INNER_KEYS,
  TABLE_ROWS_INNER_KEYS,
  validateTableColumns,
  listPrimitive,
  LIST_INNER_KEYS,
  LIST_ITEMS_INNER_KEYS,
  codePrimitive,
  CODE_INNER_KEYS,
  CODE_CONTENT_INNER_KEYS,
  formulaPrimitive,
  repeatablePrimitive,
} from "./primitives/index.js";

// Public registry re-export — back-compat for `tests/schema-engine.test.js`
// and any external consumer that imports from `./schema-engine`. The
// canonical home is `lib/primitives/index.js`; this file is now just a
// stitching surface.
export { PRIMITIVES };

// Primitive runtime helpers (scalar `resolveMinMaxTarget` / `minMaxLabel`,
// table `normaliseColumns` / `applyValueRulesToColumn` /
// `cellTypeMismatch` / `resolveCellMinMaxTarget`, plus the template-time
// `validateTableColumns` walker) all live next to their primitive
// runtime under `lib/primitives/`. Adding a new table-only or scalar-
// only rule now touches a single file.

// ────────────────────────────────────────────────────────────────────────────
// Synthetic field resolvers (spec §5.2)
// ────────────────────────────────────────────────────────────────────────────

export const SYNTHETIC_RESOLVERS = {
  $path: (docMeta) => docMeta.repoRelativePath,
};

// Constraint shorthand / expanded normalization moved to
// `lib/helpers/constraint.js` (MODIFIER_KEYS + normalizeConstraint +
// isSyntaxError are imported above).

// ────────────────────────────────────────────────────────────────────────────
// applyFieldSchema — frontmatter validation (spec §5)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate frontmatter against a fields schema.
 *
 * @param {{ fields: Record<string, object>, strict?: boolean }} schema
 * @param {object} frontmatter - parsed frontmatter data
 * @param {object} docMeta - { repoRelativePath, fileExists? }
 * @returns {Array<{ level, field, message, fix?, error_type }>}
 */
/**
 * Private helper — resolve the underlying value of a constraint
 * regardless of shorthand vs expanded form. Mirrors the one in
 * `lib/meta/field-schema.js`; will move out with `applyFieldSchema` in
 * the next refactor commit.
 */
function extractPrimitiveValue(fieldSpec, primitiveName) {
  const raw = fieldSpec[primitiveName];
  if (raw === undefined) return undefined;
  const norm = normalizeConstraint(primitiveName, raw);
  return norm.value;
}

export function applyFieldSchema({ fields, strict }, frontmatter, docMeta) {
  const issues = [];
  if (!fields || typeof fields !== "object") return issues;

  const declaredFields = new Set(Object.keys(fields));

  for (const [fieldName, fieldSpec] of Object.entries(fields)) {
    if (!fieldSpec || typeof fieldSpec !== "object") continue;

    // 1. Resolve value
    const value = fieldName.startsWith("$")
      ? SYNTHETIC_RESOLVERS[fieldName]?.(docMeta)
      : getField(frontmatter, fieldName);

    // Determine the field's declared type (needed by min/max)
    const declaredType = extractPrimitiveValue(fieldSpec, "type");

    // 2. Handle `required`
    if ("required" in fieldSpec) {
      const norm = normalizeConstraint("required", fieldSpec.required);
      const isRequired = norm.value === true || norm.value === undefined;

      if (isRequired) {
        // Evaluate `when` gate
        let gatePass = true;
        if (norm.when) {
          try {
            gatePass = conditionalEvaluate(norm.when, frontmatter);
          } catch {
            gatePass = false;
          }
        }

        if (gatePass && (value === undefined || value === null || value === "")) {
          const level = norm.severity || "error";
          issues.push(issue(
            level,
            fieldName,
            norm.message || `Required field '${fieldName}' is missing`,
            "required-missing",
            `Add '${fieldName}' to frontmatter`,
          ));
          // Skip remaining constraints — value is missing
          continue;
        }
      }
    }

    // If value is missing (and not required, or required gate didn't fire), skip constraints
    if (value === undefined || value === null) continue;

    // 3. Run each constraint primitive
    for (const [key, rawConstraint] of Object.entries(fieldSpec)) {
      // Skip `required` (already handled above) and non-primitive keys
      if (key === "required") continue;
      if (!(key in PRIMITIVES)) continue;

      const norm = normalizeConstraint(key, rawConstraint);

      // Evaluate `when` gate
      if (norm.when) {
        try {
          if (!conditionalEvaluate(norm.when, frontmatter)) continue;
        } catch {
          continue;
        }
      }

      const ctx = {
        field: fieldName,
        type: declaredType,
        severity: norm.severity,
        message: norm.message,
        fileExists: docMeta?.fileExists,
      };

      const primitiveIssues = PRIMITIVES[key](value, norm.value, ctx);
      issues.push(...primitiveIssues);
    }
  }

  // 4. Strict mode — undeclared frontmatter keys
  if (strict && frontmatter && typeof frontmatter === "object") {
    for (const key of Object.keys(frontmatter)) {
      if (!declaredFields.has(key)) {
        issues.push(issue(
          "error",
          key,
          `Undeclared field '${key}' is not in the schema.${didYouMean(key, declaredFields)}`,
          "undeclared-field",
          `Remove '${key}' or declare it in the template fields`,
        ));
      }
    }
  }

  return issues;
}

// ────────────────────────────────────────────────────────────────────────────
// Meta-validation (spec §8) — frontmatter `fields:` schema
// ────────────────────────────────────────────────────────────────────────────

// `validateTemplateSchema`, the `extractPrimitiveValue` helper, plus
// `KNOWN_FIELD_KEYS` / `SYNTHETIC_ALLOWED_PRIMITIVES` now live in
// `lib/meta/field-schema.js`. Re-exported here for backward-compat.
export { validateTemplateSchema } from "./meta/field-schema.js";

// ────────────────────────────────────────────────────────────────────────────
// Body schema types and helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} SectionRules
 * @property {boolean}  [required]   - section must exist
 * @property {boolean}  [repeatable] - heading at this level is a pattern-placeholder
 * @property {object}   [heading]    - { pattern?, enum? } constraining heading text
 * @property {object}   [table]      - { columns?, rows?, strict? }
 * @property {object}   [list]       - { items?, min?, max?, unique? }
 * @property {object}   [code]       - { lang?, min?, max?, content? }
 * @property {string}   [formula]    - arithmetic / comparison expression over frontmatter values
 * @property {number}   [min]        - min cardinality (repeatable)
 * @property {number}   [max]        - max cardinality (repeatable)
 * @property {string}   [severity]   - override default severity
 * @property {string}   [message]    - override default message
 */

/**
 * @typedef {object} BodySchemaNode
 * @property {number} depth       - heading depth (1-6, or 0 for root)
 * @property {string} text        - heading text from template
 * @property {SectionRules|null} sectionRules - parsed section-rules, or null
 * @property {BodySchemaNode[]} children - nested deeper-depth schema nodes
 */

/**
 * @typedef {object} BodyIssue
 * @property {string} level      - "error" | "warning"
 * @property {string} field      - heading path (e.g. "## Section › ### Sub")
 * @property {string} message
 * @property {string} error_type
 * @property {string} [fix]
 * @property {number} [bodyLine] - 1-indexed body-relative line
 */

// headingLabel + headingPath moved to lib/helpers/heading-path.js.

/**
 * Normalize a string for heading matching: lowercase, trimmed.
 * Used only by the body-schema orchestrator below — kept private.
 * @param {string} s
 * @returns {string}
 */
function normalizeHeading(s) {
  return (s || "").toLowerCase().trim();
}

// ────────────────────────────────────────────────────────────────────────────
// applyBodySchema — body validation (spec §6)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Validate a markdown document body against a body schema.
 *
 * The body schema is an array of BodySchemaNode (the template heading tree's
 * children, each optionally carrying `sectionRules`). The document body is
 * raw markdown (frontmatter stripped).
 *
 * @param {BodySchemaNode[]} templateBodySchema - template heading tree children
 * @param {string} docMarkdownBody - raw document body markdown
 * @param {object} [docMeta] - additional context (unused in Phase 2, reserved for Phase 3)
 * @param {object} [frontmatter={}] - parsed document frontmatter, passed to `when` evaluation
 * @returns {BodyIssue[]}
 */
export function applyBodySchema(templateBodySchema, docMarkdownBody, docMeta, frontmatter = {}) {
  if (!Array.isArray(templateBodySchema) || templateBodySchema.length === 0) {
    return [];
  }

  const docTree = parseHeadingTree(docMarkdownBody || "");
  const issues = [];

  // Templates typically have a single H1 title heading that wraps all H2
  // section definitions. Documents also have an H1 title (their own name).
  // The H1 text will never match (template title ≠ document title), so we
  // unwrap: use the H1's children as the effective schema and match them
  // against the document's H1 children.  This is purely structural — no
  // domain knowledge.
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

/**
 * Recursively validate document heading children against template schema children.
 *
 * @param {BodySchemaNode[]} schemaNodes - template schema children at this level
 * @param {import('./body-shapes.js').HeadingNode[]} docNodes - document heading children at this level
 * @param {import('mdast').Content[]} parentContentNodes - content nodes of the parent (for root-level content)
 * @param {string[]} ancestorPath - ancestor heading labels for issue field
 * @param {BodyIssue[]} issues - mutable issues accumulator
 * @param {object} frontmatter - parsed document frontmatter for `when` evaluation
 */
function validateChildren(schemaNodes, docNodes, parentContentNodes, ancestorPath, issues, frontmatter) {
  // Separate repeatable vs non-repeatable schema nodes
  const repeatableSchemas = schemaNodes.filter((s) => s.sectionRules?.repeatable);
  const nonRepeatableSchemas = schemaNodes.filter((s) => !s.sectionRules?.repeatable);

  // Track which doc nodes are claimed by non-repeatable matches
  const claimedDocIndices = new Set();

  // 1. Process non-repeatable schema nodes
  for (const schema of nonRepeatableSchemas) {
    const normalizedSchemaText = normalizeHeading(schema.text);
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);

    // Find the matching doc heading
    const matchIdx = docNodes.findIndex(
      (d, idx) => !claimedDocIndices.has(idx) && d.depth === schema.depth && normalizeHeading(d.text) === normalizedSchemaText
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

    // Validate this section's content
    validateSection(schema, docNode, ancestorPath, issues, frontmatter);
  }

  // 2. Process repeatable schema nodes
  for (const schema of repeatableSchemas) {
    const label = headingLabel(schema.depth, schema.text);
    const path = headingPath(ancestorPath, label);
    const rules = schema.sectionRules || {};

    // A repeatable schema claims all unclaimed doc headings at the same depth
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

    // Anchor cardinality issues at the first matched section when at least
    // one exists. When zero match (count < min and minCount > 0) there is no
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

    // Validate each matching doc node against the repeatable schema's rules
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

      // Validate nested children recursively
      if (schema.children && schema.children.length > 0) {
        validateChildren(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, itemLabel], issues, frontmatter);
      }

      // Validate section content (table, list, code, formula)
      validateSectionContent(rules, docNode, itemPath, issues, frontmatter);
    }
  }
}

/**
 * Validate a non-repeatable matched section's content and children.
 */
function validateSection(schema, docNode, ancestorPath, issues, frontmatter) {
  const label = headingLabel(schema.depth, schema.text);
  const path = headingPath(ancestorPath, label);
  const rules = schema.sectionRules || {};

  // Validate section content (table, list, code, formula)
  validateSectionContent(rules, docNode, path, issues, frontmatter);

  // Recurse into children
  if (schema.children && schema.children.length > 0) {
    validateChildren(schema.children, docNode.children, docNode.contentNodes, [...ancestorPath, label], issues, frontmatter);
  }
}

/**
 * Validate section content against section-rules primitives (table, list, code, formula).
 * `frontmatter` is passed through so the `formula` primitive can evaluate
 * arithmetic / comparison expressions against frontmatter values.
 */
function validateSectionContent(rules, docNode, path, issues, frontmatter = {}) {
  const severity = rules.severity || "error";

  // table primitive
  if (rules.table) {
    const tableNode = docNode.contentNodes.find((n) => n.type === "table");
    const parsedTable = tableNode ? parseTable(tableNode) : null;
    const ctx = { field: path, severity, message: rules.message };
    const tableIssues = PRIMITIVES.table(parsedTable, rules.table, ctx);
    const tableAnchorLine = tableNode?.position?.start?.line ?? undefined;
    for (const ti of tableIssues) {
      if (ti.bodyLine == null) ti.bodyLine = tableAnchorLine;
      issues.push(ti);
    }
  }

  // list primitive
  if (rules.list) {
    const listNode = docNode.contentNodes.find((n) => n.type === "list");
    const parsedList = listNode ? parseList(listNode) : null;
    const ctx = { field: path, severity, message: rules.message };
    const listIssues = PRIMITIVES.list(parsedList, rules.list, ctx);
    // Anchor list-level issues (cardinality, list-missing) at the list
    // node. Per-item issues keep their own item.line set by the primitive.
    const listAnchorLine = listNode?.position?.start?.line ?? undefined;
    for (const li of listIssues) {
      if (li.bodyLine == null) li.bodyLine = listAnchorLine;
      issues.push(li);
    }
  }

  // code primitive
  if (rules.code) {
    const fences = findCodeFences(docNode.contentNodes);
    const ctx = { field: path, severity, message: rules.message };
    const codeIssues = PRIMITIVES.code(fences, rules.code, ctx);
    // Anchor cardinality issues at the first fence inside this section,
    // falling back to the section heading line when no fence is present.
    // The `code-content-mismatch` issues already carry their own per-fence
    // bodyLine — do NOT overwrite those.
    const codeAnchorLine = fences?.[0]?.line ?? docNode.line ?? undefined;
    for (const ci of codeIssues) {
      if (ci.bodyLine == null) ci.bodyLine = codeAnchorLine;
      issues.push(ci);
    }
  }

  // formula — evaluates against frontmatter values. After the
  // formula-on-table extraction was removed, frontmatter is the only
  // data source. Reference frontmatter keys directly in the expression
  // (e.g. `formula: "rice_reach * rice_impact / rice_effort >= 5"`).
  if (rules.formula) {
    const ctx = { field: path, severity, message: rules.message };
    const formulaIssues = PRIMITIVES.formula(frontmatter, rules.formula, ctx);
    for (const fi of formulaIssues) {
      fi.bodyLine = docNode.line ?? undefined;
      issues.push(fi);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Meta-validation (spec §8) — body `section-rules`
// ────────────────────────────────────────────────────────────────────────────

// `validateBodyTemplateSchema` and the top-level `SECTION_RULES_KEYS`
// allow-list now live in `lib/meta/body-schema.js` and
// `lib/meta/allowed-keys.js` respectively. Re-exported here for
// backward-compat.
export { validateBodyTemplateSchema } from "./meta/body-schema.js";

