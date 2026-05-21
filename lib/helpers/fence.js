/**
 * Shared fenced-code-block helpers for the `code`, `mermaid`, and
 * `gherkin` primitives.
 *
 * Each of those primitives selects the same way (every fence in the
 * section) and the parser-backed two — `mermaid` and `gherkin` — also
 * share lang resolution, lang matching, fence-count cardinality, and
 * the `lang` / `min` / `max` config checks. The genuinely
 * parser-specific code (Mermaid's `parse` loop, Gherkin's
 * `generateMessages` envelope handling) stays in the primitive files.
 *
 * Pure helpers — no side effects, no domain knowledge.
 */

import { issue } from "./issue.js";

/**
 * `select` body shared verbatim by `code`, `mermaid`, and `gherkin`:
 * collect every fenced code block in the section, anchored to the
 * first fence's line (falling back to the section heading line).
 *
 * @param {{ docNode: object, findCodeFences: Function }} args
 * @returns {{ value: object[], anchorLine: number|undefined }}
 */
export function fenceSelect({ docNode, findCodeFences }) {
  const fences = findCodeFences(docNode.contentNodes);
  return {
    value: fences,
    anchorLine: fences?.[0]?.line ?? docNode.line ?? undefined,
  };
}

/**
 * Resolve the configured fence languages from `param.lang`, lower-cased.
 * Accepts a string, an array of strings, or nothing (falls back to the
 * primitive's `defaultLangs`).
 *
 * @param {object} param - the section-rules object for the primitive
 * @param {string[]} defaultLangs - per-primitive default lang list
 * @returns {string[]}
 */
export function configuredLangs(param, defaultLangs) {
  if (Array.isArray(param.lang)) {
    return param.lang.map((v) => String(v).toLowerCase());
  }
  if (typeof param.lang === "string") {
    return [param.lang.toLowerCase()];
  }
  return defaultLangs;
}

/**
 * Whether a fence's declared language is one of `langs` (case-insensitive).
 *
 * @param {{ lang?: string }} fence
 * @param {string[]} langs - lower-cased candidate languages
 * @returns {boolean}
 */
export function matchesLang(fence, langs) {
  return fence.lang && langs.includes(fence.lang.toLowerCase());
}

/**
 * Apply `min` / `max` cardinality to a lang-filtered fence list.
 * Reproduces the parser-primitive cardinality blocks exactly — the
 * `what` label, the `missing` vs `cardinality` split, and the message
 * wording are all byte-identical to the original mermaid/gherkin code.
 *
 * @param {object[]} filtered - fences already filtered to matching langs
 * @param {object} param - the section-rules object (`min`, `max`)
 * @param {object} ctx - validation context (`severity`, `field`, `message`)
 * @param {{ langs: string[], multiLangNoun: string, missingType: string, cardinalityType: string }} opts
 *   - `langs`: the resolved fence languages (drives the `what` label)
 *   - `multiLangNoun`: label noun for the multi-lang `what` (e.g. "Mermaid")
 *   - `missingType` / `cardinalityType`: `error_type` strings
 * @returns {Issue[]}
 */
export function checkFenceCardinality(filtered, param, ctx, { langs, multiLangNoun, missingType, cardinalityType }) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const issues = [];

  const min = param.min ?? 1;
  const max = param.max ?? Infinity;
  const what = langs.length === 1
    ? `'${langs[0]}' code fence(s)`
    : `${multiLangNoun} code fence(s) (${langs.join(", ")})`;

  if (filtered.length < min) {
    issues.push(issue(
      level,
      field,
      ctx.message || (filtered.length === 0
        ? `Expected ${min === 1 ? "a" : `at least ${min}`} ${what} but none found`
        : `Expected at least ${min} ${what}, found ${filtered.length}`),
      missingType,
    ));
  }
  if (filtered.length > max) {
    issues.push(issue(
      level,
      field,
      ctx.message || `Expected at most ${max} ${what}, found ${filtered.length}`,
      cardinalityType,
    ));
  }

  return issues;
}

/**
 * Template-time config check for the `lang` / `min` / `max` keys shared
 * by `mermaid` and `gherkin`. `primitiveName` ("mermaid" / "gherkin")
 * is interpolated into the messages so they come out per-primitive but
 * structurally identical.
 *
 * @param {object} param - the section-rules object
 * @param {string} path - section-rules path for the diagnostic
 * @param {string} primitiveName - "mermaid" or "gherkin"
 * @param {Issue[]} issues - accumulator the helper appends to
 */
export function validateFenceLangConfig(param, path, primitiveName, issues) {
  if (param.lang !== undefined && typeof param.lang !== "string" && !Array.isArray(param.lang)) {
    issues.push(issue(
      "error",
      path,
      `'${primitiveName}.lang' in '${path}' must be a string or an array of strings`,
      "template-schema-invalid",
    ));
  }
  if (Array.isArray(param.lang)) {
    for (const [idx, value] of param.lang.entries()) {
      if (typeof value !== "string" || !value.trim()) {
        issues.push(issue(
          "error",
          path,
          `'${primitiveName}.lang[${idx}]' in '${path}' must be a non-empty string`,
          "template-schema-invalid",
        ));
      }
    }
  }
  for (const key of ["min", "max"]) {
    if (param[key] !== undefined && (typeof param[key] !== "number" || Number.isNaN(param[key]))) {
      issues.push(issue(
        "error",
        path,
        `'${primitiveName}.${key}' in '${path}' must be a number`,
        "template-schema-invalid",
      ));
    }
  }
}
