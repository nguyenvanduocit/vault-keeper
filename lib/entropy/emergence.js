/**
 * emergence.js — detect repeated patterns OUTSIDE the template schema.
 *
 * Inputs (pure):
 *   - docs: Array<{filepath, template, frontmatter, body_headings}>
 *           body_headings is an Array<string> of H2 heading texts in the
 *           document body (caller responsibility to extract).
 *   - templates: Array<{path, fields, sections}>
 *   - cfg: { candidate_threshold, min_template_docs }
 *
 * A field/section is a candidate when:
 *   - it is not declared in the template, AND
 *   - it appears in > candidate_threshold of that template's docs, AND
 *   - the template has ≥ min_template_docs documents.
 *
 * Templates with too few docs are listed in `skipped[]` so the report can
 * surface "I cannot tell yet".
 */

export function measureEmergence(docs, templates, cfg) {
  const byTemplate = new Map();
  for (const t of templates) byTemplate.set(t.path, t);

  const docsByTemplate = new Map();
  for (const d of docs) {
    if (!d.template || !byTemplate.has(d.template)) continue;
    if (!docsByTemplate.has(d.template)) docsByTemplate.set(d.template, []);
    docsByTemplate.get(d.template).push(d);
  }

  const field_candidates = [];
  const section_candidates = [];
  const skipped = [];

  for (const [templatePath, ds] of docsByTemplate) {
    if (ds.length < cfg.min_template_docs) {
      skipped.push(templatePath);
      continue;
    }
    const template = byTemplate.get(templatePath);
    const declaredFields = new Set(Object.keys(template.fields ?? {}));
    const declaredSections = new Set(template.sections ?? []);

    const fieldStats = new Map();
    for (const d of ds) {
      for (const [k, v] of Object.entries(d.frontmatter ?? {})) {
        if (declaredFields.has(k)) continue;
        if (v === null || v === undefined || v === '') continue;
        if (!fieldStats.has(k)) fieldStats.set(k, { count: 0, values: new Map() });
        const s = fieldStats.get(k);
        s.count++;
        const key = String(v);
        s.values.set(key, (s.values.get(key) ?? 0) + 1);
      }
    }
    for (const [fieldName, s] of fieldStats) {
      const ratio = s.count / ds.length;
      if (ratio <= cfg.candidate_threshold) continue;
      const uniqueRatio = s.values.size / s.count;
      const suggested_primitive = uniqueRatio < 0.5 ? 'enum' : 'string';
      const value_samples = [...s.values.keys()].slice(0, 10);
      field_candidates.push({
        template: templatePath,
        field: fieldName,
        appearances: s.count,
        total_docs: ds.length,
        value_samples,
        promote_confidence: ratio,
        suggested_primitive,
      });
    }

    const headingStats = new Map();
    for (const d of ds) {
      for (const h of d.body_headings ?? []) {
        if (declaredSections.has(h)) continue;
        headingStats.set(h, (headingStats.get(h) ?? 0) + 1);
      }
    }
    for (const [heading, count] of headingStats) {
      const ratio = count / ds.length;
      if (ratio <= cfg.candidate_threshold) continue;
      section_candidates.push({
        template: templatePath,
        heading,
        appearances: count,
        total_docs: ds.length,
        promote_confidence: ratio,
      });
    }
  }

  return { field_candidates, section_candidates, skipped };
}
