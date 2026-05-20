/**
 * diagnostics.js — convert validator issues into LSP Diagnostic objects.
 *
 * The validator emits issues of shape `{ level, field, message, fix, line? }`.
 * LSP needs `{ severity, range, message, source, code }`. This module:
 *   - resolves the issue's line (preferring the explicit `line`, falling back
 *     to the frontmatter line-map, falling back to line 0),
 *   - builds a sensible `range` (whole-line by default; narrowed when the
 *     field's key text is locatable on the line),
 *   - prepends the `fix:` hint to the message so authors see it inline.
 */

import { DiagnosticSeverity } from "vscode-languageserver/node.js";

const SEVERITY = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

/**
 * @param {Issue[]} issues
 * @param {LineMap} lineMap
 * @param {string}  text     full document text (for narrowing the range)
 * @returns {Diagnostic[]}
 */
export function issuesToDiagnostics(issues, lineMap, text) {
  const lines = text.split("\n");
  return issues.map((iss) => issueToDiagnostic(iss, lineMap, lines));
}

function issueToDiagnostic(issue, lineMap, lines) {
  const lineNum = resolveLine(issue, lineMap);
  const lineText = lines[lineNum] ?? "";

  // Default range = entire line. Narrow to the field's key span when the
  // field is a simple top-level key visible on that line (improves the
  // editor's red-squiggle placement vs. an entire-line underline).
  const range = narrowRange(issue.field, lineNum, lineText);

  const messageParts = [issue.message];
  if (issue.fix) messageParts.push(`fix: ${issue.fix}`);

  return {
    severity: SEVERITY[issue.level] ?? DiagnosticSeverity.Warning,
    range,
    message: messageParts.join("\n"),
    source: "vault-keeper",
    // The `code` surfaces in tooltips and can be hovered. Use the field path
    // so authors searching for a specific field find the right issue fast.
    code: issue.field || "vault-keeper",
  };
}

function resolveLine(issue, lineMap) {
  // 1. Explicit line from the issue (body validation warnings, frontmatter parse
  //    errors) — already 0-indexed by the validator wrapper.
  if (typeof issue.line === "number" && issue.line >= 0) return issue.line;

  // 2. Field-path lookup via the frontmatter line-map.
  if (issue.field && lineMap?.lineFor) {
    const mapped = lineMap.lineFor(issue.field);
    if (typeof mapped === "number") return mapped;
  }

  // 3. Synthetic field tags: filename/folder issues belong on line 0 (file-
  //    level), `relationships` falls back to its parent key when present.
  if (issue.field === "filename" || issue.field === "folder") return 0;

  return 0;
}

function narrowRange(field, lineNum, lineText) {
  // Default to whole line range so the diagnostic is visible even when
  // narrowing fails. LSP positions are 0-indexed char offsets within the line.
  const whole = {
    start: { line: lineNum, character: 0 },
    end: { line: lineNum, character: lineText.length || 1 },
  };

  if (!field || typeof field !== "string") return whole;

  // Use the leaf segment of the dot path — `success_metric_actual.primary.verdict`
  // surfaces as `verdict:` on the diagnostic's line.
  const leaf = field.split(".").pop();
  if (!leaf) return whole;

  // Look for `<leaf>:` (YAML key form) on the line. Allow leading whitespace.
  const re = new RegExp(`(^|\\s)(${escapeRegex(leaf)}):`);
  const m = re.exec(lineText);
  if (!m) return whole;

  const keyStart = m.index + m[1].length;
  return {
    start: { line: lineNum, character: keyStart },
    end: { line: lineNum, character: keyStart + leaf.length },
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
