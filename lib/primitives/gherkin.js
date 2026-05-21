/**
 * `gherkin` primitive — validates Gherkin fenced code blocks in a section.
 *
 * Uses Cucumber's parser so templates can require real `.feature` syntax
 * inside markdown code fences.
 */

import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";
import { issue } from "../helpers/issue.js";

export const GHERKIN_INNER_KEYS = new Set(["lang", "min", "max", "defaultDialect"]);

const DEFAULT_LANGS = ["gherkin", "feature"];

function configuredLangs(param) {
  if (Array.isArray(param.lang)) {
    return param.lang.map((v) => String(v).toLowerCase());
  }
  if (typeof param.lang === "string") {
    return [param.lang.toLowerCase()];
  }
  return DEFAULT_LANGS;
}

function matchesLang(fence, langs) {
  return fence.lang && langs.includes(fence.lang.toLowerCase());
}

function validate(fences, param = {}, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const allFences = Array.isArray(fences) ? fences : [];
  const langs = configuredLangs(param);
  const filtered = allFences.filter((fence) => matchesLang(fence, langs));
  const issues = [];

  const min = param.min ?? 1;
  const max = param.max ?? Infinity;
  const what = langs.length === 1
    ? `'${langs[0]}' code fence(s)`
    : `Gherkin code fence(s) (${langs.join(", ")})`;

  if (filtered.length < min) {
    issues.push(issue(
      level,
      field,
      ctx.message || (filtered.length === 0
        ? `Expected ${min === 1 ? "a" : `at least ${min}`} ${what} but none found`
        : `Expected at least ${min} ${what}, found ${filtered.length}`),
      "gherkin-missing",
    ));
  }
  if (filtered.length > max) {
    issues.push(issue(
      level,
      field,
      ctx.message || `Expected at most ${max} ${what}, found ${filtered.length}`,
      "gherkin-cardinality",
    ));
  }

  for (const [idx, fence] of filtered.entries()) {
    let envelopes;
    try {
      envelopes = generateMessages(
        fence.value,
        `markdown-fence-${idx}.feature`,
        SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
        {
          defaultDialect: param.defaultDialect,
          includeGherkinDocument: true,
          includePickles: false,
          includeSource: false,
          newId: IdGenerator.uuid(),
        },
      );
    } catch (err) {
      const i = issue(
        level,
        field,
        ctx.message || `Invalid Gherkin feature at line ${fence.line}: ${err.message}`,
        "gherkin-syntax",
        "Fix Gherkin syntax in this fenced code block.",
      );
      i.bodyLine = fence.line;
      issues.push(i);
      continue;
    }

    for (const envelope of envelopes) {
      if (!envelope.parseError) continue;
      const parseError = envelope.parseError;
      const line = parseError.source?.location?.line;
      const i = issue(
        level,
        field,
        ctx.message || `Invalid Gherkin feature at line ${fence.line}: ${parseError.message}`,
        "gherkin-syntax",
        "Fix Gherkin syntax in this fenced code block.",
      );
      i.bodyLine = Number.isFinite(line) ? fence.line + line - 1 : fence.line;
      issues.push(i);
    }
  }

  return issues;
}

export function validateConfig(param, path, issues) {
  if (param.lang !== undefined && typeof param.lang !== "string" && !Array.isArray(param.lang)) {
    issues.push(issue(
      "error",
      path,
      `'gherkin.lang' in '${path}' must be a string or an array of strings`,
      "template-schema-invalid",
    ));
  }
  if (Array.isArray(param.lang)) {
    for (const [idx, value] of param.lang.entries()) {
      if (typeof value !== "string" || !value.trim()) {
        issues.push(issue(
          "error",
          path,
          `'gherkin.lang[${idx}]' in '${path}' must be a non-empty string`,
          "template-schema-invalid",
        ));
      }
    }
  }
  if (param.defaultDialect !== undefined && typeof param.defaultDialect !== "string") {
    issues.push(issue(
      "error",
      path,
      `'gherkin.defaultDialect' in '${path}' must be a string`,
      "template-schema-invalid",
    ));
  }
  for (const key of ["min", "max"]) {
    if (param[key] !== undefined && (typeof param[key] !== "number" || Number.isNaN(param[key]))) {
      issues.push(issue(
        "error",
        path,
        `'gherkin.${key}' in '${path}' must be a number`,
        "template-schema-invalid",
      ));
    }
  }
}

export const gherkinPrimitive = {
  name: "gherkin",
  ruleType: "object",
  innerKeys: GHERKIN_INNER_KEYS,
  select({ docNode, findCodeFences }) {
    const fences = findCodeFences(docNode.contentNodes);
    return {
      value: fences,
      anchorLine: fences?.[0]?.line ?? docNode.line ?? undefined,
    };
  },
  validate,
  validateConfig,
};
