/**
 * body-parser.js — body-parseable schema parser.
 *
 * Parses markdown body content (frontmatter stripped by caller) and extracts
 * structured sections:
 *
 * Tier-2 (body sections):
 *   - ## Relationships         → typed edges
 *   - ## Acceptance Criteria   → AC sub-entities with implementing/verifying refs
 *   - ## User Stories          → PRD → story refinements
 *   - ## Contribution Log      → derived view (parsed for drift detection only)
 *
 * Moved from frontmatter:
 *   - ## Status History        → [{at, from, to, by, note}]
 *   - ## Phase History         → [{at, from, to, by, note}]
 *   - ## Blocked History       → [{from, to|null, reason, by}]
 *   - ## RICE Score            → {reach, impact, confidence, effort, score, score_computed_match}
 *   - ## Ship Timeline         → {target_ship_date, locked_at, locked_by, history, betting}
 *   - ## Contributions         → [{role, person, at, sections, effort, decision?, artifact?, note?}]
 *   - ## Success Metric Verdict→ {primary, supporting}
 *   - ## Data Sources          → {intercom, amplitude, bigquery, external}
 *
 * Also computes `parsed.derived` lifecycle fields from history tables.
 *
 * Design:
 *   1. unified() + remarkParse + remarkGfm builds the AST.
 *   2. Walk top-level children; H2 headings demarcate sections.
 *   3. For tables: walk table → tableRow → tableCell, extract via toString().
 *      For bullet lists: use raw source line + normalization before regex.
 *   4. Tolerant: unparseable lines emit warnings; the rest of the section
 *      keeps parsing. Section handlers wrap in try/catch.
 *
 * Spec: body-parseable conventions + minimal frontmatter, body as content
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { toString } from "mdast-util-to-string";

// ── Text normalization ────────────────────────────────────────────────────
// Applied to raw source lines before regex matching (bullet lists).
// For table cells, toString() already gives clean text; normalize is still
// applied for dash/quote consistency.

function _normalize(text) {
  return text
    .replace(/\s+/g, " ") // collapse whitespace
    .replace(/[–—]/g, "—") // en-dash/em-dash → em-dash U+2014
    .replace(/[‘’]/g, "'") // smart single quotes → straight
    .replace(/[“”]/g, '"') // smart double quotes → straight
    .trim();
}

// ── Pre-compiled regexes (module-scope) ───────────────────────────────────

/** Relationships bullet line. Captures: title, path, reason? */
const RELATIONSHIP_RE =
  /^- \[(?<title>[^\]]+)\]\((?<path>[^)]+)\)(?:\s*—\s*\*(?<reason>[^*]+)\*)?\s*$/;

/**
 * AC heading. Captures: id, text, priority, status, flag?
 * Accepts strikethrough wrappers around the inner content (descoped AC).
 * The regex below operates on the raw line *after* `~~` tokens are stripped.
 */
const AC_HEADING_RE =
  /^### (?<id>AC\d+(?:\.\d+)?) — (?<text>.+?) — `(?<priority>[a-z]+)` · `(?<status>[a-z]+)`(?:\s*\((?<flag>[^)]+)\))?\s*$/;

/** Sign-off / measurable blockquote metadata line (one-line form). */
const AC_SIGNOFF_RE =
  /^> \*\*Sign-off\*\*:\s*(?<signoff>[^·]+?)\s*·\s*\*\*Measurable\*\*:\s*(?<measurable>yes|no)\s*$/;

/** Implemented-by sub-list item: `[<title>](<path>) — coverage: <full|partial>` */
const AC_IMPL_RE =
  /^\[(?<title>[^\]]+)\]\((?<path>[^)]+)\)\s*—\s*coverage:\s*(?<coverage>full|partial)\s*$/;

/**
 * Verified-by sub-list item:
 * `[<title>](<path>) — verified <date> by [<@handle>](<personPath>) — method: <method>`
 */
const AC_VERIFY_RE =
  /^\[(?<title>[^\]]+)\]\((?<path>[^)]+)\)(?:\s*—\s*verified\s+(?<verifiedAt>\d{4}-\d{2}-\d{2})\s+by\s+\[(?<verifiedBy>@[\w-]+)\]\([^)]+\))?(?:\s*—\s*method:\s*(?<method>automated|manual|sign-off))?\s*$/;

/** User-story bullet: `[title](path)` with optional italic reason. */
const USER_STORY_RE =
  /^- \[(?<title>[^\]]+)\]\((?<path>[^)]+)\)(?:\s*—\s*\*(?<reason>[^*]+)\*)?\s*$/;

/**
 * Contribution log entry (drift-detection only):
 * `- <iso-ts> — [@handle](path) **role** (extra)?`
 */
const CONTRIBUTION_LOG_RE =
  /^- (?<at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?)\s*—\s*\[(?<personHandle>@[\w-]+)\]\([^)]+\)\s+\*\*(?<role>\w+)\*\*(?:\s*\((?<extra>[^)]+)\))?\s*$/;

/**
 * Contributions canonical line (after `- ` prefix stripped + normalization):
 * **<role>** · @<handle> · <ISO8601Z> · sections: `<comma-sep>` · effort: `<level>`
 *   [· decision: `<value>`] [· artifact: [<label>](<url>)] [· note: <text>]
 */
