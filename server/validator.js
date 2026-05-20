/**
 * validator.js — LSP-side per-doc validation pipeline.
 *
 * Mirrors the per-doc subset of cli/validate-documents.js#validateDocument
 * but operates on in-memory text (the LSP buffer may be unsaved) instead of
 * reading from disk. Excludes cross-document rules (orphan detection, link
 * graph) — those need a full vault index and would freeze the editor on
 * every keystroke. Cross-doc + on-save full-vault rules remain in the CLI
 * (`bun run validate`) — source of truth for CI gating.
 *
 * Issue shape: `{ level, field, message, fix, error_type? }`. The
 * line-mapper attaches a 0-indexed `line` separately.
 */

import matter from "gray-matter";
import { loadTemplateRules } from "../lib/template-rules.js";
import { applyFieldSchema, applyBodySchema } from "../lib/schema-engine.js";
import {
  validateTemplateField,
  validateTemplateMetaLeak,
  validateSlug,
  validatePaths,
  validateSectionRulesLeak,
  isTemplateFile,
} from "../lib/validators.js";
import { buildFrontmatterLineMap } from "./frontmatter-lines.js";

/**
 * Validate a single document buffer. Pure-ish: reads template file from disk
 * to load the schema (cached by `loadTemplateRules` internally), but does
 * NOT scan the vault.
 *
 * @param {object} args
 * @param {string} args.text          - full raw markdown source (frontmatter + body)
 * @param {string} args.filepath      - repo-relative path (e.g. "section/sub/foo.md")
 * @param {string} args.projectRoot   - absolute path to the vault repo root
 * @returns {Promise<{issues: Issue[], lineMap: LineMap, skipped: boolean}>}
 *
 * Issue: { level, field, message, fix, line? }
 *   - `line` is 0-indexed when known; missing means "frontmatter-wide" → line 0.
 *   - `level` is "error" | "warning".
 *   - `field` is the dot-path of the offending frontmatter key, or a synthetic
 *     tag (`filename`, `folder`, `body`) for non-FM issues.
 */
export async function validateBuffer({ text, filepath, projectRoot }) {
  // Templates carry schema declarations and placeholder text — they are
  // scaffold, not authored content. Skip cleanly so we don't surface
  // diagnostics inside templates/*.md (matches CLI behavior).
  if (isTemplateFile(filepath)) {
    return { issues: [], lineMap: buildFrontmatterLineMap(text), skipped: true };
  }

  // gray-matter is the validator's canonical frontmatter parser — reuse so
  // any YAML quirks (booleans, dates, anchors) parse identically here.
  let fm, body;
  try {
    const parsed = matter(text);
    fm = parsed.data || {};
    body = parsed.content || "";
  } catch (err) {
    // Mid-edit syntax errors are common. Surface ONE diagnostic and stop —
    // running other rules against a half-parsed object yields noise.
    return {
      issues: [
        {
          level: "error",
          field: "frontmatter",
          message: `Frontmatter YAML parse error: ${err.message}`,
          fix: "Fix YAML syntax in the frontmatter block (between `---` fences)",
          line: 0,
        },
      ],
      lineMap: buildFrontmatterLineMap(text),
      skipped: false,
    };
  }

  const lineMap = buildFrontmatterLineMap(text);
  const issues = [];

  // ── Per-doc cross-cutting validators (no FS scan) ─────────────────────────
  issues.push(...validateTemplateField(fm, filepath));
  issues.push(...validateTemplateMetaLeak(fm, filepath));
  issues.push(...validateSlug(filepath));
  issues.push(...validatePaths(fm, body));

  // Built-in `section-rules` fence leak. validateSectionRulesLeak returns a
  // body-relative `bodyLine` per offending block — translate it to a
  // document-absolute 0-indexed `line` so the editor squiggles the exact
  // fence.
  for (const iss of validateSectionRulesLeak(body)) {
    issues.push({ ...iss, line: bodyLineToDocLine(text, iss.bodyLine) });
  }

  // ── Template-driven schema validation ─────────────────────────────────────
  // loadTemplateRules touches disk (reads the template file) but it's a
  // single small read, cached by the OS, ~1ms after first hit. Returns null
  // when the template can't be resolved — file missing, malformed YAML.
  // Missing-template case is already covered by validateTemplateField above,
  // so we only synthesize an error here when fm.template IS set but loading
  // failed. Schema-dependent validators are gated by `if (rules)` below.
  let rules = null;
  if (fm.template) {
    rules = await loadTemplateRules(fm.template, projectRoot);
  }
  if (!rules && fm.template) {
    issues.push({
      level: "error",
      field: "template",
      message: `Cannot load schema from template '${fm.template}' — file not found or malformed YAML`,
      fix: `Verify '${fm.template}' exists (relative to repo root) and contains valid frontmatter. See templates/README.md for the template registry.`,
    });
  }

  if (rules) {
    // Surface template meta-validation errors (spec §8) so malformed
    // templates become visible at LSP time, not only in the CLI.
    for (const te of rules.templateErrors || []) {
      issues.push(te);
    }

    // Frontmatter field schema validation.
    if (rules.fields) {
      const docMeta = { repoRelativePath: filepath };
      issues.push(...applyFieldSchema({ fields: rules.fields, strict: rules.strict }, fm, docMeta));
    }

    // Body schema validation.
    if (Array.isArray(rules.bodySchema) && rules.bodySchema.length > 0) {
      const bodyIssues = applyBodySchema(rules.bodySchema, body);
      // Body issues carry 1-indexed body-relative `bodyLine` — translate
      // each to a document-absolute 0-indexed `line`.
      for (const bi of bodyIssues) {
        issues.push({
          ...bi,
          line: bodyLineToDocLine(text, bi.bodyLine),
        });
      }
    }
  }

  return { issues, lineMap, skipped: false };
}

/**
 * Convert a `parseBody` line (1-indexed, body-relative) to a document-absolute
 * 0-indexed line. The body starts right after the closing `---` fence.
 *
 * `gray-matter` strips the frontmatter from `content`, so body line 1 maps to
 * the FIRST line after the closing fence. We compute that offset by locating
 * the closing fence in the raw text.
 */
function bodyLineToDocLine(text, bodyLine) {
  if (typeof bodyLine !== "number" || bodyLine < 1) return 0;
  // Find the line of the closing `---` fence, then body line 1 = that + 1.
  // (gray-matter sometimes prepends a newline to body — we account for that by
  // searching for the close fence in the raw text rather than guessing.)
  const closeRe = /\r?\n---(\r?\n|$)/;
  const m = text.match(closeRe);
  if (!m) return bodyLine - 1; // no frontmatter → body line = doc line
  // Count newlines up to and including the close fence's `---` line.
  const upto = text.slice(0, m.index + m[0].length);
  let nl = 0;
  for (let i = 0; i < upto.length; i++) if (upto.charCodeAt(i) === 10) nl++;
  // `nl` lines have ended → next line index = nl. body line 1 sits at index `nl`.
  return nl + (bodyLine - 1);
}
