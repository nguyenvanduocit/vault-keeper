/**
 * Fuzzy "did-you-mean" suggestion for unknown-key diagnostics.
 *
 * Pure-function helper used by every validator that rejects a key/value not
 * found in a known set. Given the offending input and the candidate set,
 * returns the closest candidate (Levenshtein distance) when one exists
 * within the cutoff, or null otherwise.
 *
 * The cutoff scales with the candidate length to keep "id" → "items" and
 * "valuess" → "values" within reach, while never proposing a clearly
 * unrelated match (e.g. "x" → "items").
 *
 * No dependencies, no domain knowledge — equally usable for section-rules
 * keys, primitive names, modifier keys, frontmatter field names.
 */

/**
 * Compute Levenshtein edit distance between two strings.
 * Iterative two-row implementation; O(n·m) time, O(min(n,m)) extra space.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  // Ensure b is the shorter so the working row is shorter.
  if (a.length < b.length) {
    const tmp = a; a = b; b = tmp;
  }

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost,    // substitution
      );
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

/**
 * Compute the cutoff distance for a candidate of given length.
 *
 * - 1-char inputs: no fuzzy match (too noisy)
 * - 2-3 char inputs: at most 1 edit
 * - 4+ char inputs: at most 2 edits, or ⌊len/3⌋ for very long strings
 *
 * Empirically tuned to catch typical typos (`item`/`items`,
 * `valuess`/`values`, `pattren`/`pattern`, `requried`/`required`) without
 * proposing unrelated names.
 *
 * @param {number} candidateLen
 * @returns {number}
 */
function cutoffFor(candidateLen) {
  if (candidateLen <= 1) return 0;
  if (candidateLen <= 3) return 1;
  return Math.min(2, Math.floor(candidateLen / 3) + 1);
}

/**
 * Find the closest candidate to `needle` within `haystack`, or null when
 * none falls within the cutoff. Case-insensitive matching; ties broken by
 * (1) lower distance, (2) shorter candidate, (3) earlier in haystack.
 *
 * @param {string} needle - the offending input the user typed
 * @param {Iterable<string>} haystack - known-valid candidates
 * @returns {string|null} the suggested candidate, or null
 */
export function suggest(needle, haystack) {
  if (typeof needle !== "string" || !needle) return null;
  const lowerNeedle = needle.toLowerCase();
  let bestCandidate = null;
  let bestDistance = Infinity;
  let bestLength = Infinity;

  for (const candidate of haystack) {
    if (typeof candidate !== "string" || !candidate) continue;
    const lowerCandidate = candidate.toLowerCase();
    if (lowerCandidate === lowerNeedle) {
      // Exact case-mismatch is the strongest possible suggestion.
      return candidate;
    }
    const distance = levenshtein(lowerNeedle, lowerCandidate);
    const cutoff = cutoffFor(lowerCandidate.length);
    if (distance > cutoff) continue;
    if (
      distance < bestDistance ||
      (distance === bestDistance && lowerCandidate.length < bestLength)
    ) {
      bestCandidate = candidate;
      bestDistance = distance;
      bestLength = lowerCandidate.length;
    }
  }
  return bestCandidate;
}

/**
 * Convenience: render a "did you mean 'X'?" suffix when a suggestion
 * exists, or an empty string otherwise. Use to decorate an existing error
 * message without changing its base text.
 *
 * Example:
 *   `Unknown key '${key}'.${didYouMean(key, ALLOWED)}`
 *   → "Unknown key 'itme'. Did you mean 'items'?"
 *
 * @param {string} needle
 * @param {Iterable<string>} haystack
 * @returns {string}
 */
export function didYouMean(needle, haystack) {
  const hit = suggest(needle, haystack);
  return hit ? ` Did you mean '${hit}'?` : "";
}