const CONTRIBUTION_LINE_RE =
  /^\*\*(?<role>[a-z_-]+)\*\* · (?<person>@[a-z0-9-]+) · (?<at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) · sections: `(?<sections>[^`]+)` · effort: `(?<effort>[a-z-]+)`(?:\s*·\s*decision:\s*`(?<decision>[a-z_-]+)`)?(?:\s*·\s*artifact:\s*\[(?<artifact_label>[^\]]+)\]\((?<artifact_url>[^)]+)\))?(?:\s*·\s*note:\s*(?<note>.+))?$/;

/** Ship Timeline header line: **Target ship date**: <date> · Locked at: <ts> · Locked by: @handle */
const SHIP_HEADER_RE =
  /^\*\*Target ship date\*\*:\s*(?<date>\d{4}-\d{2}-\d{2})\s*·\s*Locked at:\s*(?<locked_at>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*·\s*Locked by:\s*(?<locked_by>@[\w-]+)\s*$/;

/** Ship Timeline betting line: **Betting window**: <N> days (auto) · Ends at: <date> */
const SHIP_BETTING_RE =
  /^\*\*Betting window\*\*:\s*(?<window_days>\d+)\s*days\s*\(auto\)\s*·\s*Ends at:\s*(?<ends_at>\d{4}-\d{2}-\d{2})\s*$/;

// ── Section dispatch table ─────────────────────────────────────────────────

const SECTION_HANDLERS = {
  relationships: "_parseRelationshipsSection",
  "acceptance criteria": "_parseAcceptanceCriteriaSection",
  "user stories": "_parseUserStoriesSection",
  "contribution log": "_parseContributionLogSection",
  "status history": "_parseStatusHistory",
  "phase history": "_parsePhaseHistory",
  "blocked history": "_parseBlockedHistory",
  "rice score": "_parseRiceScore",
  "ship timeline": "_parseShipTimeline",
  contributions: "_parseContributions",
  "success metric verdict": "_parseSuccessMetricVerdict",
  "data sources": "_parseDataSources",
};

// ── Table header constants (2026-05-13 GMT+7 migration) ─────────
//
// Column timezone suffix dropped from headers — every datetime value now
// carries its `+07:00` offset inline, so the header `At (UTC)` would either
// be redundant (when the value already says +07:00) or lying (if the value
// drifted to a different tz). Renamed to bare `At` / `From` / `To`.
// Legacy header variants kept in `_LEGACY` arrays for parser tolerance during
// migration window — accept either header form, prefer the new one when
// scaffolding new docs.

const STATUS_HISTORY_HEADER = ["at", "from", "to", "by", "note"];
const PHASE_HISTORY_HEADER = ["at", "from phase", "to phase", "by", "note"];
const BLOCKED_HISTORY_HEADER = ["from", "to", "reason", "by"];

const STATUS_HISTORY_HEADER_LEGACY = ["at (utc)", "from", "to", "by", "note"];
const PHASE_HISTORY_HEADER_LEGACY = ["at (utc)", "from phase", "to phase", "by", "note"];
const BLOCKED_HISTORY_HEADER_LEGACY = ["from (utc)", "to (utc)", "reason", "by"];
const RICE_DIMS_ORDER = ["reach", "impact", "confidence", "effort", "score"];

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse markdown body content per body-parseable + minimal-frontmatter conventions.
 *
 * @param {string} markdownContent - raw markdown body (frontmatter stripped by caller)
 * @param {object} [options]
 * @param {string} [options.sourcePath] - source file path for warning context (optional)
 * @param {object} [options.formatHints] - per-section format hints from template
 *   validation_rules.body_section_formats. When provided, enum values and
 *   message strings are derived from these hints instead of built-in defaults.
 * @returns {Promise<ParsedBody>}
 */
export async function parseBody(markdownContent, options = {}) {
  const result = {
    relationships: [],
    acceptanceCriteria: [],
    userStories: [],
    contributionLog: [],
    statusHistory: [],
    phaseHistory: [],
    blockedHistory: [],
    riceScore: null,
    shipTimeline: null,
    contributions: [],
    successMetricVerdict: null,
    dataSources: null,
    derived: {
      approved_at: null,
      in_progress_at: null,
      shipped_at: null,
      started_at: null,
      completed_at: null,
      done_at: null,
    },
    warnings: [],
  };

  if (typeof markdownContent !== "string" || markdownContent.length === 0) {
    return result;
  }

  // Format hints from template validation_rules.body_section_formats.
  // When empty/absent, handlers fall back to built-in defaults.
  const hints = options.formatHints || {};

  // Parse to AST.
  let tree;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(markdownContent);
  } catch (err) {
    result.warnings.push({
      line: 1,
      type: "ast-parse-error",
      message: `failed to parse markdown AST: ${err?.message || String(err)}`,
      fix: "Fix markdown syntax errors in the document body",
    });
    return result;
  }

  const lines = markdownContent.split("\n");
  const seenSections = new Set();

  // Walk top-level children; H2 headings demarcate sections.
  const children = Array.isArray(tree?.children) ? tree.children : [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== "heading" || node.depth !== 2) continue;

    const headingText = _textContent(node).trim().toLowerCase();
    const handlerName = SECTION_HANDLERS[headingText];
    if (!handlerName) continue;

    if (seenSections.has(headingText)) {
      result.warnings.push({
        line: node.position?.start?.line ?? 0,
        type: "duplicate-section",
        message: `Multiple ## ${_textContent(node).trim()} sections — edges appended; consider consolidating.`,
        fix: "Merge the duplicate sections into one",
      });
    }
    seenSections.add(headingText);

    // Collect the subtree from `i+1` up to the next H2 heading.
    const subtree = [];
    for (let j = i + 1; j < children.length; j++) {
      const next = children[j];
      if (next.type === "heading" && next.depth === 2) break;
      subtree.push(next);
    }

    // Dispatch with isolation. `hints` is threaded to every handler so
    // format strings, examples, and valid enums come from the template
    // when available, with built-in defaults as fallback.
    try {
      const handlers = {
        _parseRelationshipsSection,
        _parseAcceptanceCriteriaSection,
        _parseUserStoriesSection,
        _parseContributionLogSection,
        _parseStatusHistory,
        _parsePhaseHistory,
        _parseBlockedHistory,
        _parseRiceScore,
        _parseShipTimeline,
        _parseContributions,
        _parseSuccessMetricVerdict,
        _parseDataSources,
      };
      handlers[handlerName](subtree, lines, result, hints);
    } catch (err) {
      result.warnings.push({
        line: node.position?.start?.line ?? 0,
        type: "section-parse-error",
        message: `unexpected error parsing ## ${headingText}: ${err?.message || String(err)}`,
        fix: "Fix the section content so it can be parsed",
      });
    }
  }

  // Compute derived lifecycle fields from history tables
  _computeDerived(result);

  return result;
}

