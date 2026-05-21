/**
 * vocab-drift.js — fuzzy clusters of tags + wiki-link targets.
 *
 * Detects when the same concept is referenced by near-duplicate strings
 * (`#book` / `#books`, `[[Atomic Habits]]` / `[[atomic-habits]]`).
 * Distance: case-insensitive Damerau-Levenshtein, normalized by max length.
 * Threshold defaults to 0.2 — strings closer than that cluster together.
 *
 * Pure function. Inputs are already-parsed documents.
 */

const WIKI_LINK_RE = /\[\[([^\]]+?)\]\]/g;

/**
 * @param {Array<{frontmatter, body}>} docs
 * @param {{distance_threshold: number}} cfg
 */
export function measureVocabDrift(docs, cfg) {
  const threshold = cfg.distance_threshold;

  const tagUses = new Map();
  for (const d of docs) {
    const tags = d.frontmatter?.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      tagUses.set(tag, (tagUses.get(tag) ?? 0) + 1);
    }
  }

  const linkUses = new Map();
  for (const d of docs) {
    if (typeof d.body !== 'string') continue;
    WIKI_LINK_RE.lastIndex = 0;
    let m;
    while ((m = WIKI_LINK_RE.exec(d.body)) !== null) {
      const target = m[1].trim();
      linkUses.set(target, (linkUses.get(target) ?? 0) + 1);
    }
  }

  const tag_clusters = clusterTerms(tagUses, threshold);
  const link_clusters = clusterTerms(linkUses, threshold);

  const totalUnique = tagUses.size + linkUses.size;
  const totalFragmentation =
    sum(tag_clusters.map((c) => c.fragmentation)) +
    sum(link_clusters.map((c) => c.fragmentation));
  const drift_score = totalUnique === 0 ? 0 : totalFragmentation / totalUnique;

  return { tag_clusters, link_clusters, drift_score };
}

function clusterTerms(termCounts, threshold) {
  const terms = [...termCounts.keys()];
  const parent = new Map(terms.map((t) => [t, t]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < terms.length; i++) {
    for (let j = i + 1; j < terms.length; j++) {
      const d = normalizedDistance(terms[i].toLowerCase(), terms[j].toLowerCase());
      if (d <= threshold) union(terms[i], terms[j]);
    }
  }

  const groups = new Map();
  for (const t of terms) {
    const root = find(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }

  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let canonical = members[0];
    let bestUses = termCounts.get(canonical);
    for (const m of members) {
      if (termCounts.get(m) > bestUses) {
        canonical = m;
        bestUses = termCounts.get(m);
      }
    }
    const total_uses = sum(members.map((m) => termCounts.get(m)));
    clusters.push({
      members,
      canonical,
      total_uses,
      fragmentation: members.length - 1,
    });
  }
  return clusters;
}

/**
 * Normalized Damerau-Levenshtein distance, range [0, 1].
 * 0 = identical; 1 = entirely different.
 */
export function normalizedDistance(a, b) {
  if (a === b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  const dist = damerauLevenshtein(a, b);
  return dist / maxLen;
}

function damerauLevenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
