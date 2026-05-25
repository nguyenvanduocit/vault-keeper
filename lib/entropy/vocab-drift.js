/**
 * vocab-drift.js — vocab consistency of tags + wiki-link targets.
 *
 * Two distinct, deliberately-separated questions:
 *
 *   1. DECIDABLE ("same token, different spelling?" — case/unicode only):
 *      drives the SCORE, threshold-free, via canonical normalization.
 *      `OLAP` and `olap` are the same token; `jira:PRIN-37` and `jira:PRIN-39`
 *      are NOT (different canonical keys), so distinct identifiers are safe
 *      by construction — zero namespace knowledge required. These collapse
 *      groups are what the garden `graft` action reads, so they must be
 *      safe to find/replace.
 *
 *   2. UNDECIDABLE from strings ("same concept despite different spelling?" —
 *      typos, plural, abbreviations): demoted to ADVISORY `fuzzy_suggestions`
 *      that never affect the score and are never auto-grafted. Edit distance
 *      is a hint here, never a decision.
 *
 * canonicalize(s) = s.normalize('NFKC').toLowerCase() — NOTHING ELSE. No
 * plural-stemming, no separator-normalization: those are language-specific
 * heuristics and stay out of the decidable core (consequence: persona/personas
 * surface in fuzzy_suggestions, not tag_clusters — intended).
 *
 * Pure function. Inputs are already-parsed documents.
 */

import { minimatch } from 'minimatch';
import { levenshtein } from '../fuzzy-suggest.js';

const WIKI_LINK_RE = /\[\[([^\]]+?)\]\]/g;

/**
 * @param {Array<{frontmatter, body}>} docs
 * @param {{distance_threshold: number, ignore?: string[]}} cfg
 *   `ignore` — minimatch glob patterns matched against the raw tag value /
 *   wiki-link target. A term matching ANY pattern is excluded from ALL vocab
 *   analysis (tag_clusters, link_clusters, fuzzy_suggestions, and the
 *   drift_score denominator). Default `[]` ⇒ behavior identical to no ignore.
 * @returns {{tag_clusters, link_clusters, fuzzy_suggestions, drift_score}}
 */
export function measureVocabDrift(docs, cfg) {
  const threshold = cfg.distance_threshold;
  const ignore = Array.isArray(cfg.ignore) ? cfg.ignore : [];
  // Single point of filtering: a term enters the use-maps only if it matches
  // no ignore pattern. Everything downstream (canonical-collapse, drift_score,
  // fuzzyGroups) reads exclusively from these maps, so the filter applies once.
  const isIgnored = (term) => ignore.some((p) => minimatch(term, p, { dot: true }));

  const tagUses = new Map();
  for (const d of docs) {
    const tags = d.frontmatter?.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      if (isIgnored(tag)) continue;
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
      if (!target) continue;
      if (isIgnored(target)) continue;
      linkUses.set(target, (linkUses.get(target) ?? 0) + 1);
    }
  }
  const tag_clusters = canonicalCollapse(tagUses);
  const link_clusters = canonicalCollapse(linkUses);

  // drift_score: fraction of tag/link USES that are redundant variants.
  // A collapse group's redundant uses = total_uses − dominant_uses (the uses
  // that are NOT already in the canonical surface form). Threshold-free.
  const redundant =
    sum(tag_clusters.map((c) => redundantUses(c, tagUses))) +
    sum(link_clusters.map((c) => redundantUses(c, linkUses)));
  const totalUses =
    sum([...tagUses.values()]) + sum([...linkUses.values()]);
  const drift_score = totalUses === 0 ? 0 : redundant / totalUses;

  // fuzzy_suggestions: advisory only. Lexical near-neighbours that did NOT
  // canonical-collapse (typos, plural, abbreviations). Never feeds drift_score.
  const fuzzy_suggestions = {
    tags: fuzzyGroups(tagUses, threshold),
    links: fuzzyGroups(linkUses, threshold),
  };

  return { tag_clusters, link_clusters, fuzzy_suggestions, drift_score };
}

const canonicalize = (s) => s.normalize('NFKC').toLowerCase();

/**
 * Group surface forms of a term by their canonical key. A group with ≥2
 * DISTINCT surface forms is a collapse group (safe-to-graft: same token,
 * different spelling that differs ONLY by case/unicode).
 *
 * Cluster shape (backward-compatible with the garden skill + consumers):
 *   { members: string[], canonical: string, total_uses: number, fragmentation: number }
 * canonical = surface form with MOST uses (tie → shorter → lexicographically
 * first). fragmentation = members.length - 1.
 */
