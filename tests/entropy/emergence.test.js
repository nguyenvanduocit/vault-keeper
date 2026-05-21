import { describe, test, expect } from 'bun:test';
import { measureEmergence } from '../../lib/entropy/emergence.js';

const template = {
  path: 'templates/daily-note.md',
  fields: { date: { type: 'date' }, title: { type: 'string' } },
  sections: ['Reflections', 'Tasks'],
};

const doc = (fm, headings = []) => ({
  filepath: '/x.md',
  template: 'templates/daily-note.md',
  frontmatter: fm,
  body_headings: headings,
});

const cfg = { candidate_threshold: 0.30, min_template_docs: 10 };

describe('measureEmergence — field candidates', () => {
  test('field appearing in > threshold of docs is a candidate', () => {
    const docs = Array.from({ length: 30 }, () => doc({ date: '2026-05-21', mood: 'happy' }));
    docs.push(...Array.from({ length: 15 }, () => doc({ date: '2026-05-21' })));
    const out = measureEmergence(docs, [template], cfg);
    const c = out.field_candidates.find((c) => c.field === 'mood');
    expect(c).toBeDefined();
    expect(c.appearances).toBe(30);
    expect(c.total_docs).toBe(45);
    expect(c.promote_confidence).toBeCloseTo(30 / 45, 5);
  });

  test('below threshold → no candidate', () => {
    const docs = [
      ...Array.from({ length: 2 }, () => doc({ date: '2026-05-21', mood: 'happy' })),
      ...Array.from({ length: 10 }, () => doc({ date: '2026-05-21' })),
    ];
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates.length).toBe(0);
  });

  test('template with < min_template_docs is skipped', () => {
    const docs = Array.from({ length: 5 }, () => doc({ date: '2026-05-21', mood: 'happy' }));
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates.length).toBe(0);
    expect(out.skipped).toContain('templates/daily-note.md');
  });

  test('suggested_primitive: enum for low-cardinality values', () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc({
      date: '2026-05-21',
      mood: i % 2 === 0 ? 'happy' : 'tired',
    }));
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates[0].suggested_primitive).toBe('enum');
    expect(out.field_candidates[0].value_samples.sort()).toEqual(['happy', 'tired']);
  });

  test('suggested_primitive: string for scattered values', () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc({
      date: '2026-05-21',
      note: `unique-${i}`,
    }));
    const out = measureEmergence(docs, [template], cfg);
    expect(out.field_candidates[0].suggested_primitive).toBe('string');
  });
});

describe('measureEmergence — section candidates', () => {
  test('heading appearing in > threshold of docs is a candidate', () => {
    const docs = [
      ...Array.from({ length: 15 }, () => doc({ date: '2026-05-21' }, ['Reflections', 'Key Quotes'])),
      ...Array.from({ length: 5 }, () => doc({ date: '2026-05-21' }, ['Reflections'])),
    ];
    const out = measureEmergence(docs, [template], cfg);
    const c = out.section_candidates.find((c) => c.heading === 'Key Quotes');
    expect(c).toBeDefined();
    expect(c.appearances).toBe(15);
  });
});
