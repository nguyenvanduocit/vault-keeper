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

import { scalarPrimitives, VALID_TYPES } from "./scalar.js";
import {
  TIME_RE,
  DATETIME_RE,
  toComparableTime,
  formatDateLike,
  beforePrimitive,
  afterPrimitive,
} from "./chronological.js";
import { headingPrimitive, HEADING_INNER_KEYS } from "./heading.js";
import {
  tablePrimitive,
  TABLE_INNER_KEYS,
  TABLE_COLUMN_INNER_KEYS,
  TABLE_VALUES_INNER_KEYS,
  TABLE_ROWS_INNER_KEYS,
  validateColumns as validateTableColumns,
} from "./table.js";
import {
  listPrimitive,
  LIST_INNER_KEYS,
  LIST_ITEMS_INNER_KEYS,
} from "./list.js";
import {
  codePrimitive,
  CODE_INNER_KEYS,
  CODE_CONTENT_INNER_KEYS,
} from "./code.js";
import { formulaPrimitive } from "./formula.js";
import { repeatablePrimitive } from "./repeatable.js";
import { mermaidPrimitive, MERMAID_INNER_KEYS } from "./mermaid.js";
import { gherkinPrimitive, GHERKIN_INNER_KEYS } from "./gherkin.js";

// ── Primitive registry (`name → validate(value, param, ctx) => Issue[]`) ──
//
// The single source of truth for "what primitives does the engine know?".
// Order is significant — `Object.entries` preserves insertion order and
// several diagnostic-emission tests + the example-vault expectations
// rely on it. Keep new primitives appended in a deliberate slot.

export const PRIMITIVES = {
  // Scalar primitives
  type: scalarPrimitives.type,
  required: scalarPrimitives.required,
  enum: scalarPrimitives.enum,
  pattern: scalarPrimitives.pattern,
  min: scalarPrimitives.min,
  max: scalarPrimitives.max,
  // Chronological primitives (date/datetime/time semantics)
  before: beforePrimitive.validate,
  after: afterPrimitive.validate,
  // Remaining scalar primitives
  uniqueItems: scalarPrimitives.uniqueItems,
  exists: scalarPrimitives.exists,
  description: scalarPrimitives.description,
  // Structural primitives (body only)
  heading: headingPrimitive.validate,
  table: tablePrimitive.validate,
  list: listPrimitive.validate,
  code: codePrimitive.validate,
  repeatable: repeatablePrimitive.validate,
  formula: formulaPrimitive.validate,
};

// Body section-rules that validate section content. Adding a new content
// validator should usually mean: create a primitive spec with `name`,
// `ruleType`, `select`, `validate`, and optional `validateConfig`, then add it
// here. The body orchestrator and template meta-validator both dispatch from
// this registry.
export const BODY_SECTION_PRIMITIVES = [
  tablePrimitive,
  listPrimitive,
  codePrimitive,
  mermaidPrimitive,
  gherkinPrimitive,
  formulaPrimitive,
];

// Public re-exports for every primitive spec / helper / allow-list.
// Meta-validation, orchestrators, and external tooling pull from here
// rather than reaching into individual primitive files.
export {
  scalarPrimitives,
  VALID_TYPES,
  TIME_RE,
  DATETIME_RE,
  toComparableTime,
  formatDateLike,
  beforePrimitive,
  afterPrimitive,
  headingPrimitive,
  HEADING_INNER_KEYS,
  tablePrimitive,
  TABLE_INNER_KEYS,
  TABLE_COLUMN_INNER_KEYS,
  TABLE_VALUES_INNER_KEYS,
  TABLE_ROWS_INNER_KEYS,
  validateTableColumns,
  listPrimitive,
  LIST_INNER_KEYS,
  LIST_ITEMS_INNER_KEYS,
  codePrimitive,
  CODE_INNER_KEYS,
  CODE_CONTENT_INNER_KEYS,
  mermaidPrimitive,
  MERMAID_INNER_KEYS,
  gherkinPrimitive,
  GHERKIN_INNER_KEYS,
  formulaPrimitive,
  repeatablePrimitive,
};
