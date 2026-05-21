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

// ────────────────────────────────────────────────────────────────────────────
// Scalar primitives registry (spec §4.1)
// ────────────────────────────────────────────────────────────────────────────
//
// Scalar implementations (type, required, enum, pattern, min, max,
// uniqueItems, exists, description) live in `lib/primitives/scalar.js`
// and are pulled in via `scalarPrimitives`. `VALID_TYPES` rides with
// them. Chronological (before, after) and structural primitives keep
// their own modules; the registry below stitches them together in the
// historical insertion order so error emission order is byte-stable.

/**
 * PRIMITIVES — registry: primitive name → pure function (value, param, ctx) => Issue[]
 *
 * `ctx` carries: { field, type, severity, message, fileExists }
 * `severity` and `message` may override defaults from expanded-form modifiers.
 */
export const PRIMITIVES = {
  // Scalar primitives — runtime delegated to lib/primitives/scalar.js
  // but listed inline here to preserve the original key insertion order
  // (some tests + the example-vault expectations rely on it).
  type: scalarPrimitives.type,
  required: scalarPrimitives.required,
  enum: scalarPrimitives.enum,
  pattern: scalarPrimitives.pattern,
  min: scalarPrimitives.min,
  max: scalarPrimitives.max,

  // `before` / `after` runtime delegated to their primitive spec in
  // lib/primitives/chronological.js. Keeping the registry shape backward-
  // compatible (`PRIMITIVES.before(value, param, ctx)` still works).
  before: beforePrimitive.validate,
  after: afterPrimitive.validate,

  uniqueItems: scalarPrimitives.uniqueItems,
  exists: scalarPrimitives.exists,
  description: scalarPrimitives.description,

  // ── Structural primitives (body only, spec §4.2) ──────────────────────
  //
  // Each structural primitive lives in its own file under lib/primitives/
  // and is bound here in the same registry-key order as the pre-refactor
  // schema-engine.js. Keeping the order stable means the existing
  // example-vault expectations and any diagnostic-emission-order tests
  // continue to pass unchanged.

  heading: headingPrimitive.validate,

  table: tablePrimitive.validate,

  list: listPrimitive.validate,
  code: codePrimitive.validate,
  repeatable: repeatablePrimitive.validate,
  formula: formulaPrimitive.validate,
};

// `resolveMinMaxTarget` and `minMaxLabel` are now private helpers in
// `lib/primitives/scalar.js` — the only place that needs them. Table
// cells use a separate `resolveCellMinMaxTarget` (kept inline below)
// because the type-coercion semantics differ.

// Table-runtime helpers (normaliseColumns, applyValueRulesToColumn,
// cellTypeMismatch, resolveCellMinMaxTarget) and the template-time
// `validateTableColumns` walker now live in `lib/primitives/table.js`,
// imported above. Keeping their semantics next to the `table` primitive
// runtime is the codex-recommended "spec object" pattern — adding a new
// table-only rule touches one file instead of three.

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

/**
 * Extract the primitive value from a field spec entry, handling both
 * shorthand and expanded forms.
 */
function extractPrimitiveValue(fieldSpec, primitiveName) {
  const raw = fieldSpec[primitiveName];
  if (raw === undefined) return undefined;
  const norm = normalizeConstraint(primitiveName, raw);
  return norm.value;
}

// ────────────────────────────────────────────────────────────────────────────
// validateTemplateSchema — meta-validation (spec §8)
// ────────────────────────────────────────────────────────────────────────────

const KNOWN_FIELD_KEYS = new Set([
  ...Object.keys(PRIMITIVES),
  // Modifiers that can appear at the field level when using expanded form
  // are inside the constraint object, not at the field level — but
  // `description` is a recognized primitive (metadata-only).
]);

// Primitives allowed on synthetic ($-prefixed) fields
const SYNTHETIC_ALLOWED_PRIMITIVES = new Set(["pattern", "enum"]);

/**
 * Meta-validate a `fields:` schema — checks the template itself.
 * Returns Issue[] describing problems in the template (never throws).
 *
 * @param {Record<string, object>} fieldsSchema - the `fields:` block from a template
 * @returns {Array<{ level, field, message, fix?, error_type }>}
 */
