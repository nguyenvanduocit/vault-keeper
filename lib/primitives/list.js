/**
 * `list` primitive — validates a markdown list against list-level
 * (`min` / `max` / `unique`) and per-item (`items.required` /
 * `items.pattern` / `items.enum`) constraints.
 *
 * Per-item issues carry their own `bodyLine` so the LSP / CLI render
 * them at the offending item's line rather than the list head.
 */

import { issue } from "../helpers/issue.js";
import { didYouMean } from "../fuzzy-suggest.js";

/** Keys allowed at the top of `list:`. */
export const LIST_INNER_KEYS = new Set(["items", "min", "max", "unique"]);

/** Keys allowed inside `list.items:`. */
export const LIST_ITEMS_INNER_KEYS = new Set(["required", "pattern", "enum"]);

function validate(_value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;

  if (!_value) {
    return [issue(level, field, ctx.message || "Expected a list but none found", "list-item")];
  }

  const issues = [];
  const items = _value.items || [];

  // List-level cardinality.
  const min = param.min ?? 0;
  const max = param.max ?? Infinity;
  if (items.length < min) {
    issues.push(issue(level, field, ctx.message || `Expected at least ${min} list item(s), found ${items.length}`, "list-item"));
  }
  if (items.length > max) {
    issues.push(issue(level, field, ctx.message || `Expected at most ${max} list item(s), found ${items.length}`, "list-item"));
  }

  // List-level uniqueness on item text.
  if (param.unique) {
    const seen = new Map();
    for (const item of items) {
      const key = item.text;
      if (seen.has(key)) {
        const dup = issue(level, field, ctx.message || `Duplicate list item '${key}'`, "unique-violation");
        dup.bodyLine = item.line;
        issues.push(dup);
      } else {
        seen.set(key, item);
      }
    }
  }

  // Per-item constraints.
  if (param.items && typeof param.items === "object") {
    const itemRules = param.items;
    let re = null;
    if (itemRules.pattern) {
      try {
        re = new RegExp(itemRules.pattern);
      } catch {
        re = null; // unparseable regex — meta-validation surfaces this
      }
    }
    const allowedEnum = Array.isArray(itemRules.enum) ? itemRules.enum.map((v) => String(v)) : null;
    for (const item of items) {
      if (itemRules.required && (!item.text || !item.text.trim())) {
        const i = issue(level, field, ctx.message || `List item is empty`, "list-item");
        i.bodyLine = item.line;
        issues.push(i);
        continue;
      }
      if (re && !re.test(item.text)) {
        const i = issue(level, field, ctx.message || `List item '${item.text}' does not match pattern '${itemRules.pattern}'`, "list-item");
        i.bodyLine = item.line;
        issues.push(i);
      }
      if (allowedEnum && !allowedEnum.includes(item.text)) {
        const i = issue(level, field, ctx.message || `List item '${item.text}' is not in allowed values: [${allowedEnum.join(", ")}]`, "list-item");
        i.bodyLine = item.line;
        issues.push(i);
      }
    }
  }

  return issues;
}

export function validateConfig(param, path, issues) {
  if (param.items && typeof param.items === "object") {
    for (const key of Object.keys(param.items)) {
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
    if (param.items.pattern) {
      try {
        new RegExp(param.items.pattern);
      } catch {
        issues.push(issue(
          "error",
          path,
          `Invalid regex in list.items.pattern of '${path}': ${param.items.pattern}`,
          "template-schema-invalid",
        ));
      }
    }
    if (param.items.enum !== undefined && !Array.isArray(param.items.enum)) {
      issues.push(issue(
        "error",
        path,
        `'list.items.enum' in '${path}' must be an array`,
        "template-schema-invalid",
      ));
    }
  }
}

export const listPrimitive = {
  name: "list",
  ruleType: "object",
  innerKeys: LIST_INNER_KEYS,
  itemsInnerKeys: LIST_ITEMS_INNER_KEYS,
  select({ docNode, parseList }) {
    const listNode = docNode.contentNodes.find((n) => n.type === "list");
    return {
      value: listNode ? parseList(listNode) : null,
      anchorLine: listNode?.position?.start?.line ?? undefined,
    };
  },
  validate,
  validateConfig,
};
