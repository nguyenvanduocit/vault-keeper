import { describe, test, expect } from 'bun:test';
import { measureSchemaDrift } from '../../lib/entropy/schema-drift.js';

const enumTemplate = {
  path: 'templates/book-template.md',
  fields: {
    status: { type: 'string', enum: ['reading', 'done', 'abandoned'] },
    rating: { type: 'integer', required: false },
    title:  { type: 'string', required: true },
  },
};

const doc = (frontmatter, template = 'templates/book-template.md') => ({
  filepath: '/x/book.md',
  template,
  frontmatter,
});

describe('measureSchemaDrift', () => {
  test('all docs match enum → drift 0 for that field', () => {
    const out = measureSchemaDrift(
      [doc({ status: 'reading', title: 'A' }), doc({ status: 'done', title: 'B' })],
      [enumTemplate],
    );
    expect(out.perTemplate['templates/book-template.md'].fields.status.drift_score).toBe(0);
    expect(out.global_drift_score).toBe(0);
  });

  test('case drift outside enum → drift > 0 and orphan_values populated', () => {
    const out = measureSchemaDrift(
      [
        doc({ status: 'reading', title: 'A' }),
        doc({ status: 'WIP', title: 'B' }),
        doc({ status: 'wip', title: 'C' }),
      ],
      [enumTemplate],
    );
    const f = out.perTemplate['templates/book-template.md'].fields.status;
    expect(f.drift_score).toBeCloseTo(2 / 3, 5);
    expect(f.orphan_values.sort()).toEqual(['WIP', 'wip']);
  });

  test('missing required field penalized as drift 1.0 absent rate', () => {
    const out = measureSchemaDrift(
      [doc({ status: 'reading' }), doc({ status: 'done' })],
      [enumTemplate],
    );
    const f = out.perTemplate['templates/book-template.md'].fields.title;
    expect(f.drift_score).toBe(1);
  });

  test('template with zero docs is skipped (no NaN)', () => {
    const out = measureSchemaDrift([], [enumTemplate]);
    expect(out.global_drift_score).toBe(0);
    expect(out.perTemplate['templates/book-template.md']).toBeUndefined();
  });

  test('docs without resolved template are skipped silently', () => {
    const out = measureSchemaDrift(
      [doc({ status: 'reading' }, null)],
      [enumTemplate],
    );
    expect(out.global_drift_score).toBe(0);
  });

  test('Shannon entropy norm computed when ≥2 unique values', () => {
    const out = measureSchemaDrift(
      [
        doc({ status: 'reading', title: 'A' }),
        doc({ status: 'reading', title: 'B' }),
        doc({ status: 'done', title: 'C' }),
        doc({ status: 'done', title: 'D' }),
      ],
      [enumTemplate],
    );
    expect(out.perTemplate['templates/book-template.md'].fields.status.entropy_norm).toBeCloseTo(1, 5);
  });
});
