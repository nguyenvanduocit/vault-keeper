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
import { parse as formulaParse } from "../expression-eval.js";
import { SECTION_RULES_KEYS } from "./allowed-keys.js";
import {
  TABLE_INNER_KEYS,
  TABLE_ROWS_INNER_KEYS,
  validateTableColumns,
  LIST_INNER_KEYS,
  LIST_ITEMS_INNER_KEYS,
  CODE_INNER_KEYS,
  CODE_CONTENT_INNER_KEYS,
} from "../primitives/index.js";

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
