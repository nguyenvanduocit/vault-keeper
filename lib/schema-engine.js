/**
 * Composable schema validation engine — barrel module.
 *
 * Spec references: §4 (primitives), §5 (frontmatter), §7 (engine), §8 (meta).
 *
 * After the v0.11 refactor every concern has its own home:
 *
 *   lib/primitives/                 — primitive runtimes + spec objects
 *   lib/primitives/index.js         — canonical PRIMITIVES registry
 *   lib/meta/field-schema.js        — validateTemplateSchema
 *   lib/meta/body-schema.js         — validateBodyTemplateSchema
 *   lib/meta/allowed-keys.js        — top-level SECTION_RULES_KEYS
 *   lib/apply/field-schema.js       — applyFieldSchema
 *   lib/apply/body-schema.js        — applyBodySchema
 *   lib/apply/synthetic.js          — SYNTHETIC_RESOLVERS ($path, …)
 *   lib/helpers/issue.js            — Issue typedef + builder
 *   lib/helpers/constraint.js       — normalizeConstraint, MODIFIER_KEYS,
 *                                     isSyntaxError
 *   lib/helpers/heading-path.js     — headingLabel, headingPath
 *
 * This file is now a thin re-export surface. The `./schema-engine`
 * named entry in `package.json` exports — applyFieldSchema,
 * applyBodySchema, validateTemplateSchema, validateBodyTemplateSchema,
 * PRIMITIVES, SYNTHETIC_RESOLVERS — all resolve through here for
 * backward-compat. Internal modules import the canonical home directly.
 *
 * @typedef {object} SectionRules
 * @property {boolean}  [required]
 * @property {boolean}  [repeatable]
 * @property {object}   [heading]    - { pattern?, enum? }
 * @property {object}   [table]      - { columns?, rows?, strict? }
 * @property {object}   [list]       - { items?, min?, max?, unique? }
 * @property {object}   [code]       - { lang?, min?, max?, content? }
 * @property {string}   [formula]    - arithmetic / comparison expression
 * @property {number}   [min]
 * @property {number}   [max]
 * @property {string}   [severity]
 * @property {string}   [message]
 *
 * @typedef {object} BodySchemaNode
 * @property {number} depth
 * @property {string} text
 * @property {SectionRules|null} sectionRules
 * @property {BodySchemaNode[]} children
 *
 * @typedef {object} BodyIssue
 * @property {string} level      - "error" | "warning"
 * @property {string} field
 * @property {string} message
 * @property {string} error_type
 * @property {string} [fix]
 * @property {number} [bodyLine]
 */

// ── Primitive registry ────────────────────────────────────────────────
export { PRIMITIVES } from "./primitives/index.js";

// ── Synthetic field resolvers (spec §5.2) ─────────────────────────────
export { SYNTHETIC_RESOLVERS } from "./apply/synthetic.js";

// ── Frontmatter orchestrator (spec §5) ────────────────────────────────
export { applyFieldSchema } from "./apply/field-schema.js";

// ── Body orchestrator (spec §6) ───────────────────────────────────────
export { applyBodySchema } from "./apply/body-schema.js";

// ── Meta-validation (spec §8) ─────────────────────────────────────────
export { validateTemplateSchema } from "./meta/field-schema.js";
export { validateBodyTemplateSchema } from "./meta/body-schema.js";
