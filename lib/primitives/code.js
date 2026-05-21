/**
 * `code` primitive — validates fenced code blocks in a section.
 * Supports `lang` filter, `min` / `max` fence count, and a per-fence
 * `content.pattern` regex.
 *
 * Per-fence `code-content-mismatch` issues carry their own `bodyLine`
 * so editor squiggles land on the offending fence, not the section
 * heading.
 */

import { issue } from "../helpers/issue.js";

/** Keys allowed at the top of `code:`. */
export const CODE_INNER_KEYS = new Set(["lang", "min", "max", "content"]);

/** Keys allowed inside `code.content:`. */
export const CODE_CONTENT_INNER_KEYS = new Set(["pattern"]);

function validate(_value, param, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const fences = Array.isArray(_value) ? _value : [];
  const issues = [];

  const filtered = param.lang
    ? fences.filter((f) => f.lang && f.lang.toLowerCase() === param.lang.toLowerCase())
    : fences;

  const what = param.lang ? `'${param.lang}' code fence(s)` : "code fence(s)";
  const min = param.min ?? 1;
  const max = param.max ?? Infinity;

  if (filtered.length < min) {
    issues.push(issue(
      level,
      field,
      ctx.message || (filtered.length === 0
        ? `Expected ${min === 1 ? "a" : `at least ${min}`} ${what} but none found`
        : `Expected at least ${min} ${what}, found ${filtered.length}`),
      "code-missing",
    ));
  }
  if (filtered.length > max) {
    issues.push(issue(
      level,
      field,
      ctx.message || `Expected at most ${max} ${what}, found ${filtered.length}`,
      "code-missing",
    ));
  }

  if (param.content && param.content.pattern) {
    let re;
    try {
      re = new RegExp(param.content.pattern);
    } catch {
      return issues; // unparseable regex — meta-validation will flag at template level
    }
    for (const fence of filtered) {
      if (!re.test(fence.value)) {
        const i = issue(
          level,
          field,
          ctx.message || `Code fence at line ${fence.line} does not match content.pattern '${param.content.pattern}'`,
          "code-content-mismatch",
          `Must match: ${param.content.pattern}`,
        );
        i.bodyLine = fence.line;
        issues.push(i);
      }
    }
  }

  return issues;
}

export const codePrimitive = {
  name: "code",
  innerKeys: CODE_INNER_KEYS,
  contentInnerKeys: CODE_CONTENT_INNER_KEYS,
  validate,
};
