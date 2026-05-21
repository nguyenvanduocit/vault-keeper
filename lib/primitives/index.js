/**
 * Primitive registry barrel.
 *
 * Single touch-point for "what primitives does the engine know about?".
 * Each primitive module exports a spec object whose shape is at minimum:
 *
 *   {
 *     name:     string,               // canonical key
 *     validate: (value, param, ctx) => Issue[],
 *     // optional, primitive-specific:
 *     innerKeys?: Set<string>,        // allowed nested keys (compound primitives)
 *     itemsInnerKeys / contentInnerKeys / columnInnerKeys / ...
 *     validateConfig?: (...args) => Issue[],   // template-time meta
 *     validateColumns?: (...args) => Issue[],  // table-only meta walker
 *   }
 *
 * Adding a primitive is now:
 *   1. create `lib/primitives/<name>.js` with the spec
 *   2. re-export it from this file
 *   3. (if it surfaces as a frontmatter field constraint or a section-
 *      rule key, wire it into the corresponding allow-list / registry
 *      consumer)
 *
 * Backward-compat note: external callers still consume `PRIMITIVES`
 * (a `name → validateFn` map) from `lib/schema-engine.js`. That file
 * imports the specs from here and assembles the historic ordering.
 */

export { scalarPrimitives, VALID_TYPES } from "./scalar.js";
export {
  TIME_RE,
  DATETIME_RE,
  toComparableTime,
  formatDateLike,
  beforePrimitive,
  afterPrimitive,
} from "./chronological.js";
export { headingPrimitive, HEADING_INNER_KEYS } from "./heading.js";
export {
  tablePrimitive,
  TABLE_INNER_KEYS,
  TABLE_COLUMN_INNER_KEYS,
  TABLE_VALUES_INNER_KEYS,
  TABLE_ROWS_INNER_KEYS,
  validateColumns as validateTableColumns,
} from "./table.js";
export {
  listPrimitive,
  LIST_INNER_KEYS,
  LIST_ITEMS_INNER_KEYS,
} from "./list.js";
export {
  codePrimitive,
  CODE_INNER_KEYS,
  CODE_CONTENT_INNER_KEYS,
} from "./code.js";
export { formulaPrimitive } from "./formula.js";
export { repeatablePrimitive } from "./repeatable.js";