function canonicalCollapse(termCounts) {
  const byKey = new Map();
  for (const [term, count] of termCounts) {
    const key = canonicalize(term);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ term, count });
  }

  const clusters = [];
  for (const surfaces of byKey.values()) {
    if (surfaces.length < 2) continue;
    const members = surfaces.map((s) => s.term);
    const canonical = pickCanonical(surfaces);
    const total_uses = sum(surfaces.map((s) => s.count));
    clusters.push({
      members,
      canonical,
      total_uses,
      fragmentation: members.length - 1,
    });
  }
  return clusters;
}

/** Most-used surface form; tie → shorter, then lexicographically first. */
function pickCanonical(surfaces) {
  let best = surfaces[0];
  for (const s of surfaces) {
    if (
      s.count > best.count ||
      (s.count === best.count && s.term.length < best.term.length) ||
      (s.count === best.count && s.term.length === best.term.length && s.term < best.term)
    ) {
      best = s;
    }
  }
  return best.term;
}

/**
 * Uses not in the canonical surface form: total_uses − uses(canonical).
 * Per-member counts live in the original termCounts map, so it is passed in.
 */
function redundantUses(cluster, termCounts) {
  const dominant = termCounts.get(cluster.canonical) ?? 0;
  return cluster.total_uses - dominant;
}

/**
 * Complete-linkage fuzzy grouping (advisory).
 *
 * A set of terms is a fuzzy group only if EVERY pair within it is within the
 * normalized-distance threshold — no transitive single-linkage chaining, so a
 * chain a~b~c where a↔c exceeds the threshold never collapses into one monster
 * cluster. For the small term counts here, a simple greedy complete-linkage is
 * sufficient: seed a group from an unassigned term, then admit a candidate only
 * if it is within threshold of EVERY current member.
 *
 * Pairs already unified by canonical collapse are excluded (they live in the
 * decidable tag_clusters / link_clusters, not here).
 *
 * Distance reuses `levenshtein` (the repo's single source of truth for edit
 * distance), normalized by max length to stay comparable to the old threshold.
 */
function fuzzyGroups(termCounts, threshold) {
  // Map each surface form to its canonical key so we can skip same-key pairs
  // (those are decidable collapses, already reported in *_clusters).
  const keyOf = new Map();
  for (const term of termCounts.keys()) keyOf.set(term, canonicalize(term));

  const terms = [...termCounts.keys()].sort();
  const assigned = new Set();
  const groups = [];

  for (const seed of terms) {
    if (assigned.has(seed)) continue;
    const members = [seed];
    for (const cand of terms) {
      if (cand === seed || assigned.has(cand)) continue;
      // Complete-linkage: cand must be within threshold of EVERY member, and
      // must not share a canonical key with any member (that would be a
      // decidable collapse, not a fuzzy suggestion).
      let admit = true;
      for (const mem of members) {
        if (keyOf.get(cand) === keyOf.get(mem)) { admit = false; break; }
        if (normalizedDistance(canonicalize(cand), canonicalize(mem)) > threshold) {
          admit = false;
          break;
        }
      }
      if (admit) members.push(cand);
    }
    if (members.length < 2) continue;
    for (const m of members) assigned.add(m);

    // canonical_hint: most-used member (tie → shorter, lexicographically first).
    const surfaces = members.map((term) => ({ term, count: termCounts.get(term) }));
    const canonical_hint = pickCanonical(surfaces);
    const maxPair = maxPairwiseDistance(members);
    groups.push({
      members,
      canonical_hint,
      max_pairwise_distance: maxPair,
      kind: 'fuzzy',
    });
  }
  return groups;
}

function maxPairwiseDistance(members) {
  let max = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const d = normalizedDistance(canonicalize(members[i]), canonicalize(members[j]));
      if (d > max) max = d;
    }
  }
  return max;
}

/**
 * Normalized Levenshtein distance, range [0, 1]. 0 = identical, 1 = entirely
 * different. Reuses `levenshtein` from lib/fuzzy-suggest.js — one edit-distance
 * implementation for the whole repo. Transposition handling (Damerau) is NOT
 * needed: this is an advisory hint layer, and a transposed pair simply scores
 * as two edits, which only makes the fuzzy suggestion slightly more
 * conservative (never affects the score).
 */
export function normalizedDistance(a, b) {
  if (a === b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshtein(a, b) / maxLen;
}

function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
