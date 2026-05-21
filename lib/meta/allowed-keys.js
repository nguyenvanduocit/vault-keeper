import { BODY_SECTION_PRIMITIVES } from "../primitives/index.js";

/**
 * Top-level section-rules key contract.
 *
 * Envelope keys live here; validator keys come from the body primitive
 * registry. Adding/removing a content validator no longer requires editing
 * this allow-list manually.
 */

/** Keys allowed at the top of a section-rules block. */
export const SECTION_RULES_KEYS = new Set([
  "required", "repeatable", "heading",
  ...BODY_SECTION_PRIMITIVES.map((p) => p.name),
  "min", "max", "severity", "message",
]);
