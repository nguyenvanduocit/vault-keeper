/**
 * Unknown-nested-key rejection helper.
 *
 * The "reject any key not in the allow-list" loop recurs at every
 * primitive that owns a closed nested object (`code.content`,
 * `list.items`, `table.rows`, `table.columns[i]`, `table.columns[i].values`).
 * This helper centralises it so the diagnostic — message text,
 * `error_type`, did-you-mean suffix, and `Allowed keys:` fix line — is
 * authored once.
 *
 * `label` is the fully-rendered, already-quoted parent label the caller
 * wants embedded verbatim (e.g. `"'code.content'"`,
 * `` `'table.columns[0]' (status)` ``). The helper does NOT add quotes
 * around it, so callers whose label carries a trailing parenthetical
 * (the table column/values sites) keep their exact wording.
 */

import { issue } from "./issue.js";
import { didYouMean } from "../fuzzy-suggest.js";

/**
 * Push a `template-schema-invalid` issue for every key of `obj` that is
 * not present in `allowedSet`.
 *
 * @param {object} obj - the nested object whose keys are checked
 * @param {Set<string>} allowedSet - the closed allow-list
 * @param {string} label - fully-quoted parent label embedded in the message
 * @param {string} path - section-rules path for the diagnostic
 * @param {Issue[]} issues - accumulator the helper appends to
 */
export function checkUnknownKeys(obj, allowedSet, label, path, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      issues.push(issue(
        "error",
        path,
        `Unknown key '${key}' in ${label} at '${path}'.${didYouMean(key, allowedSet)}`,
        "template-schema-invalid",
        `Allowed keys: ${[...allowedSet].join(", ")}`,
      ));
    }
  }
}
