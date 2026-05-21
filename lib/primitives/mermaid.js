/**
 * `mermaid` primitive — validates Mermaid fenced code blocks in a section.
 *
 * Uses Mermaid's own parser so common diagrams such as flowchart and sequence
 * diagrams follow Mermaid's real syntax rather than a local regex subset.
 */

import mermaid from "mermaid";
import { issue } from "../helpers/issue.js";

export const MERMAID_INNER_KEYS = new Set(["lang", "min", "max"]);

const DEFAULT_LANGS = ["mermaid", "mmd"];

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

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

function parseMermaidLine(err) {
  const loc = err?.hash?.loc;
  if (loc && Number.isFinite(loc.first_line)) {
    return loc.first_line + 1;
  }
  const match = String(err?.message || "").match(/line\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function validate(fences, param = {}, ctx) {
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
    : `Mermaid code fence(s) (${langs.join(", ")})`;

  if (filtered.length < min) {
    issues.push(issue(
      level,
      field,
      ctx.message || (filtered.length === 0
        ? `Expected ${min === 1 ? "a" : `at least ${min}`} ${what} but none found`
        : `Expected at least ${min} ${what}, found ${filtered.length}`),
      "mermaid-missing",
    ));
  }
  if (filtered.length > max) {
    issues.push(issue(
      level,
      field,
      ctx.message || `Expected at most ${max} ${what}, found ${filtered.length}`,
      "mermaid-cardinality",
    ));
  }

  for (const fence of filtered) {
    try {
      await mermaid.parse(fence.value, { suppressErrors: false });
    } catch (err) {
      const i = issue(
        level,
        field,
        ctx.message || `Invalid Mermaid diagram at line ${fence.line}: ${err.message}`,
        "mermaid-syntax",
        "Fix Mermaid syntax in this fenced code block.",
      );
      const relativeLine = parseMermaidLine(err);
      i.bodyLine = relativeLine ? fence.line + relativeLine - 1 : fence.line;
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
      `'mermaid.lang' in '${path}' must be a string or an array of strings`,
      "template-schema-invalid",
    ));
  }
  if (Array.isArray(param.lang)) {
    for (const [idx, value] of param.lang.entries()) {
      if (typeof value !== "string" || !value.trim()) {
        issues.push(issue(
          "error",
          path,
          `'mermaid.lang[${idx}]' in '${path}' must be a non-empty string`,
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
        `'mermaid.${key}' in '${path}' must be a number`,
        "template-schema-invalid",
      ));
    }
  }
}

export const mermaidPrimitive = {
  name: "mermaid",
  async: true,
  ruleType: "object",
  innerKeys: MERMAID_INNER_KEYS,
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
