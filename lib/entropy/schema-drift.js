/**
 * schema-drift.js — Frontmatter shape variance per template.
 *
 * For each template, for each declared field, computes:
 *   - drift_score (0–1)  → 1 means the field is completely broken in this corpus
 *   - orphan_values[]    → enum values not in F.enum (e.g. "WIP" when allowed
 *                          is [reading, done, abandoned])
 *   - entropy_norm       → Shannon entropy normalized by log2(unique_count)
 *                          (informational; not folded into score)
 *
 * Pure function. No I/O. No template loading. Caller passes already-parsed
 * docs and templates.
 */

/**
 * @param {Array<{filepath, template, frontmatter}>} docs
 * @param {Array<{path, fields}>} templates
 * @returns {{perTemplate, global_drift_score}}
 */
export function measureSchemaDrift(docs, templates) {
  const byTemplate = new Map();
  for (const t of templates) byTemplate.set(t.path, t);

  /** template path → doc[] */
  const docsByTemplate = new Map();
  for (const d of docs) {
    if (!d.template) continue;
    if (!byTemplate.has(d.template)) continue;
    if (!docsByTemplate.has(d.template)) docsByTemplate.set(d.template, []);
    docsByTemplate.get(d.template).push(d);
  }

  const perTemplate = {};
  let driftSum = 0;
  let driftCount = 0;

  for (const [templatePath, templateDocs] of docsByTemplate) {
    if (templateDocs.length === 0) continue;
    const template = byTemplate.get(templatePath);
    const fields = template.fields ?? {};
    perTemplate[templatePath] = { fields: {} };

    for (const [fieldName, spec] of Object.entries(fields)) {
      const valueCounts = new Map();
      let presentCount = 0;
      for (const d of templateDocs) {
        const v = d.frontmatter?.[fieldName];
        if (v === undefined || v === null || v === '') continue;
        presentCount++;
        const key = String(v);
        valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
      }
      const total = templateDocs.length;

      let drift_score;
      let orphan_values = [];
      if (Array.isArray(spec.enum) && spec.enum.length > 0) {
        const enumSet = new Set(spec.enum.map(String));
        let invalid = 0;
        for (const [val, count] of valueCounts) {
          if (!enumSet.has(val)) {
            invalid += count;
            orphan_values.push(val);
          }
        }
        drift_score = total === 0 ? 0 : invalid / total;
      } else if (spec.required === true) {
        drift_score = total === 0 ? 0 : 1 - presentCount / total;
      } else {
        const typeCounts = new Map();
        for (const d of templateDocs) {
          const v = d.frontmatter?.[fieldName];
          if (v === undefined || v === null || v === '') continue;
          const t = Array.isArray(v) ? 'array' : typeof v;
          typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
        }
        if (presentCount <= 1) {
          drift_score = 0;
        } else {
          const dominant = Math.max(...typeCounts.values());
          drift_score = 1 - dominant / presentCount;
        }
      }

      let entropy_norm = null;
      if (valueCounts.size >= 2) {
        let H = 0;
        for (const c of valueCounts.values()) {
          const p = c / presentCount;
          H -= p * Math.log2(p);
        }
        entropy_norm = H / Math.log2(valueCounts.size);
      }

      perTemplate[templatePath].fields[fieldName] = {
        expected: describeSpec(spec),
        value_distribution: Object.fromEntries(valueCounts),
        drift_score,
        orphan_values,
        entropy_norm,
      };
      driftSum += drift_score;
      driftCount++;
    }
  }

  const global_drift_score = driftCount === 0 ? 0 : driftSum / driftCount;
  return { perTemplate, global_drift_score };
}

function describeSpec(spec) {
  if (Array.isArray(spec.enum)) return `enum[${spec.enum.join(',')}]`;
  if (spec.required) return `${spec.type ?? 'any'} (required)`;
  return spec.type ?? 'any';
}