// ── Tier-2 Section handlers (refactored with normalization) ──────────────

function _parseRelationshipsSection(subtree, lines, result, hints = {}) {
  const rh = hints.relationships || {};
  const fmt = rh.format || "- [<title>](<path>) [— *<reason>*]";
  const ex = rh.example || "- [Title](./path.md) — *reason*";

  for (const node of subtree) {
    if (node.type !== "list") continue;
    const items = Array.isArray(node.children) ? node.children : [];
    for (const item of items) {
      const startLine = item.position?.start?.line;
      if (!startLine) continue;
      const raw = lines[startLine - 1] ?? "";
      const normalized = _normalize(raw);

      const m = normalized.match(RELATIONSHIP_RE);
      if (!m) {
        result.warnings.push({
          line: startLine,
          type: "unparseable-relationship-line",
          message: `Relationship bullet does not match expected format: \`${fmt}\``,
          fix: `Rewrite as: \`${ex}\``,
          raw,
        });
        continue;
      }

      // Contract: `path` is the doc path WITHOUT anchor; `anchor` carries the
      // fragment separately.
      const rawPath = m.groups.path;
      const hashIdx = rawPath.indexOf("#");
      const anchor = hashIdx >= 0 ? rawPath.slice(hashIdx + 1) : null;
      const path = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;

      result.relationships.push({
        title: m.groups.title,
        path,
        anchor,
        reason: m.groups.reason ?? null,
        line: startLine,
      });
    }
  }
}

function _parseAcceptanceCriteriaSection(subtree, lines, result, hints = {}) {
  const groups = [];
  let current = null;
  for (const node of subtree) {
    if (node.type === "heading" && node.depth === 3) {
      if (current) groups.push(current);
      current = { heading: node, body: [] };
    } else if (current) {
      current.body.push(node);
    }
  }
  if (current) groups.push(current);

  for (const group of groups) {
    _parseSingleAC(group, lines, result, hints);
  }
}

