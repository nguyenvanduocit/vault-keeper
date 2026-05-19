/**
 * Load and normalize `validation_rules` from a template's frontmatter.
 *
 * Templates are markdown files under `templates/` whose frontmatter MAY
 * include a block like:
 *
 *   validation_rules:
 *     required_fields: [string, ...]
 *     conditional_required_fields:
 *       - condition: "<DSL>"           # see lib/conditional-eval.js
 *         field: "<dot.path>"
 *         required: true               # OR
 *         min_count: <int>
 *     optional_fields: [string, ...]
 *     field_rules:
 *       - field: "<dot.path>"
 *         regex: "<regex>"             # OR
 *         values: [...]                # enum
 *         type: "integer"              # type tag
 *         min: <int>                   # numeric bound
 *     state_machine:
 *       <state>: [<allowed-next-states>]
 *
 * `loadTemplateRules(templatePath)` returns null when:
 *   - templatePath is empty/null
 *   - the file does not exist
 *   - the frontmatter is malformed YAML
 *   - the file has no `validation_rules` block
 *
 * Callers MUST treat a null return as a hard error. Every vault document
 * declares `template:` in frontmatter and every template under templates/
 * declares its own validation_rules block — there is no fallback. If
 * loadTemplateRules returns null, the document cannot be validated against
 * a schema and the validator should emit an actionable error.
 */

import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import matter from "gray-matter";
import { parseSectionRules, getRequiredSections } from "./template-section-rules.js";

export async function loadTemplateRules(templatePath, projectRoot = process.cwd()) {
  if (!templatePath) return null;

  const absPath = isAbsolute(templatePath)
    ? templatePath
    : join(projectRoot, templatePath);

  let content;
  try {
    content = await readFile(absPath, "utf-8");
  } catch {
    return null;
  }

  let frontmatter, body;
  try {
    const parsed = matter(content);
    frontmatter = parsed.data;
    body = parsed.content || "";
  } catch {
    return null;
  }

  if (!frontmatter || !frontmatter.validation_rules) return null;

  const rules = normalizeRules(frontmatter.validation_rules, templatePath);

  // Body section-rules code fences are the source of truth for per-section
  // requirements. Legacy frontmatter fields `required_body_sections` and
  // `required_gherkin_section` have been migrated to body section-rules.
  // Union body-derived list with any frontmatter list still present (templates
  // not yet migrated keep working).
  const sectionRules = parseSectionRules(body);
  if (Object.keys(sectionRules).length > 0) {
    const bodyRequired = getRequiredSections(sectionRules);
    const fmRequired = Array.isArray(rules.required_body_sections)
      ? rules.required_body_sections
      : [];
    rules.required_body_sections = [...new Set([...fmRequired, ...bodyRequired])];

    if (!rules.required_gherkin_section) {
      for (const [key, srules] of Object.entries(sectionRules)) {
        if (srules?.gherkin === true) {
          rules.required_gherkin_section =
            "## " +
            key
              .split("_")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" ");
          break;
        }
      }
    }

    // allowed_roles: body section-rules (## Contributions) is primary,
    // frontmatter validation_rules.allowed_roles is legacy fallback.
    const bodyRoles = sectionRules?.contributions?.allowed_roles;
    if (Array.isArray(bodyRoles) && bodyRoles.length > 0) {
      rules.allowed_roles = bodyRoles.map((p) => ({ ...p }));
    }
  }

  return rules;
}

/**
 * Pure transformation. Defensive-copies all collections so callers cannot
 * mutate the cached rules object back into the template's frontmatter.
 */
export function normalizeRules(rules, source = "inline") {
  const r = rules || {};
  return {
    // Single regex string declared by the template; null when the template
    // opts out (validator then skips the folder-placement check).
    allowed_folders: typeof r.allowed_folders === "string" ? r.allowed_folders : null,
    // Body section format hints: format strings, examples, valid enums, table
    // headers. Consumed by body-parser to generate actionable warning messages.
    // Deep-copied so callers cannot mutate the template's canonical hints.
    body_section_formats: r.body_section_formats
      ? structuredClone(r.body_section_formats)
      : {},
    // Template-driven Vocab (Commit 2). The template inlines its own tier,
    // role registry, and body sections vocabulary. No central vocab/.
    tier: typeof r.tier === "string" ? r.tier : null,
    allowed_roles: Array.isArray(r.allowed_roles)
      ? r.allowed_roles.map((p) => ({ ...p }))
      : [],
    sections: Array.isArray(r.sections) ? [...r.sections] : [],
    required_fields: Array.isArray(r.required_fields) ? [...r.required_fields] : [],
    conditional_required_fields: Array.isArray(r.conditional_required_fields)
      ? r.conditional_required_fields.map((entry) => ({ ...entry }))
      : [],
    optional_fields: Array.isArray(r.optional_fields) ? [...r.optional_fields] : [],
    field_rules: Array.isArray(r.field_rules)
      ? r.field_rules.map((entry) => ({ ...entry }))
      : [],
    state_machine: r.state_machine
      ? Object.fromEntries(
          Object.entries(r.state_machine).map(([k, v]) => [
            k,
            Array.isArray(v) ? [...v] : [],
          ]),
        )
      : null,
    // Legacy frontmatter fields. Migrated to body section-rules; carried
    // through normalizeRules untouched so loadTemplateRules can union them
    // with body-derived values during the transition window.
    required_body_sections: Array.isArray(r.required_body_sections)
      ? [...r.required_body_sections]
      : [],
    required_gherkin_section:
      typeof r.required_gherkin_section === "string" ? r.required_gherkin_section : null,
    __source: source,
  };
}
