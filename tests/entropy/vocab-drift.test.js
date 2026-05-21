import { describe, test, expect } from 'bun:test';
import { measureVocabDrift, normalizedDistance } from '../../lib/entropy/vocab-drift.js';

const doc = (fm, body = '') => ({ filepath: '/x.md', frontmatter: fm, body });

describe('normalizedDistance', () => {
  test('identical strings → 0', () => {
    expect(normalizedDistance('book', 'book')).toBe(0);
  });
  test('one-char substitution on length-4 string → 0.25', () => {
    expect(normalizedDistance('book', 'boos')).toBeCloseTo(0.25, 5);
  });
  test('adjacent transposition counted as single edit', () => {
    expect(normalizedDistance('book', 'boko')).toBeCloseTo(1 / 4, 5);
  });
});

describe('measureVocabDrift — tags', () => {
  test('singular/plural cluster at threshold 0.2', () => {
    const docs = [
      doc({ tags: ['book'] }),
      doc({ tags: ['book'] }),
      doc({ tags: ['books'] }),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    const cluster = out.tag_clusters.find((c) => c.members.includes('book'));
    expect(cluster.members.sort()).toEqual(['book', 'books']);
    expect(cluster.canonical).toBe('book');
    expect(cluster.total_uses).toBe(3);
    expect(cluster.fragmentation).toBe(1);
  });

  test('no clustering above threshold', () => {
    const docs = [doc({ tags: ['book'] }), doc({ tags: ['movie'] })];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(0);
  });

  test('case-insensitive collapse', () => {
    const docs = [doc({ tags: ['Book'] }), doc({ tags: ['BOOK'] }), doc({ tags: ['book'] })];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    const cluster = out.tag_clusters[0];
    expect(cluster.members.length).toBe(3);
  });

  test('empty vault → no clusters, drift_score 0', () => {
    const out = measureVocabDrift([], { distance_threshold: 0.2 });
    expect(out.tag_clusters).toEqual([]);
    expect(out.drift_score).toBe(0);
  });
});

describe('measureVocabDrift — wiki-links', () => {
  test('extracts wiki-link refs from body and clusters them', () => {
    const docs = [
      doc({}, 'See [[Atomic Habits]] for details.'),
      doc({}, 'Cf. [[atomic-habits]].'),
      doc({}, '[[Atomic Habits]]'),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.link_clusters.length).toBe(1);
    expect(out.link_clusters[0].members.length).toBe(2);
  });
});

describe('measureVocabDrift — drift_score', () => {
  test('fragmentation / unique_terms', () => {
    const docs = [
      doc({ tags: ['book'] }),
      doc({ tags: ['books'] }),
      doc({ tags: ['movie'] }),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.drift_score).toBeCloseTo(1 / 3, 5);
  });
});