function _parseSingleAC(group, lines, result, hints = {}) {
  const ah = hints.acceptance_criteria || {};
  const headingFmt = ah.heading_format || "### AC<n>[.<m>] — <text> — `<priority>` · `<status>` [(flag)]";
  const headingEx = ah.heading_example || "### AC1 — Description — `must` · `draft`";
  const validPriorities = ah.valid_priorities || ["must", "should", "nice"];
  const validStatuses = ah.valid_statuses || ["draft", "implementing", "verified", "descoped"];

  const startLine = group.heading.position?.start?.line ?? 0;
  let headingLine = lines[startLine - 1] ?? "";
  headingLine = headingLine.replace(/~~/g, "");
  headingLine = _normalize(headingLine);

  const m = headingLine.match(AC_HEADING_RE);
  if (!m) {
    result.warnings.push({
      line: startLine,
      type: "ac-heading-malformed",
      message: `AC heading does not match expected format: \`${headingFmt}\``,
      fix: `Rewrite as: \`${headingEx}\``,
      raw: lines[startLine - 1] ?? "",
    });
    return;
  }

  const priority = m.groups.priority;
  const status = m.groups.status;
  if (!validPriorities.includes(priority)) {
    result.warnings.push({
      line: startLine,
      type: "ac-unknown-priority",
      message: `AC priority "${priority}" is not in {${validPriorities.join(", ")}}`,
      fix: `Use one of: ${validPriorities.map((p) => "\`" + p + "\`").join(", ")}`,
      raw: lines[startLine - 1] ?? "",
    });
  }
  if (!validStatuses.includes(status)) {
    result.warnings.push({
      line: startLine,
      type: "ac-unknown-status",
      message: `AC status "${status}" is not in {${validStatuses.join(", ")}}`,
      fix: `Use one of: ${validStatuses.map((s) => "\`" + s + "\`").join(", ")}`,
      raw: lines[startLine - 1] ?? "",
    });
  }

  const ac = {
    id: m.groups.id,
    text: m.groups.text,
    priority,
    status,
    signoff: [],
    measurable: false,
    body: "",
    implementedBy: [],
    verifiedBy: [],
    line: startLine,
  };
  if (m.groups.flag) ac.flag = m.groups.flag;

  let bodyStartLine = null;
  let bodyEndLine = null;
  let pendingSubsection = null;

  for (const node of group.body) {
    if (node.type === "thematicBreak") break;

    if (node.type === "blockquote") {
      const bqLine = node.position?.start?.line;
      const rawBq = bqLine ? (lines[bqLine - 1] ?? "") : "";
      const normalizedBq = _normalize(rawBq);
      const sm = normalizedBq.match(AC_SIGNOFF_RE);
      if (sm) {
        ac.signoff = sm.groups.signoff
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        ac.measurable = sm.groups.measurable === "yes";
      }
      continue;
    }

    if (node.type === "paragraph") {
      const para = _textContent(node).trim();

      if (/^Implemented by:?$/i.test(para) || _isLabelParagraph(node, "Implemented by")) {
        pendingSubsection = "implemented";
        continue;
      }
      if (/^Verified by:?$/i.test(para) || _isLabelParagraph(node, "Verified by")) {
        pendingSubsection = "verified";
        continue;
      }

      pendingSubsection = null;
      const pStart = node.position?.start?.line;
      const pEnd = node.position?.end?.line;
      if (pStart && pEnd) {
        if (bodyStartLine === null) bodyStartLine = pStart;
        bodyEndLine = pEnd;
      }
      continue;
    }

    // Detect ```gherkin``` fenced code blocks — first occurrence wins.
    if (node.type === "code" && node.lang === "gherkin" && !ac.gherkin) {
      ac.gherkin = {
        raw: node.value,
        hasScenario: /^\s*Scenario:\s+\S/m.test(node.value),
        hasGiven:    /^\s*Given\s+\S/m.test(node.value),
        hasWhen:     /^\s*When\s+\S/m.test(node.value),
        hasThen:     /^\s*Then\s+\S/m.test(node.value),
        line:        node.position?.start?.line,
      };
      continue;
    }

    if (node.type === "list" && pendingSubsection) {
      const items = Array.isArray(node.children) ? node.children : [];
      for (const item of items) {
        const ln = item.position?.start?.line;
        if (!ln) continue;
        const raw = (lines[ln - 1] ?? "").replace(/^\s*-\s+/, "").trim();
        const normalizedItem = _normalize(raw);

        if (pendingSubsection === "implemented") {
          const im = normalizedItem.match(AC_IMPL_RE);
          if (!im) {
            const implFmt = ah.impl_format || "[<title>](<path>) — coverage: <full|partial>";
            const implEx = ah.impl_example || "[Feature](./feature.md) — coverage: full";
            result.warnings.push({
              line: ln,
              type: "ac-impl-unparseable",
              message: `Implemented-by item does not match \`${implFmt}\``,
              fix: `Rewrite as: \`${implEx}\``,
              raw,
            });
            continue;
          }
          ac.implementedBy.push({
            title: im.groups.title,
            path: im.groups.path,
            coverage: im.groups.coverage,
          });
        } else if (pendingSubsection === "verified") {
          const vm = normalizedItem.match(AC_VERIFY_RE);
          if (!vm) {
            const verFmt = ah.verify_format || "[<title>](<path>) [— verified <date> by [<@handle>](<path>)] [— method: <method>]";
            const verEx = ah.verify_example || "[Test](./test.md) — verified 2026-01-01 by [@tester](path) — method: manual";
            result.warnings.push({
              line: ln,
              type: "ac-verify-unparseable",
              message: `Verified-by item does not match \`${verFmt}\``,
              fix: `Rewrite as: \`${verEx}\``,
              raw,
            });
            continue;
          }
          ac.verifiedBy.push({
            title: vm.groups.title,
            path: vm.groups.path,
            verifiedAt: vm.groups.verifiedAt ?? null,
            verifiedBy: vm.groups.verifiedBy ?? null,
            method: vm.groups.method ?? null,
          });
        }
      }
      pendingSubsection = null;
      continue;
    }
  }

  if (bodyStartLine !== null && bodyEndLine !== null) {
    ac.body = lines.slice(bodyStartLine - 1, bodyEndLine).join("\n").trim();
  }

  result.acceptanceCriteria.push(ac);
}

function _parseUserStoriesSection(subtree, lines, result, hints = {}) {
  const ush = hints.user_stories || {};
  const fmt = ush.format || "- [<title>](<path>) [— *<reason>*]";
  const ex = ush.example || "- [User Login](./stories/login.md)";

  for (const node of subtree) {
    if (node.type !== "list") continue;
    const items = Array.isArray(node.children) ? node.children : [];
    for (const item of items) {
      const startLine = item.position?.start?.line;
      if (!startLine) continue;
      const raw = lines[startLine - 1] ?? "";
      const normalized = _normalize(raw);

      const m = normalized.match(USER_STORY_RE);
      if (!m) {
        result.warnings.push({
          line: startLine,
          type: "unparseable-user-story-line",
          message: `User story bullet does not match \`${fmt}\``,
          fix: `Rewrite as: \`${ex}\``,
          raw,
        });
        continue;
      }

      result.userStories.push({
        title: m.groups.title,
        path: m.groups.path,
        reason: m.groups.reason ?? null,
        line: startLine,
      });
    }
  }
}

function _parseContributionLogSection(subtree, lines, result, hints = {}) {
  const clh = hints.contribution_log || {};
  const fmt = clh.format || "- <ISO-timestamp> — [@handle](path) **role** [(extra)]";
  const ex = clh.example || "- 2026-01-01T00:00:00Z — [@alice](../../product-data/people/alice.md) **author**";

  for (const node of subtree) {
    if (node.type !== "list") continue;
    const items = Array.isArray(node.children) ? node.children : [];
    for (const item of items) {
      const startLine = item.position?.start?.line;
      if (!startLine) continue;
      const raw = lines[startLine - 1] ?? "";
      const normalized = _normalize(raw);

      const m = normalized.match(CONTRIBUTION_LOG_RE);
      if (!m) {
        result.warnings.push({
          line: startLine,
          type: "unparseable-contribution-line",
          message: `Contribution log entry does not match expected format: \`${fmt}\``,
          fix: `Rewrite as: \`${ex}\``,
          raw,
        });
        continue;
      }

      const { extra } = m.groups;
      const entry = {
        at: m.groups.at,
        person: m.groups.personHandle,
        role: m.groups.role,
        decision: null,
        sections: null,
        line: startLine,
      };

      if (extra) {
        const colonIdx = extra.indexOf(":");
        if (colonIdx > 0) {
          const key = extra.slice(0, colonIdx).trim();
          const value = extra.slice(colonIdx + 1).trim();
          if (key === "sections") {
            entry.sections = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
          } else if (key === "decision") {
            entry.decision = value;
          }
        }
      }

      result.contributionLog.push(entry);
    }
  }
}