export function validateTemplateSchema(fieldsSchema) {
  const issues = [];
  if (!fieldsSchema || typeof fieldsSchema !== "object") return issues;

  for (const [fieldName, fieldSpec] of Object.entries(fieldsSchema)) {
    if (!fieldSpec || typeof fieldSpec !== "object") {
      issues.push(issue(
        "error",
        fieldName,
        `Field '${fieldName}' must be an object with constraint declarations`,
        "template-schema-invalid",
      ));
      continue;
    }

    const isSynthetic = fieldName.startsWith("$");
    const declaredType = extractPrimitiveValue(fieldSpec, "type");

    for (const [key, rawConstraint] of Object.entries(fieldSpec)) {
      // Check for unknown primitive keys
      if (!(key in PRIMITIVES)) {
        issues.push(issue(
          "error",
          fieldName,
          `Unknown primitive '${key}' on field '${fieldName}'.${didYouMean(key, Object.keys(PRIMITIVES))}`,
          "template-schema-invalid",
          `Known primitives: ${Object.keys(PRIMITIVES).join(", ")}`,
        ));
        continue;
      }

      // Synthetic fields may only use pattern/enum
      if (isSynthetic && !SYNTHETIC_ALLOWED_PRIMITIVES.has(key) && key !== "description") {
        issues.push(issue(
          "error",
          fieldName,
          `Synthetic field '${fieldName}' may only use 'pattern' or 'enum', not '${key}'`,
          "template-schema-invalid",
        ));
        continue;
      }

      const norm = normalizeConstraint(key, rawConstraint);

      // Validate expanded-form modifier keys
      if (rawConstraint !== null && typeof rawConstraint === "object" && !Array.isArray(rawConstraint)) {
        for (const modKey of Object.keys(rawConstraint)) {
          if (!MODIFIER_KEYS.has(modKey) && modKey !== key) {
            // Allow the constraint value to appear at the same level for primitives
            // but flag unknown modifier keys
            if (!(modKey in PRIMITIVES)) {
              issues.push(issue(
                "error",
                fieldName,
                `Unknown modifier '${modKey}' in expanded constraint '${key}' on field '${fieldName}'.${didYouMean(modKey, MODIFIER_KEYS)}`,
                "template-schema-invalid",
                `Allowed modifiers: value, when, severity, message`,
              ));
            }
          }
        }
      }

      // Per-primitive validation
      switch (key) {
        case "type": {
          if (!VALID_TYPES.has(norm.value)) {
            issues.push(issue(
              "error",
              fieldName,
              `Invalid type '${norm.value}' on field '${fieldName}'. Allowed: ${[...VALID_TYPES].join(", ")}.${didYouMean(String(norm.value), VALID_TYPES)}`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "pattern": {
          try {
            new RegExp(norm.value);
          } catch {
            issues.push(issue(
              "error",
              fieldName,
              `Invalid regex pattern on field '${fieldName}': ${norm.value}`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "enum": {
          if (!Array.isArray(norm.value) || norm.value.length === 0) {
            issues.push(issue(
              "error",
              fieldName,
              `'enum' on field '${fieldName}' must be a non-empty array`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "min":
        case "max": {
          if (typeof norm.value !== "number" || Number.isNaN(norm.value)) {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' on field '${fieldName}' must be a number`,
              "template-schema-invalid",
            ));
          }
          if (!declaredType) {
            issues.push(issue(
              "error",
              fieldName,
              `'${key}' on field '${fieldName}' requires a declared 'type'`,
              "template-schema-invalid",
            ));
          }
          break;
        }
        case "before":
        case "after": {
          // Delegate template-time validation to the primitive spec —
          // the meta logic (chronological-type required, bound must
          // parse) lives next to the runtime in
          // lib/primitives/chronological.js.
          const spec = key === "before" ? beforePrimitive : afterPrimitive;
          issues.push(...spec.validateConfig(norm.value, declaredType, fieldName));
          break;
        }
        case "required": {
          // Validate the `when` string if present
          if (norm.when) {
            try {
              conditionalEvaluate(norm.when, {});
            } catch (e) {
              // Distinguish syntax error from runtime missing-field (which is OK)
              // conditionalEvaluate throws on syntax errors; missing fields return false
              // Re-parse to check: a syntax-level error message indicates a malformed expression
              if (isSyntaxError(e)) {
                issues.push(issue(
                  "error",
                  fieldName,
                  `Invalid 'when' condition on field '${fieldName}': ${e.message}`,
                  "template-schema-invalid",
                ));
              }
            }
          }
          break;
        }
        // description, exists, uniqueItems — no template-level validation needed
        default:
          break;
      }

      // Validate `when` on any constraint (not just required)
      if (key !== "required" && norm.when) {
        try {
          conditionalEvaluate(norm.when, {});
        } catch (e) {
          if (isSyntaxError(e)) {
            issues.push(issue(
              "error",
              fieldName,
              `Invalid 'when' condition on '${key}' constraint of field '${fieldName}': ${e.message}`,
              "template-schema-invalid",
            ));
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Determine if an error from conditionalEvaluate is a syntax error
 * vs a runtime "field not found" error (which is expected during meta-validation
 * since we pass an empty context).
 *
 * Syntax errors mention tokens, characters, unexpected things.
 * Runtime field-not-found: conditionalEvaluate returns false for missing fields,
 * but it does throw for structural issues like "Expected token 'in'".
 */
// isSyntaxError moved to lib/helpers/constraint.js — see import above.

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
// validateBodyTemplateSchema — meta-validation for body section-rules (spec §8)
// ────────────────────────────────────────────────────────────────────────────

/** Keys allowed in a section-rules block. */
const SECTION_RULES_KEYS = new Set([
  "required", "repeatable", "heading", "table", "list", "code", "formula",
  "min", "max", "severity", "message",
]);

// Inner-key allow-lists for compound primitives (LIST_*, CODE_*,
// TABLE_*) now live next to their primitive runtimes in
// `lib/primitives/<name>.js` and are imported above. Meta-validation
// queries each primitive's spec for its closed contract instead of
// duplicating the constants here.

/**
 * Meta-validate a body schema — checks the template's section-rules blocks.
 * Returns Issue[] describing problems in the template (never throws).
 *
 * @param {BodySchemaNode[]} bodySchema - template heading tree children with sectionRules
 * @returns {BodyIssue[]}
 */
export function validateBodyTemplateSchema(bodySchema) {
  const issues = [];
  if (!Array.isArray(bodySchema)) return issues;

  function walk(nodes, ancestors) {
    for (const node of nodes) {
      const label = headingLabel(node.depth, node.text);
      const path = headingPath(ancestors, label);
      const rules = node.sectionRules;

      if (rules && typeof rules === "object") {
        // Check for unknown keys
        for (const key of Object.keys(rules)) {
          if (!SECTION_RULES_KEYS.has(key)) {
            issues.push(issue(
              "error",
              path,
              `Unknown section-rules key '${key}' in '${path}'.${didYouMean(key, SECTION_RULES_KEYS)}`,
              "template-schema-invalid",
              `Allowed keys: ${[...SECTION_RULES_KEYS].join(", ")}`,
            ));
          }
        }

        // Validate heading pattern compiles
        if (rules.heading && rules.heading.pattern) {
          try {
            new RegExp(rules.heading.pattern);
          } catch {
            issues.push(issue(
              "error",
              path,
              `Invalid regex in heading.pattern of '${path}': ${rules.heading.pattern}`,
              "template-schema-invalid",
            ));
          }
        }

        // Validate heading enum is array
        if (rules.heading && rules.heading.enum) {
          if (!Array.isArray(rules.heading.enum) || rules.heading.enum.length === 0) {
            issues.push(issue(
              "error",
              path,
              `heading.enum in '${path}' must be a non-empty array`,
              "template-schema-invalid",
            ));
          }
        }

        // Validate table shape — inner keys, columns array shape, rows
        // and per-column values constraints.
        if (rules.table) {
          if (typeof rules.table !== "object") {
            issues.push(issue(
              "error",
              path,
              `'table' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else {
            for (const key of Object.keys(rules.table)) {
              if (!TABLE_INNER_KEYS.has(key)) {
                issues.push(issue(
                  "error",
                  path,
                  `Unknown key '${key}' in 'table' at '${path}'.${didYouMean(key, TABLE_INNER_KEYS)}`,
                  "template-schema-invalid",
                  `Allowed keys: ${[...TABLE_INNER_KEYS].join(", ")}`,
                ));
              }
            }
            if (rules.table.columns !== undefined) {
              validateTableColumns(rules.table.columns, path, issues);
            }
            if (rules.table.rows && typeof rules.table.rows === "object") {
              for (const key of Object.keys(rules.table.rows)) {
                if (!TABLE_ROWS_INNER_KEYS.has(key)) {
                  issues.push(issue(
                    "error",
                    path,
                    `Unknown key '${key}' in 'table.rows' at '${path}'.${didYouMean(key, TABLE_ROWS_INNER_KEYS)}`,
                    "template-schema-invalid",
                    `Allowed keys: ${[...TABLE_ROWS_INNER_KEYS].join(", ")}`,
                  ));
                }
              }
            }
          }
        }

        // Validate list shape — inner keys and regex.
        // Allowed keys inside `list:` (top), inside `list.items:`, and
        // (legacy) inside `list.item:` so a clear migration error fires.
        if (rules.list) {
          if (typeof rules.list !== "object") {
            issues.push(issue(
              "error",
              path,
              `'list' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else {
            for (const key of Object.keys(rules.list)) {
              if (!LIST_INNER_KEYS.has(key)) {
                issues.push(issue(
                  "error",
                  path,
                  `Unknown key '${key}' in 'list' at '${path}'.${didYouMean(key, LIST_INNER_KEYS)}`,
                  "template-schema-invalid",
                  `Allowed keys: ${[...LIST_INNER_KEYS].join(", ")}`,
                ));
              }
            }
            if (rules.list.items && typeof rules.list.items === "object") {
              for (const key of Object.keys(rules.list.items)) {
                if (!LIST_ITEMS_INNER_KEYS.has(key)) {
                  issues.push(issue(
                    "error",
                    path,
                    `Unknown key '${key}' in 'list.items' at '${path}'.${didYouMean(key, LIST_ITEMS_INNER_KEYS)}`,
                    "template-schema-invalid",
                    `Allowed keys: ${[...LIST_ITEMS_INNER_KEYS].join(", ")}`,
                  ));
                }
              }
              if (rules.list.items.pattern) {
                try {
                  new RegExp(rules.list.items.pattern);
                } catch {
                  issues.push(issue(
                    "error",
                    path,
                    `Invalid regex in list.items.pattern of '${path}': ${rules.list.items.pattern}`,
                    "template-schema-invalid",
                  ));
                }
              }
              if (rules.list.items.enum !== undefined && !Array.isArray(rules.list.items.enum)) {
                issues.push(issue(
                  "error",
                  path,
                  `'list.items.enum' in '${path}' must be an array`,
                  "template-schema-invalid",
                ));
              }
            }
          }
        }

        // Validate code shape — inner keys and content.pattern regex.
        if (rules.code) {
          if (typeof rules.code !== "object") {
            issues.push(issue(
              "error",
              path,
              `'code' in '${path}' must be an object`,
              "template-schema-invalid",
            ));
          } else {
            for (const key of Object.keys(rules.code)) {
              if (!CODE_INNER_KEYS.has(key)) {
                issues.push(issue(
                  "error",
                  path,
                  `Unknown key '${key}' in 'code' at '${path}'.${didYouMean(key, CODE_INNER_KEYS)}`,
                  "template-schema-invalid",
                  `Allowed keys: ${[...CODE_INNER_KEYS].join(", ")}`,
                ));
              }
            }
            if (rules.code.content && typeof rules.code.content === "object") {
              for (const key of Object.keys(rules.code.content)) {
                if (!CODE_CONTENT_INNER_KEYS.has(key)) {
                  issues.push(issue(
                    "error",
                    path,
                    `Unknown key '${key}' in 'code.content' at '${path}'.${didYouMean(key, CODE_CONTENT_INNER_KEYS)}`,
                    "template-schema-invalid",
                    `Allowed keys: ${[...CODE_CONTENT_INNER_KEYS].join(", ")}`,
                  ));
                }
              }
              if (rules.code.content.pattern) {
                try {
                  new RegExp(rules.code.content.pattern);
                } catch {
                  issues.push(issue(
                    "error",
                    path,
                    `Invalid regex in code.content.pattern of '${path}': ${rules.code.content.pattern}`,
                    "template-schema-invalid",
                  ));
                }
              }
            }
          }
        }

        // Validate formula parses
        if (rules.formula) {
          if (typeof rules.formula !== "string") {
            issues.push(issue(
              "error",
              path,
              `'formula' in '${path}' must be a string expression`,
              "template-schema-invalid",
            ));
          } else {
            try {
              formulaParse(rules.formula);
            } catch (e) {
              issues.push(issue(
                "error",
                path,
                `Invalid formula expression in '${path}': ${e.message}`,
                "template-schema-invalid",
              ));
            }
          }
        }

        // Validate min/max are numbers
        if (rules.min !== undefined && (typeof rules.min !== "number" || Number.isNaN(rules.min))) {
          issues.push(issue(
            "error",
            path,
            `'min' in '${path}' must be a number`,
            "template-schema-invalid",
          ));
        }
        if (rules.max !== undefined && (typeof rules.max !== "number" || Number.isNaN(rules.max))) {
          issues.push(issue(
            "error",
            path,
            `'max' in '${path}' must be a number`,
            "template-schema-invalid",
          ));
        }
      }

      // Recurse into children
      if (Array.isArray(node.children)) {
        walk(node.children, [...ancestors, label]);
      }
    }
  }

  walk(bodySchema, []);
  return issues;
}
