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
 * Issue shape: `{ level, field, message, fix }`. The line-mapper attaches a
 * 0-indexed `line` separately.
 */

import matter from "gray-matter";
import { parseBody } from "../lib/body-parser.js";
import { loadTemplateRules } from "../lib/template-rules.js";
import {
  validateTemplateField,
  validateTemplateMetaLeak,
  validateSlug,
  validatePaths,
  validateSectionRulesLeak,
  applyRules,
  isTemplateFile,
} from "../lib/validators.js";
import { buildFrontmatterLineMap } from "./frontmatter-lines.js";
import { loadTemplateSectionRules } from "../lib/template-section-rules.js";

/**
 * Validate a single document buffer. Pure-ish: reads template file from disk
 * to load validation_rules (cached by `loadTemplateRules` internally), but
 * does NOT scan the vault.
 *
 * @param {object} args
 * @param {string} args.text          - full raw markdown source (frontmatter + body)
 * @param {string} args.filepath      - repo-relative path (e.g. "product-knowledge/02-product/prds/foo.md")
 * @param {string} args.projectRoot   - absolute path to the vault repo root
 * @returns {Promise<{issues: Issue[], lineMap: LineMap, skipped: boolean}>}
 *
 * Issue: { level, field, message, fix, line? }
 *   - `line` is 0-indexed when known; missing means "frontmatter-wide" → line 0.
 *   - `level` is "error" | "warning".
 *   - `field` is the dot-path of the offending frontmatter key, or a synthetic
 *     tag (`filename`, `folder`, `body`, `relationships`) for non-FM issues.
 */
export async function validateBuffer({ text, filepath, projectRoot }) {
  // Templates themselves carry validation_rules and placeholder text — they
  // are scaffold, not authored content. Skip cleanly so we don't surface
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
  // fence (mirrors the body-parser warning line mapping below).
  for (const iss of validateSectionRulesLeak(body)) {
    issues.push({ ...iss, line: bodyLineToDocLine(text, iss.bodyLine) });
  }

  // ── Template-driven rules ──────────────────────────────────────────────────
  // loadTemplateRules touches disk (reads the template file) but it's a single
  // small read, cached by the OS, ~1ms after first hit. Returns null when the
  // template can't be resolved — file missing, malformed, or no rules block.
  // Missing-template case is already covered by validateTemplateField above,
  // so we only synthesize an error here when fm.template IS set but loading
  // failed. Rule-dependent validators are gated by `if (rules)` below.
  let rules = null;
  let sectionRules = {};
  if (fm.template) {
    rules = await loadTemplateRules(fm.template, projectRoot);
    sectionRules = await loadTemplateSectionRules(fm.template, projectRoot);
  }
  if (!rules && fm.template) {
    issues.push({
      level: "error",
      field: "template",
      message: `Cannot load validation_rules from template '${fm.template}' — file not found, malformed YAML, or missing validation_rules block`,
      fix: `Verify '${fm.template}' exists (relative to repo root) and contains a 'validation_rules:' block in its frontmatter. See templates/README.md for the template registry.`,
    });
  }
  const hasSectionRules = Object.keys(sectionRules).length > 0;
  if (rules) {
    issues.push(...applyRules(rules, fm, body, filepath));
  }

  // ── Body-format warnings ────────────────────────────────────────────────
  // parseBody returns its own `warnings[]` with line numbers — we surface
  // each as a diagnostic with field="body" and line attached.
  try {
    const parsed = await parseBody(body, { formatHints: hasSectionRules ? sectionRules : rules?.body_section_formats });
    if (parsed && Array.isArray(parsed.warnings)) {
      for (const w of parsed.warnings) {
        issues.push({
          level: "warning",
          field: "body",
          message: w.message,
          fix: w.fix || "Fix the format to match the expected pattern shown in the message",
          // `parseBody` line numbers are relative to the body (1-indexed).
          // Translate to document-absolute 0-indexed: bodyOffset + (w.line - 1).
          line: bodyLineToDocLine(text, w.line),
          // Preserve original metadata for callers that want to render `raw`.
          _raw: w.raw,
          _type: w.type,
        });
      }
    }
  } catch {
    // Body parse failure already covered by frontmatter try/catch above for
    // syntactically broken docs. Don't surface an extra warning.
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