// ── Moved-from-frontmatter Section handlers ──────────────────────────────

/**
 * Parse ## Status History table.
 * Headers: At (UTC) | From | To | By | Note
 */
function _parseStatusHistory(subtree, lines, result, hints = {}) {
  const table = _findTable(subtree);
  if (!table) return;

  const sh = hints.status_history || {};
  const canonical = sh.headers || STATUS_HISTORY_HEADER;
  const rows = _parseTableRows(
    table,
    [canonical, STATUS_HISTORY_HEADER_LEGACY],
    "status-history",
    result,
  );
  for (const { cells, line } of rows) {
    const [at, from, to, by, note] = cells;
    result.statusHistory.push({
      at: _validateISO(at, line, "status-history", result) || at,
      from: from || null,
      to: to || null,
      by: by || null,
      note: note || null,
      line,
    });
  }
}

/**
 * Parse ## Phase History table.
 * Headers: At (UTC) | From Phase | To Phase | By | Note
 */
function _parsePhaseHistory(subtree, lines, result, hints = {}) {
  const table = _findTable(subtree);
  if (!table) return;

  const ph = hints.phase_history || {};
  const canonical = ph.headers || PHASE_HISTORY_HEADER;
  const rows = _parseTableRows(
    table,
    [canonical, PHASE_HISTORY_HEADER_LEGACY],
    "phase-history",
    result,
  );
  for (const { cells, line } of rows) {
    const [at, from, to, by, note] = cells;
    result.phaseHistory.push({
      at: _validateISO(at, line, "phase-history", result) || at,
      from: from || null,
      to: to || null,
      by: by || null,
      note: note || null,
      line,
    });
  }
}

/**
 * Parse ## Blocked History table.
 * Headers: From | To | Reason | By  (legacy: From (UTC) | To (UTC) | Reason | By)
 * `_open_` literal in To → null
 */
function _parseBlockedHistory(subtree, lines, result, hints = {}) {
  const table = _findTable(subtree);
  if (!table) return;

  const bh = hints.blocked_history || {};
  const canonical = bh.headers || BLOCKED_HISTORY_HEADER;
  const rows = _parseTableRows(
    table,
    [canonical, BLOCKED_HISTORY_HEADER_LEGACY],
    "blocked-history",
    result,
  );
  for (const { cells, line } of rows) {
    const [from, to, reason, by] = cells;
    // Check for _open_ in raw source line (since toString strips emphasis)
    const rawLine = lines[(line ?? 1) - 1] ?? "";
    const isOpen = rawLine.includes("_open_");

    result.blockedHistory.push({
      from: _validateISO(from, line, "blocked-history", result) || from,
      to: isOpen ? null : (to || null),
      reason: reason || null,
      by: by || null,
      line,
    });
  }
}

/**
 * Parse ## RICE Score table.
 * Rows: Reach, Impact, Confidence, Effort, **Score**
 * Validates score == (R × I × C) / E ± 1
 */
function _parseRiceScore(subtree, lines, result, hints = {}) {
  const table = _findTable(subtree);
  if (!table) return;

  const rh = hints.rice_score || {};
  // RICE table has headers: Dimension | Value | Note
  const expectedHeaders = rh.headers || ["dimension", "value", "note"];
  const requiredDims = rh.required_dimensions || RICE_DIMS_ORDER;

  const [headerRow, ...bodyRows] = table.children;
  if (!headerRow) return;

  const headers = headerRow.children.map((c) => _normalize(toString(c)).toLowerCase());
  if (!_headersMatch(headers, expectedHeaders)) {
    result.warnings.push({
      line: headerRow.position?.start?.line ?? 0,
      type: "rice-header-mismatch",
      message: `RICE Score table headers [${headers.join(", ")}] do not match expected [${expectedHeaders.join(", ")}]`,
    });
    return;
  }

  const rice = {};
  for (const row of bodyRows) {
    const cells = row.children.map((c) => _normalize(toString(c)));
    const dim = cells[0]?.toLowerCase().replace(/\*\*/g, "");
    const rawValue = cells[1]?.replace(/\*\*/g, "");
    const note = cells[2] || null;
    const value = parseFloat(rawValue);

    if (requiredDims.includes(dim)) {
      rice[dim] = { value, note };
    }
  }

  if (!rice.reach || !rice.impact || !rice.confidence || !rice.effort || !rice.score) {
    result.warnings.push({
      line: table.position?.start?.line ?? 0,
      type: "rice-incomplete",
      message: `RICE Score table missing one or more dimensions (${requiredDims.join(", ")})`,
    });
    return;
  }

  const computed = (rice.reach.value * rice.impact.value * rice.confidence.value) / rice.effort.value;
  const match = Math.abs(rice.score.value - computed) <= 1;

  result.riceScore = {
    reach: rice.reach.value,
    impact: rice.impact.value,
    confidence: rice.confidence.value,
    effort: rice.effort.value,
    score: rice.score.value,
    score_computed_match: match,
  };
}

/**
 * Parse ## Ship Timeline section.
 * Contains: header line, change history table, betting line, extensions table.
 */
