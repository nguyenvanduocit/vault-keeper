/**
 * Meta-validation for a template's body `section-rules`.
 *
 * Walks the heading-tree schema produced by `template-section-rules.js`
 * and surfaces `template-schema-invalid` issues for malformed
 * declarations BEFORE the orchestrator tries to apply them — unknown
 * keys at any nesting level (with fuzzy "did you mean?" suggestions),
 * uncompilable regex, bad enum shape, bad formula expression, …
 *
 * Inner-key allow-lists are owned by the primitive modules
 * (`lib/primitives/<name>.js`) and re-exported through
 * `lib/primitives/index.js`. The walker queries those sets rather
 * than duplicating the closed contract here.
 */

import { issue } from "../helpers/issue.js";
import { didYouMean } from "../fuzzy-suggest.js";
import { headingLabel, headingPath } from "../helpers/heading-path.js";
import { SECTION_RULES_KEYS } from "./allowed-keys.js";
import { BODY_SECTION_PRIMITIVES } from "../primitives/index.js";

const BODY_SECTION_PRIMITIVE_BY_NAME = new Map(
  BODY_SECTION_PRIMITIVES.map((p) => [p.name, p]),
);

function validatePrimitiveRuleShape(primitive, param, path, issues) {
  if (primitive.ruleType === "object" && (typeof param !== "object" || param === null || Array.isArray(param))) {
    issues.push(issue(
      "error",
      path,
      `'${primitive.name}' in '${path}' must be an object`,
      "template-schema-invalid",
    ));
    return;
  }

  if (primitive.ruleType === "string" && typeof param !== "string") {
    issues.push(issue(
      "error",
      path,
      `'${primitive.name}' in '${path}' must be a string expression`,
      "template-schema-invalid",
    ));
    return;
  }

  if (primitive.innerKeys && param && typeof param === "object" && !Array.isArray(param)) {
    for (const key of Object.keys(param)) {
      if (!primitive.innerKeys.has(key)) {
        issues.push(issue(
          "error",
          path,
          `Unknown key '${key}' in '${primitive.name}' at '${path}'.${didYouMean(key, primitive.innerKeys)}`,
          "template-schema-invalid",
          `Allowed keys: ${[...primitive.innerKeys].join(", ")}`,
        ));
      }
    }
  }

  primitive.validateConfig?.(param, path, issues);
}

/**
 * Meta-validate a body schema. Returns Issue[] describing template
 * problems (never throws).
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
        // Top-level unknown section-rules keys.
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

        for (const key of Object.keys(rules)) {
          const primitive = BODY_SECTION_PRIMITIVE_BY_NAME.get(key);
          if (primitive) {
            validatePrimitiveRuleShape(primitive, rules[key], path, issues);
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
