/**
 * examples/example/ doubles as the canonical test dataset.
 *
 * One CLI invocation per `bun test` run: validate the whole example vault and
 * assert each document's `result` matches its entry in
 * `example-vault.expectations.json`. Adding a fixture doc = adding a JSON
 * entry. No new test cases required.
 *
 * The example is human-readable documentation AND machine-checkable
 * expectations in one place — change the example, change the JSON, the test
 * follows.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, '..');
const VALIDATE = join(REPO_ROOT, 'cli', 'validate-documents.js');
const VAULT = join(REPO_ROOT, 'examples', 'example');
const EXPECTATIONS_PATH = join(TESTS_DIR, 'example-vault.expectations.json');

let report;
let expectations;

beforeAll(() => {
  // The validator exits non-zero when invalid docs exist. The example
  // intentionally ships invalid fixtures, so execFileSync throws — we recover
  // the JSON report from the thrown error's `stdout`.
  let raw;
  try {
    raw = execFileSync(
      'bun',
      [VALIDATE, '--root', VAULT, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    raw = err.stdout;
    if (!raw) {
      throw new Error(
        `validator did not emit JSON. stderr: ${err.stderr || '<none>'}`,
      );
    }
  }
  report = JSON.parse(raw);

  expectations = JSON.parse(readFileSync(EXPECTATIONS_PATH, 'utf-8'));
  // _schema is a documentation block, not a doc expectation.
  delete expectations._schema;
});

describe('examples/example/ — fixture-cum-documentation', () => {
  test('validator returned a result for every fixture doc', () => {
    const expectedPaths = Object.keys(expectations).sort();
    const actualPaths = report.results.map((r) => r.filepath).sort();
    expect(actualPaths).toEqual(expectedPaths);
  });

  test('every fixture doc matches its expectations entry', () => {
    const mismatches = [];

    for (const result of report.results) {
      const expected = expectations[result.filepath];
      if (!expected) {
        mismatches.push(
          `${result.filepath}: no expectations entry (add one to tests/example-vault.expectations.json)`,
        );
        continue;
      }

      if (result.valid !== expected.valid) {
        mismatches.push(
          `${result.filepath}: expected valid=${expected.valid}, got ${result.valid}`,
        );
      }

      const actualErrorFields = result.errors.map((e) => e.field).sort();
      const expectedErrorFields = [...expected.errors].sort();
      if (
        actualErrorFields.length !== expectedErrorFields.length ||
        actualErrorFields.some((f, i) => f !== expectedErrorFields[i])
      ) {
        mismatches.push(
          `${result.filepath}: error fields mismatch — expected [${expectedErrorFields.join(', ')}], got [${actualErrorFields.join(', ')}]`,
        );
      }

      const actualWarningFields = result.warnings.map((w) => w.field).sort();
      const expectedWarningFields = [...expected.warnings].sort();
      if (
        actualWarningFields.length !== expectedWarningFields.length ||
        actualWarningFields.some((f, i) => f !== expectedWarningFields[i])
      ) {
        mismatches.push(
          `${result.filepath}: warning fields mismatch — expected [${expectedWarningFields.join(', ')}], got [${actualWarningFields.join(', ')}]`,
        );
      }
    }

    if (mismatches.length > 0) {
      throw new Error(`\n  - ${mismatches.join('\n  - ')}`);
    }
  });

  test('summary numbers match the expectations totals', () => {
    const expectedInvalid = Object.values(expectations).filter(
      (e) => !e.valid,
    ).length;
    const expectedErrors = Object.values(expectations).reduce(
      (n, e) => n + e.errors.length,
      0,
    );
    const expectedWarnings = Object.values(expectations).reduce(
      (n, e) => n + e.warnings.length,
      0,
    );

    expect(report.summary.invalid).toBe(expectedInvalid);
    expect(report.summary.errorCount).toBe(expectedErrors);
    expect(report.summary.warningCount).toBe(expectedWarnings);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Coverage assertion: every diagnostic KIND the validator can emit must be
  // exercised by at least one fixture. When someone adds a new diagnostic kind
  // to lib/validators.js, this test fails until the example vault gains a
  // fixture that demonstrates it. Manual maintenance (the matcher list below)
  // is the explicit tradeoff for not having to parse JS source.
  //
  // Kinds intentionally NOT in this list:
  //   - `path-regex-bad-regex` — would require a template with a malformed
  //     regex; out of scope for an authoring-mistake-focused example.
  //   - `bundle-readme-template-mismatch` — requires a template whose
  //     `path_regex` declares a bundle pattern; the example uses flat-file
  //     templates.
  //   - "Failed to parse" frontmatter — diagnostic has no `field`, breaks the
  //     field-code expectations contract. Could be added with a sentinel but
  //     the value-per-cost is low.
  // Document any future skip here.
  // ──────────────────────────────────────────────────────────────────────────
  const DIAGNOSTIC_KINDS = [
    {
      name: 'missing template field',
      match: (i) =>
        i.field === 'template' && /Missing required template field/.test(i.message),
    },
    {
      name: 'required_fields missing',
      match: (i) => /Required field '.+' is missing/.test(i.message),
    },
    {
      name: 'field_rules regex mismatch',
      match: (i) => /does not match pattern/.test(i.message),
    },
    {
      name: 'field_rules values (enum) mismatch',
      match: (i) => /is not in allowed values/.test(i.message),
    },
    {
      name: 'field_rules type:integer',
      match: (i) => /Expected type/.test(i.message),
    },
    {
      name: 'field_rules min (below minimum)',
      match: (i) => /is less than minimum/.test(i.message),
    },
    {
      name: 'conditional_required_fields (required:true, frontmatter)',
      match: (i) => i.error_type === 'required-missing' && /Required field '.+' is missing/.test(i.message),
    },
    {
      name: 'conditional_required_fields (min_count)',
      match: (i) => /is less than minimum/.test(i.message) && i.error_type === 'min-violation',
    },
    {
      name: 'conditional_required_fields (severity:warning)',
      match: (i) =>
        i.level === 'warning' && /Required field '.+' is missing/.test(i.message),
    },
    {
      name: 'conditional body-section required (when gate)',
      match: (i) => i.error_type === 'required-missing' && /Required section '.+' is missing/.test(i.message),
    },
    {
      name: 'path_regex mismatch',
      match: (i) => i.error_type === 'pattern-mismatch',
    },
    {
      name: 'template-meta leak warning',
      match: (i) => /Template-only field/.test(i.message),
    },
    {
      name: 'unresolvable template',
      match: (i) => /Cannot load schema/.test(i.message),
    },
    {
      name: 'broken frontmatter relationship link',
      match: (i) => /^Broken link/.test(i.message),
    },
    {
      name: 'filename slug violation',
      match: (i) =>
        i.field === 'filename' && /violates slug convention/.test(i.message),
    },
  ];

  test('every diagnostic kind has at least one fixture', () => {
    const allIssues = report.results.flatMap((r) => [
      ...(r.errors || []).map((e) => ({ ...e, level: 'error' })),
      ...(r.warnings || []).map((w) => ({ ...w, level: 'warning' })),
    ]);

    const uncovered = DIAGNOSTIC_KINDS.filter(
      (kind) => !allIssues.some(kind.match),
    );

    if (uncovered.length > 0) {
      const names = uncovered.map((k) => `  - ${k.name}`).join('\n');
      throw new Error(
        `No fixture in examples/example/ exercises the following diagnostic kinds — add one (and an expectations.json entry) per kind:\n${names}`,
      );
    }
  });
});