function _parseShipTimeline(subtree, lines, result, hints = {}) {
  const timeline = {
    target_ship_date: null,
    locked_at: null,
    locked_by: null,
    history: [],
    betting: {
      window_days: null,
      ends_at: null,
      extensions: [],
    },
  };

  // Walk subtree: paragraphs for header/betting lines, tables for history/extensions
  const tables = [];
  for (const node of subtree) {
    if (node.type === "paragraph") {
      const startLine = node.position?.start?.line;
      if (!startLine) continue;
      const raw = lines[startLine - 1] ?? "";
      const normalized = _normalize(raw);

      const hm = normalized.match(SHIP_HEADER_RE);
      if (hm) {
        timeline.target_ship_date = hm.groups.date;
        timeline.locked_at = hm.groups.locked_at;
        timeline.locked_by = hm.groups.locked_by;
        continue;
      }

      const bm = normalized.match(SHIP_BETTING_RE);
      if (bm) {
        timeline.betting.window_days = parseInt(bm.groups.window_days, 10);
        timeline.betting.ends_at = bm.groups.ends_at;
        continue;
      }
    }

    if (node.type === "table") {
      tables.push(node);
    }
  }

  // First table = change history, second table = extensions
  const sth = hints.ship_timeline || {};
  if (tables.length >= 1) {
    const historyHeaders = sth.change_headers || ["at (utc)", "field", "old", "new", "reason", "approved by"];
    const rows = _parseTableRows(tables[0], historyHeaders, "ship-timeline-history", result);
    for (const { cells, line } of rows) {
      const [at, field, oldVal, newVal, reason, approvedBy] = cells;
      timeline.history.push({
        at: at || null,
        field: field || null,
        old: oldVal || null,
        new: newVal || null,
        reason: reason || null,
        approved_by: approvedBy || null,
        line,
      });
    }
  }

  if (tables.length >= 2) {
    const extHeaders = sth.extension_headers || ["at (utc)", "extension type", "new ends at", "reason", "extended by"];
    const rows = _parseTableRows(tables[1], extHeaders, "ship-timeline-extensions", result);
    for (const { cells, line } of rows) {
      const [at, extensionType, newEndsAt, reason, extendedBy] = cells;
      timeline.betting.extensions.push({
        at: at || null,
        extension_type: extensionType || null,
        new_ends_at: newEndsAt || null,
        reason: reason || null,
        extended_by: extendedBy || null,
        line,
      });
    }
  }

  result.shipTimeline = timeline;
}

/**
 * Parse ## Contributions (bullet list with · separator).
 */
function _parseContributions(subtree, lines, result, hints = {}) {
  const ch = hints.contributions || {};
  const fmt = ch.format || "**<role>** · @<handle> · <ISO-ts> · sections: `<list>` · effort: `<level>`";
  const ex = ch.example || "**author** · @alice · 2026-01-01T00:00:00Z · sections: `*` · effort: `medium`";

  for (const node of subtree) {
    if (node.type !== "list") continue;
    const items = Array.isArray(node.children) ? node.children : [];
    for (const item of items) {
      const startLine = item.position?.start?.line;
      if (!startLine) continue;
      const raw = lines[startLine - 1] ?? "";
      // Strip leading `- ` then normalize
      const stripped = raw.replace(/^\s*-\s+/, "");
      const normalized = _normalize(stripped);

      const m = normalized.match(CONTRIBUTION_LINE_RE);
      if (!m) {
        result.warnings.push({
          line: startLine,
          type: "unparseable-contribution-line",
          message: `Contribution line does not match expected format: \`${fmt}\``,
          fix: `Rewrite as: \`${ex}\``,
          raw,
        });
        continue;
      }

      const entry = {
        role: m.groups.role,
        person: m.groups.person,
        at: m.groups.at,
        sections: m.groups.sections,
        effort: m.groups.effort,
        line: startLine,
      };
      if (m.groups.decision) entry.decision = m.groups.decision;
      if (m.groups.artifact_label) {
        entry.artifact = { label: m.groups.artifact_label, url: m.groups.artifact_url };
      }
      if (m.groups.note) entry.note = m.groups.note;

      result.contributions.push(entry);
    }
  }
}

/**
 * Parse ## Success Metric Verdict section.
 * Sub-headings: ### Primary (required), ### Supporting (optional).
 * `_pending_` literal → null
 */
function _parseSuccessMetricVerdict(subtree, lines, result, hints = {}) {
  const verdict = { primary: null, supporting: null };

  // Split subtree into groups by H3
  let currentGroup = null;
  let currentName = null;
  const groups = {};

  for (const node of subtree) {
    if (node.type === "heading" && node.depth === 3) {
      currentName = _textContent(node).trim().toLowerCase();
      currentGroup = [];
      groups[currentName] = currentGroup;
    } else if (currentGroup) {
      currentGroup.push(node);
    }
  }

  if (groups["primary"]) {
    verdict.primary = _parseMetricBulletList(groups["primary"], lines, result);
  }
  if (groups["supporting"]) {
    verdict.supporting = _parseMetricBulletList(groups["supporting"], lines, result);
  }

  result.successMetricVerdict = verdict;
}

/**
 * Parse bullet list items for a metric verdict sub-section.
 * Format: `- **<Field>**: <value>`
 * `_pending_` → null
 */
