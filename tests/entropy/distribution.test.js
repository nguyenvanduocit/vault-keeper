import { describe, test, expect } from 'bun:test';
import { measureDistribution, gini } from '../../lib/entropy/distribution.js';

const doc = (template, fm = { a: 1, b: 2 }, folder = 'notes') => ({
  filepath: `/v/${folder}/${Math.random()}.md`,
  template,
  folder,
  frontmatter: fm,
});

describe('gini', () => {
  test('uniform distribution → 0', () => {
    expect(gini([1, 1, 1, 1])).toBeCloseTo(0, 5);
  });
  test('all in one bucket → close to 1 (n-1)/n', () => {
    expect(gini([4, 0, 0, 0])).toBeCloseTo(0.75, 2);
  });
  test('empty → null', () => {
    expect(gini([])).toBe(null);
  });
});

describe('measureDistribution', () => {
  test('template usage counts + gini', () => {
    const docs = [
      ...Array.from({ length: 20 }, () => doc('templates/daily.md')),
      ...Array.from({ length: 5 }, () => doc('templates/book.md')),
    ];
    const out = measureDistribution(docs);
    expect(out.template_usage.counts['templates/daily.md']).toBe(20);
    expect(out.template_usage.counts['templates/book.md']).toBe(5);
    expect(out.template_usage.gini).toBeGreaterThan(0);
  });

  test('untemplated count', () => {
    const docs = [doc(null), doc('templates/daily.md'), doc(null)];
    const out = measureDistribution(docs);
    expect(out.untemplated.count).toBe(2);
  });

  test('compression ratio computed', () => {
    const docs = Array.from({ length: 10 }, () => doc('templates/daily.md'));
    const out = measureDistribution(docs);
    expect(out.compression.global_ratio).toBeGreaterThan(0);
    expect(out.compression.global_ratio).toBeLessThan(1);
  });

  test('single template → gini null with verdict single_template', () => {
    const docs = Array.from({ length: 5 }, () => doc('templates/daily.md'));
    const out = measureDistribution(docs);
    expect(out.template_usage.gini).toBe(null);
    expect(out.template_usage.verdict).toBe('single_template');
  });

  test('empty corpus → safe nulls, distribution_score 0', () => {
    const out = measureDistribution([]);
    expect(out.template_usage.gini).toBe(null);
    expect(out.distribution_score).toBe(0);
  });
});
