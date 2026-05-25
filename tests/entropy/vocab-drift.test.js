import { describe, test, expect } from 'bun:test';
import { measureVocabDrift, normalizedDistance } from '../../lib/entropy/vocab-drift.js';

const doc = (fm, body = '') => ({ filepath: '/x.md', frontmatter: fm, body });
const tagDoc = (tag) => doc({ tags: [tag] });

describe('normalizedDistance', () => {
  test('identical strings → 0', () => {
    expect(normalizedDistance('book', 'book')).toBe(0);
  });
  test('one-char substitution on length-4 string → 0.25', () => {
    expect(normalizedDistance('book', 'boos')).toBeCloseTo(0.25, 5);
  });
  test('transposition counts as two plain-Levenshtein edits → 0.5', () => {
    // No Damerau transposition shortcut: boko↔book is delete+insert = 2 edits.
    // Advisory layer only — being slightly more conservative is fine.
    expect(normalizedDistance('book', 'boko')).toBeCloseTo(0.5, 5);
  });
});

describe('measureVocabDrift — tag_clusters (decidable: case/unicode collapse)', () => {
  test('case-only variants collapse, canonical = most-used', () => {
    const docs = [tagDoc('olap'), tagDoc('olap'), tagDoc('olap'), tagDoc('olap'), tagDoc('OLAP')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(1);
    const c = out.tag_clusters[0];
    expect(c.members.sort()).toEqual(['OLAP', 'olap']);
    expect(c.canonical).toBe('olap');
    expect(c.total_uses).toBe(5);
    expect(c.fragmentation).toBe(1);
  });

  test('three-way case collapse → single cluster', () => {
    const docs = [tagDoc('MongoDB'), tagDoc('mongodb'), tagDoc('MONGODB')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(1);
    expect(out.tag_clusters[0].members.length).toBe(3);
  });

  test('NFKC unicode normalization: fullwidth vs ascii collapse', () => {
    // U+FF2F.. fullwidth "ＯＬＡＰ" normalizes (NFKC) to ascii "OLAP", then lowercases.
    const docs = [tagDoc('OLAP'), tagDoc('ＯＬＡＰ')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(1);
    expect(out.tag_clusters[0].members.sort()).toEqual(['OLAP', 'ＯＬＡＰ'].sort());
    expect(out.tag_clusters[0].canonical).toBe('OLAP'); // tie on count → shorter (equal) → lexicographically first
  });

  test('distinct identifiers NEVER collapse (different canonical keys)', () => {
    const docs = [tagDoc('jira:prin-37'), tagDoc('jira:prin-39')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(0);
  });

  test('plural does NOT collapse (no stemming in decidable core)', () => {
    const docs = [tagDoc('persona'), tagDoc('personas')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(0);
  });

  test('empty vault → no clusters, drift_score 0', () => {
    const out = measureVocabDrift([], { distance_threshold: 0.2 });
    expect(out.tag_clusters).toEqual([]);
    expect(out.link_clusters).toEqual([]);
    expect(out.drift_score).toBe(0);
  });
});

describe('measureVocabDrift — link_clusters (decidable)', () => {
  test('case-only wiki-link variants collapse', () => {
    const docs = [
      doc({}, 'See [[Atomic Habits]] for details.'),
      doc({}, 'Cf. [[atomic habits]].'),
      doc({}, '[[Atomic Habits]]'),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.link_clusters.length).toBe(1);
    expect(out.link_clusters[0].members.sort()).toEqual(['Atomic Habits', 'atomic habits']);
    expect(out.link_clusters[0].canonical).toBe('Atomic Habits'); // 2 uses vs 1
  });

  test('separator difference does NOT collapse (NFKC+lowercase only)', () => {
    const docs = [doc({}, '[[atomic habits]]'), doc({}, '[[atomic-habits]]')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.link_clusters.length).toBe(0);
  });
});

describe('measureVocabDrift — drift_score (redundant-use fraction, threshold-free)', () => {
  test('redundant uses / total uses', () => {
    // olap×4 + OLAP×1 collapse (redundant = 1, the non-canonical OLAP use);
    // two unrelated tags add 2 more uses. total = 4+1+1+1 = 7, redundant = 1.
    const docs = [
      tagDoc('olap'), tagDoc('olap'), tagDoc('olap'), tagDoc('olap'),
      tagDoc('OLAP'),
      tagDoc('mongodb'),
      tagDoc('starrocks'),
    ];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.drift_score).toBeCloseTo(1 / 7, 5);
  });

  test('plural/typo variants do NOT contribute to drift_score', () => {
    const docs = [tagDoc('persona'), tagDoc('personas')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.drift_score).toBe(0);
  });
});

describe('measureVocabDrift — fuzzy_suggestions (advisory, never scores)', () => {
  test('plural surfaces as a fuzzy suggestion, not a cluster', () => {
    const docs = [tagDoc('persona'), tagDoc('personas')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(out.tag_clusters.length).toBe(0);
    const grp = out.fuzzy_suggestions.tags.find((g) => g.members.includes('persona'));
    expect(grp).toBeDefined();
    expect(grp.members.sort()).toEqual(['persona', 'personas']);
    expect(grp.kind).toBe('fuzzy');
    expect(grp.canonical_hint).toBe('persona');
    expect(grp.max_pairwise_distance).toBeGreaterThan(0);
  });

  test('complete-linkage: chain a~b~c with a↔c > t does NOT form one group', () => {
    // Construct three terms where consecutive pairs are within threshold but
    // the extremes are not, so single-linkage WOULD merge all three but
    // complete-linkage must not. Use a generous threshold to make the chain.
    // 'abcde' ↔ 'abcdX' = 1/5 = 0.2 (≤ t); 'abcdX' ↔ 'abYZX' = 2/5 = 0.4 (> t);
    // 'abcde' ↔ 'abYZX' = 3/5 = 0.6 (> t).
    const docs = [tagDoc('abcde'), tagDoc('abcdx'), tagDoc('abyzx')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    // No group may contain all three.
    for (const g of out.fuzzy_suggestions.tags) {
      expect(g.members.length).toBeLessThan(3);
    }
  });

  test('distinct identifiers above threshold are NOT a fuzzy monster cluster', () => {
    // 20 jira tickets like the real-vault TPGH family: pairwise distances vary
    // and the extremes exceed threshold, so complete-linkage forbids one
    // 20-member cluster.
    const ids = [];
    for (let i = 1300; i <= 1410; i += 6) ids.push(`jira:tpgh-${i}`);
    const docs = ids.map(tagDoc);
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    for (const g of out.fuzzy_suggestions.tags) {
      // No single group should swallow the whole family.
      expect(g.members.length).toBeLessThan(ids.length);
    }
  });

  test('every pair within a fuzzy group is ≤ threshold (complete-linkage invariant)', () => {
    const docs = [tagDoc('persona'), tagDoc('personas'), tagDoc('personaz')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    for (const g of out.fuzzy_suggestions.tags) {
      expect(g.max_pairwise_distance).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });
});

describe('measureVocabDrift — ignore (config-driven out-of-scope references)', () => {
  const findFuzzy = (groups, term) => groups.find((g) => g.members.includes(term));

  test('default (ignore absent): machine-id tag IS present in analysis', () => {
    // jira:prin-37 + jira:prin-39 are distinct identifiers — they do not
    // collapse, but WITHOUT ignore they still appear in fuzzy_suggestions
    // (lexically close) and count toward the drift_score denominator.
    const docs = [tagDoc('jira:prin-37'), tagDoc('jira:prin-39')];
    const out = measureVocabDrift(docs, { distance_threshold: 0.2 });
    expect(findFuzzy(out.fuzzy_suggestions.tags, 'jira:prin-37')).toBeDefined();
  });

  test('ignore=[] is identical to omitting ignore', () => {
    const docs = [tagDoc('jira:prin-37'), tagDoc('jira:prin-39')];
    const a = measureVocabDrift(docs, { distance_threshold: 0.2 });
    const b = measureVocabDrift(docs, { distance_threshold: 0.2, ignore: [] });
    expect(b).toEqual(a);
  });

  test('ignored tags contribute ZERO: clusters, fuzzy, and drift_score denominator', () => {
    // 4 ignored machine-id tags + a real case-collapse pair (olap/OLAP).
    // After ignoring jira:* / imported:*, only the olap pair remains:
    // drift_score = redundant(1) / total(2) = 0.5 — i.e. the denominator
    // reflects ONLY the surviving vocabulary, not the ignored tags.
    const docs = [
      tagDoc('jira:prin-37'),
      tagDoc('jira:prin-39'),
      tagDoc('imported:2026-05-20'),
      tagDoc('olap'),
      tagDoc('OLAP'),
    ];
    const out = measureVocabDrift(docs, {
      distance_threshold: 0.2,
      ignore: ['jira:*', 'imported:*'],
    });
    // Not in clusters.
    const allClusterMembers = out.tag_clusters.flatMap((c) => c.members);
    expect(allClusterMembers).not.toContain('jira:prin-37');
    expect(allClusterMembers).not.toContain('jira:prin-39');
    expect(allClusterMembers).not.toContain('imported:2026-05-20');
    // Not in fuzzy_suggestions.
    const allFuzzyMembers = out.fuzzy_suggestions.tags.flatMap((g) => g.members);
    expect(allFuzzyMembers).not.toContain('jira:prin-37');
    expect(allFuzzyMembers).not.toContain('jira:prin-39');
    expect(allFuzzyMembers).not.toContain('imported:2026-05-20');
    // drift_score denominator excludes ignored tags: only olap(1)+OLAP(1) = 2 uses.
    expect(out.drift_score).toBeCloseTo(1 / 2, 5);
    // The real collapse pair survives.
    expect(out.tag_clusters.length).toBe(1);
    expect(out.tag_clusters[0].members.sort()).toEqual(['OLAP', 'olap']);
  });

  test('non-ignored real variants survive: persona/personas fuzzy, olap/OLAP collapse', () => {
    const docs = [
      tagDoc('jira:prin-37'),
      tagDoc('persona'),
      tagDoc('personas'),
      tagDoc('olap'),
      tagDoc('OLAP'),
    ];
    const out = measureVocabDrift(docs, {
      distance_threshold: 0.2,
      ignore: ['jira:*'],
    });
    // persona/personas still in fuzzy_suggestions.
    const grp = findFuzzy(out.fuzzy_suggestions.tags, 'persona');
    expect(grp).toBeDefined();
    expect(grp.members.sort()).toEqual(['persona', 'personas']);
    // olap/OLAP still collapses in tag_clusters.
    const olapCluster = out.tag_clusters.find((c) => c.members.includes('olap'));
    expect(olapCluster).toBeDefined();
    expect(olapCluster.members.sort()).toEqual(['OLAP', 'olap']);
  });

  test('ignored wiki-link target excluded from link_clusters and link fuzzy', () => {
    // confluence:* links are out of scope; a real case-collapse link survives.
    const docs = [
      doc({}, 'Ref [[confluence:3864010645]] and [[confluence:3864010646]].'),
      doc({}, 'See [[Atomic Habits]].'),
      doc({}, '[[atomic habits]] again.'),
      doc({}, '[[Atomic Habits]]'),
    ];
    const out = measureVocabDrift(docs, {
      distance_threshold: 0.2,
      ignore: ['confluence:*'],
    });
    const allLinkClusterMembers = out.link_clusters.flatMap((c) => c.members);
    expect(allLinkClusterMembers).not.toContain('confluence:3864010645');
    const allLinkFuzzyMembers = out.fuzzy_suggestions.links.flatMap((g) => g.members);
    expect(allLinkFuzzyMembers).not.toContain('confluence:3864010645');
    expect(allLinkFuzzyMembers).not.toContain('confluence:3864010646');
    // Real link pair still collapses.
    const ahCluster = out.link_clusters.find((c) => c.members.includes('Atomic Habits'));
    expect(ahCluster).toBeDefined();
    expect(ahCluster.members.sort()).toEqual(['Atomic Habits', 'atomic habits']);
  });
});
