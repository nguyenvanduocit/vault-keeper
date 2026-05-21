/**
 * `mermaid` primitive — validates Mermaid fenced code blocks in a section.
 *
 * Uses Mermaid's own parser so common diagrams such as flowchart and sequence
 * diagrams follow Mermaid's real syntax rather than a local regex subset.
 *
 * The `mermaid` package is heavy (~225ms + ~37MB RSS at import). It is
 * therefore loaded lazily — only the first time a section actually has a
 * Mermaid fence to parse — so vaults that never use this primitive never
 * pay the cost.
 */

import { issue } from "../helpers/issue.js";
import {
  fenceSelect,
  configuredLangs,
  matchesLang,
  checkFenceCardinality,
  validateFenceLangConfig,
} from "../helpers/fence.js";

export const MERMAID_INNER_KEYS = new Set(["lang", "min", "max"]);

const DEFAULT_LANGS = ["mermaid", "mmd"];

let mermaidPromise;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: m }) => {
      m.initialize({ startOnLoad: false, securityLevel: "strict" });
      return m;
    });
  }
  return mermaidPromise;
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
  const langs = configuredLangs(param, DEFAULT_LANGS);
  const filtered = allFences.filter((fence) => matchesLang(fence, langs));

  const issues = checkFenceCardinality(filtered, param, ctx, {
    langs,
    multiLangNoun: "Mermaid",
    missingType: "mermaid-missing",
    cardinalityType: "mermaid-cardinality",
  });

  if (filtered.length === 0) return issues;

  const mermaid = await loadMermaid();
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
  validateFenceLangConfig(param, path, "mermaid", issues);
}

export const mermaidPrimitive = {
  name: "mermaid",
  ruleType: "object",
  innerKeys: MERMAID_INNER_KEYS,
  select: fenceSelect,
  validate,
  validateConfig,
};
