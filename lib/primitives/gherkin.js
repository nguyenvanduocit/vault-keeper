/**
 * `gherkin` primitive — validates Gherkin fenced code blocks in a section.
 *
 * Uses Cucumber's parser so templates can require real `.feature` syntax
 * inside markdown code fences.
 *
 * The Cucumber parser packages are loaded lazily — only the first time a
 * section actually has a Gherkin fence to parse — so vaults that never use
 * this primitive never pay the import cost.
 */

import { issue } from "../helpers/issue.js";
import {
  fenceSelect,
  configuredLangs,
  matchesLang,
  checkFenceCardinality,
  validateFenceLangConfig,
} from "../helpers/fence.js";

export const GHERKIN_INNER_KEYS = new Set(["lang", "min", "max", "defaultDialect"]);

const DEFAULT_LANGS = ["gherkin", "feature"];

let gherkinPromise;
function loadGherkin() {
  if (!gherkinPromise) {
    gherkinPromise = Promise.all([
      import("@cucumber/gherkin"),
      import("@cucumber/messages"),
    ]).then(([gherkin, messages]) => ({
      generateMessages: gherkin.generateMessages,
      IdGenerator: messages.IdGenerator,
      SourceMediaType: messages.SourceMediaType,
    }));
  }
  return gherkinPromise;
}

async function validate(fences, param = {}, ctx) {
  const level = ctx.severity || "error";
  const field = ctx.field;
  const allFences = Array.isArray(fences) ? fences : [];
  const langs = configuredLangs(param, DEFAULT_LANGS);
  const filtered = allFences.filter((fence) => matchesLang(fence, langs));

  const issues = checkFenceCardinality(filtered, param, ctx, {
    langs,
    multiLangNoun: "Gherkin",
    missingType: "gherkin-missing",
    cardinalityType: "gherkin-cardinality",
  });

  if (filtered.length === 0) return issues;

  const { generateMessages, IdGenerator, SourceMediaType } = await loadGherkin();
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
  validateFenceLangConfig(param, path, "gherkin", issues);
  if (param.defaultDialect !== undefined && typeof param.defaultDialect !== "string") {
    issues.push(issue(
      "error",
      path,
      `'gherkin.defaultDialect' in '${path}' must be a string`,
      "template-schema-invalid",
    ));
  }
}

export const gherkinPrimitive = {
  name: "gherkin",
  ruleType: "object",
  innerKeys: GHERKIN_INNER_KEYS,
  select: fenceSelect,
  validate,
  validateConfig,
};