function _parseMetricBulletList(subtreeNodes, lines, result) {
  const fields = {};
  for (const node of subtreeNodes) {
    if (node.type === "paragraph") {
      // Check for "(none)" placeholder
      const text = _textContent(node).trim();
      if (/^\(none\)$/i.test(text)) return null;
    }
    if (node.type !== "list") continue;
    const items = Array.isArray(node.children) ? node.children : [];
    for (const item of items) {
      const startLine = item.position?.start?.line;
      if (!startLine) continue;
      const raw = lines[startLine - 1] ?? "";
      // Strip `- ` prefix
      const stripped = raw.replace(/^\s*-\s+/, "");

      // Match **Field**: value
      const fieldMatch = stripped.match(/^\*\*(?<field>[^*]+)\*\*:\s*(?<value>.+)$/);
      if (!fieldMatch) continue;

      const fieldName = fieldMatch.groups.field.trim().toLowerCase().replace(/\s+/g, "_");
      let value = fieldMatch.groups.value.trim();

      // Strip HTML comments from value first
      value = value.replace(/<!--.*?-->/g, "").trim();

      // _pending_ in raw source → null
      if (value === "_pending_") {
        value = null;
      }
      // Empty after stripping → null
      if (value === "") value = null;

      fields[fieldName] = value;
    }
  }

  return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * Parse ## Data Sources section.
 * Sub-headings: ### Intercom, ### Amplitude, ### BigQuery, ### External
 * Each has bullet list items.
 */
function _parseDataSources(subtree, lines, result, hints = {}) {
  const sources = {
    intercom: [],
    amplitude: [],
    bigquery: [],
    external: [],
  };

  let currentCategory = null;
  for (const node of subtree) {
    if (node.type === "heading" && node.depth === 3) {
      const name = _textContent(node).trim().toLowerCase();
      if (name in sources) {
        currentCategory = name;
      } else {
        currentCategory = null;
      }
      continue;
    }

    if (node.type === "paragraph" && currentCategory) {
      const text = _textContent(node).trim();
      if (/^\(none\)$/i.test(text)) continue;
    }

    if (node.type === "list" && currentCategory) {
      const items = Array.isArray(node.children) ? node.children : [];
      for (const item of items) {
        const startLine = item.position?.start?.line;
        if (!startLine) continue;
        const raw = lines[startLine - 1] ?? "";
        const stripped = raw.replace(/^\s*-\s+/, "").trim();
        sources[currentCategory].push({
          raw: stripped,
          line: startLine,
        });
      }
    }
  }

  result.dataSources = sources;
}

// ── Derived lifecycle fields ──────────────────────────────────────────────

/**
 * Compute derived lifecycle timestamps from history tables.
 *
 * Status history (lifecycle artifacts: PRD, DIBB, user-story):
 *   approved_at    ← first entry where to === "approved"
 *   in_progress_at ← first entry where to === "in_progress"
 *   shipped_at     ← first entry where to === "shipped"
 *
 * Phase history (work items: tasks):
 *   started_at     ← first entry where to ∈ {coding, in_progress, doing}
 *                     ("first IN_PROGRESS phase entry"; actual vault uses "coding")
 *   completed_at   ← first entry where to === "completed"
 *   done_at        ← first entry where to === "done"
 */
function _computeDerived(result) {
  const d = result.derived;

  // From status history
  for (const entry of result.statusHistory) {
    if (entry.to === "approved" && !d.approved_at) d.approved_at = entry.at;
    if (entry.to === "in_progress" && !d.in_progress_at) d.in_progress_at = entry.at;
    if (entry.to === "shipped" && !d.shipped_at) d.shipped_at = entry.at;
  }

  // Phase values that indicate "started" (work has begun)
  const STARTED_PHASES = new Set(["coding", "in_progress", "doing"]);

  // From phase history
  for (const entry of result.phaseHistory) {
    if (STARTED_PHASES.has(entry.to) && !d.started_at) d.started_at = entry.at;
    if (entry.to === "completed" && !d.completed_at) d.completed_at = entry.at;
    if (entry.to === "done" && !d.done_at) d.done_at = entry.at;
  }
}

// ── Table helpers ─────────────────────────────────────────────────────────

/** Find the first table node in subtree. */
function _findTable(subtree) {
  for (const node of subtree) {
    if (node.type === "table") return node;
  }
  return null;
}

/**
 * Parse a GFM table into row data, validating headers.
 * Returns [{cells: string[], line: number}] for body rows.
 *
 * `expectedHeaders` may be either:
 *   - a single header array (string[]) — for tables with one canonical shape
 *   - an array of header alternatives (string[][]) — for tables that accept
 *     both current and legacy header forms during the GMT+7 migration
 *     window (history tables: "at" vs "at (utc)" etc., per 2026-05-13).
 */
function _parseTableRows(tableNode, expectedHeaders, sectionType, result) {
  const [headerRow, ...bodyRows] = tableNode.children;
  if (!headerRow) return [];

  const headers = headerRow.children.map((c) => _normalize(toString(c)).toLowerCase());

  const alternatives = Array.isArray(expectedHeaders[0])
    ? expectedHeaders
    : [expectedHeaders];

  const matched = alternatives.some((alt) => _headersMatch(headers, alt));
  if (!matched) {
    const expectedDescription = alternatives
      .map((alt) => `[${alt.join(", ")}]`)
      .join(" or ");
    result.warnings.push({
      line: headerRow.position?.start?.line ?? 0,
      type: `${sectionType}-header-mismatch`,
      message: `Table headers [${headers.join(", ")}] do not match expected ${expectedDescription}`,
    });
    return [];
  }

  const rows = [];
  for (const row of bodyRows) {
    const cells = row.children.map((c) => _normalize(toString(c)));
    const line = row.position?.start?.line ?? 0;
    rows.push({ cells, line });
  }
  return rows;
}

/** Check if actual headers contain all expected headers (case-insensitive, order-sensitive). */
function _headersMatch(actual, expected) {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Validate ISO 8601 timestamp. Returns the string if valid, emits warning if not.
 * Accepts the current vault convention (GMT+7) plus legacy forms for read tolerance:
 *   - YYYY-MM-DDTHH:MM:SS+07:00  (current — emitted by nowIso())
 *   - YYYY-MM-DDTHH:MM(:SS)?Z    (legacy UTC)
 *   - YYYY-MM-DD                 (legacy date-only)
 */
function _validateISO(value, line, sectionType, result) {
  if (!value) return null;
  const re = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|\+07:00))?$/;
  if (re.test(value)) {
    return value;
  }
  result.warnings.push({
    line,
    type: `${sectionType}-invalid-timestamp`,
    message: `Timestamp "${value}" does not match ISO 8601 (expected YYYY-MM-DDTHH:MM:SS+07:00)`,
  });
  return value;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Best-effort plain text concatenation of an AST node's descendants.
 * Used ONLY for cheap matching (section heading text, sub-section labels).
 * For canonical-form line parsing we always go back to the raw source line.
 */
function _textContent(node) {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(_textContent).join("");
}

/**
 * Detect a "label paragraph" like `**Implemented by**:` or `**Verified by**:`
 */
function _isLabelParagraph(node, label) {
  if (!node || node.type !== "paragraph") return false;
  const first = node.children?.[0];
  if (!first || first.type !== "strong") return false;
  const inner = _textContent(first).trim();
  return inner === label;
}

// ── JSDoc typedefs ────────────────────────────────────────────────────────

/**
 * @typedef {object} Edge
 * @property {string} title
 * @property {string} path
 * @property {string|null} anchor
 * @property {string|null} reason
 * @property {number} line
 */

/**
 * @typedef {object} ACImpl
 * @property {string} title
 * @property {string} path
 * @property {string} coverage
 */

/**
 * @typedef {object} ACVerify
 * @property {string} title
 * @property {string} path
 * @property {string|null} verifiedAt
 * @property {string|null} verifiedBy
 * @property {string|null} method
 */

/**
 * @typedef {object} AC
 * @property {string} id
 * @property {string} text
 * @property {string} priority
 * @property {string} status
 * @property {string[]} signoff
 * @property {boolean} measurable
 * @property {string} body
 * @property {ACImpl[]} implementedBy
 * @property {ACVerify[]} verifiedBy
 * @property {number} line
 * @property {string} [flag]
 * @property {ACGherkin} [gherkin] — present when AC body contains a ```gherkin``` fenced block
 */

/**
 * @typedef {object} ACGherkin
 * @property {string} raw — raw content of the gherkin fenced code block
 * @property {boolean} hasScenario — true if block contains `Scenario:` keyword
 * @property {boolean} hasGiven — true if block contains `Given` keyword
 * @property {boolean} hasWhen — true if block contains `When` keyword
 * @property {boolean} hasThen — true if block contains `Then` keyword
 * @property {number} line — start line of the fenced code block
 */

/**
 * @typedef {object} UserStory
 * @property {string} title
 * @property {string} path
 * @property {string|null} reason
 * @property {number} line
 */

/**
 * @typedef {object} ContributionEntry
 * @property {string} at
 * @property {string} person
 * @property {string} role
 * @property {string|null} decision
 * @property {string[]|null} sections
 * @property {number} line
 */

/**
 * @typedef {object} StatusHistoryEntry
 * @property {string} at
 * @property {string|null} from
 * @property {string|null} to
 * @property {string|null} by
 * @property {string|null} note
 * @property {number} line
 */

/**
 * @typedef {object} PhaseHistoryEntry
 * @property {string} at
 * @property {string|null} from
 * @property {string|null} to
 * @property {string|null} by
 * @property {string|null} note
 * @property {number} line
 */

/**
 * @typedef {object} BlockedHistoryEntry
 * @property {string} from
 * @property {string|null} to
 * @property {string|null} reason
 * @property {string|null} by
 * @property {number} line
 */

/**
 * @typedef {object} RiceScore
 * @property {number} reach
 * @property {number} impact
 * @property {number} confidence
 * @property {number} effort
 * @property {number} score
 * @property {boolean} score_computed_match
 */

/**
 * @typedef {object} ContributionADR007
 * @property {string} role
 * @property {string} person
 * @property {string} at
 * @property {string} sections
 * @property {string} effort
 * @property {string} [decision]
 * @property {{label: string, url: string}} [artifact]
 * @property {string} [note]
 * @property {number} line
 */

/**
 * @typedef {object} DerivedFields
 * @property {string|null} approved_at
 * @property {string|null} in_progress_at
 * @property {string|null} shipped_at
 * @property {string|null} started_at
 * @property {string|null} completed_at
 * @property {string|null} done_at
 */

/**
 * @typedef {object} Warning
 * @property {number} line
 * @property {string} type
 * @property {string} message
 * @property {string} [raw]
 */

/**
 * @typedef {object} ParsedBody
 * @property {Edge[]} relationships
 * @property {AC[]} acceptanceCriteria
 * @property {UserStory[]} userStories
 * @property {ContributionEntry[]} contributionLog
 * @property {StatusHistoryEntry[]} statusHistory
 * @property {PhaseHistoryEntry[]} phaseHistory
 * @property {BlockedHistoryEntry[]} blockedHistory
 * @property {RiceScore|null} riceScore
 * @property {object|null} shipTimeline
 * @property {ContributionADR007[]} contributions
 * @property {object|null} successMetricVerdict
 * @property {object|null} dataSources
 * @property {DerivedFields} derived
 * @property {Warning[]} warnings
 */
