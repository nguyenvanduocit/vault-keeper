#!/usr/bin/env node
/**
 * Document validation orchestrator.
 *
 * Scans the configured vault root, parses each markdown doc's frontmatter via
 * gray-matter, resolves its declared `template:` to load the composable field
 * schema from that template's frontmatter, then enforces it generically via
 * the schema engine (`applyFieldSchema` / `applyBodySchema`).
 *
 * The plugin owns no per-doc-type knowledge — folder-placement, required
 * fields, conditional rules, state machines, sections, body section-rules
 * all come from the template the document points to.
 *
 * Usage:
 *   bun cli/validate-documents.js [options]
 *
 * Options:
 *   --root <path>     Vault project root (else CLAUDE_PROJECT_DIR, else
 *                     walk-up from cwd). Resolved via lib/vault-config.js.
 *   --path <path>     Validate specific file or folder
 *   --strict          Fail on warnings (CI mode)
 *   --json            Output results as JSON
 */

import { stat } from 'fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { resolveProjectRoot } from '../lib/vault-config.js';
import { parseDocument, resolveDocPath } from '../lib/doc-io.js';
import { loadTemplateRules } from '../lib/template-rules.js';
import { applyFieldSchema, applyBodySchema } from '../lib/schema-engine.js';
import {
  CONFIG,
  inferDocType,
  isTemplateFile,
  isTemplateInstance,
  findTemplateMetaLeaks,
  validateTemplateField,
  validateTemplateMetaLeak,
  suggestSlug,
  validateSlug,
  stripCodeRegions,
  validatePaths,
  validateSectionRulesLeak,
} from '../lib/validators.js';

// stripCodeRegions, validatePaths → imported from ../lib/validators.js above.

/**
 * Validate link existence for frontmatter.relationships.
 *
 * The vault graph is directed-only: every typed predicate points
 * downstream → upstream, and backlinks are computed by scanning outgoing edges
 * at query time, not stored on the upstream doc. There is no bidirectional
 * symmetry to enforce. The only structural check left for frontmatter edges
 * is: the target file actually exists on disk.
 *
 * Body relationships (the source of truth) get path resolution
 * via `resolveDocPath()` inside V1 — unresolvable body paths there are
 * already surfaced by V1's type-pair check. This function covers the legacy
 * frontmatter.relationships keys that haven't been migrated to body yet.
 */
async function validateLinkExistence(frontmatter, _filepath) {
  const issues = [];
  if (!frontmatter.relationships) return issues;

  for (const [type, items] of Object.entries(frontmatter.relationships)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item?.path) continue;
      // Strip `#anchor` before checking file existence — `resolveDocPath`
      // already encodes this convention and V3/V1/incoming-graph all honour
      // it. Without this, `foo.md#AC1` is treated as a literal filename and
      // every anchored frontmatter edge gets a false "Broken link" error.
      const resolved = resolveDocPath(item.path);
      if (!resolved) continue;
      const linkedDoc = await parseDocument(join(process.cwd(), resolved));
      if (linkedDoc.error) {
        issues.push({
          level: 'error',
          field: `relationships.${type}`,
          message: `Broken link: ${item.path}`,
          fix: 'Update or remove the broken link',
        });
      }
    }
  }
  return issues;
}

/**
 * Validate a single document.
 *
 * Flow:
 *   1. Skip templates (path-based, before any I/O — placeholders in template
 *      YAML may not parse and that is by design).
 *   2. Parse the file.
 *   3. Run cross-cutting validators that don't depend on per-doc-type rules
 *      (template field shape, naming pattern, path absoluteness, bidirectional
 *      links).
 *   4. Resolve the doc's template (`frontmatter.template`) and load its
 *      composable field schema. If the template can't be resolved, emit an
 *      actionable error and skip schema-driven validation — we cannot
 *      validate against an unknown schema.
 *   5. Surface any template meta-validation errors, then run
 *      `applyFieldSchema` (frontmatter) and `applyBodySchema` (body).
 *
 * `options.projectRoot` lets tests load fixture templates from a sandbox dir
 * rather than process.cwd().
 */
async function validateDocument(filepath, options = {}) {
  if (isTemplateFile(filepath)) {
    return {
      filepath,
      docType: 'template',
      valid: true,
      skipped: true,
      errors: [],
      warnings: [],
      frontmatter: {},
    };
  }

  const doc = await parseDocument(filepath);
  if (doc.error) {
    return {
      filepath,
      valid: false,
      errors: [{ level: 'error', message: `Failed to parse: ${doc.error}` }],
      warnings: [],
    };
  }

  const fm = doc.frontmatter;
  const allIssues = [];

  // Cross-cutting validators (independent of doc type / template rules)
  allIssues.push(...validateTemplateField(fm, filepath));
  allIssues.push(...validateTemplateMetaLeak(fm, filepath));
  allIssues.push(...validateSlug(filepath));
  allIssues.push(...validatePaths(fm, doc.body));
  allIssues.push(...validateSectionRulesLeak(doc.body));
  allIssues.push(...await validateLinkExistence(fm, filepath));

  // Template-driven rules. loadTemplateRules returns null when the template
  // cannot be resolved — file missing, malformed YAML, or unparseable
  // frontmatter. Without a schema we cannot validate; emit an actionable error
  // and skip rule-dependent validators. Cross-cutting validators (above) keep
  // their results — they don't depend on template rules. The missing-template
  // case is already covered by validateTemplateField, so we only synthesize an
  // error here when the template field IS set but loading still failed.
  const rules = await loadTemplateRules(fm.template, options.projectRoot);
  if (!rules) {
    if (fm.template) {
      allIssues.push({
        level: 'error',
        field: 'template',
        message: `Cannot load schema from template '${fm.template}' — file not found or malformed YAML`,
        fix: `Verify '${fm.template}' exists (relative to repo root) and contains valid frontmatter. See templates/README.md for the template registry.`,
      });
    }
  } else {
    // Surface template meta-validation issues (malformed field specs, etc.)
    if (rules.templateErrors?.length) {
      allIssues.push(...rules.templateErrors);
    }

    // Construct docMeta for the schema engine. repoRelativePath is
    // POSIX-normalized so regexes authored on macOS/Linux match on Windows.
    const projectRoot = options.projectRoot || process.cwd();
    const docMeta = {
      repoRelativePath: relative(projectRoot, filepath).split(/[\\/]/).join('/'),
      fileExists: (relPath) => existsSync(join(projectRoot, relPath)),
    };

    // Frontmatter field validation (includes synthetic $path via the engine).
    if (rules.fields) {
      allIssues.push(...applyFieldSchema(
        { fields: rules.fields, strict: rules.strict },
        fm,
        docMeta,
      ));
    }

    // Body section-rules validation.
    if (rules.bodySchema?.length) {
      allIssues.push(...applyBodySchema(rules.bodySchema, doc.body, docMeta));
    }
  }

  // Bundle README template mismatch.
  // Path matches some content template's bundle regex but the doc's
  // template field is missing or set to folder-readme-template. Without
  // this synthesized error the doc would either silently skip validation
  // or pass folder-readme-template's permissive `^.+/README\\.md$` regex.
  const normalizedPath = filepath.replace(/\\/g, '/');
  const expectedBundleTemplates = _bundleMismatchMap.get(normalizedPath);
  if (expectedBundleTemplates && expectedBundleTemplates.length > 0) {
    const actual = fm.template || '<missing>';
    allIssues.push({
      level: 'error',
      field: 'template',
      error_type: 'bundle-readme-template-mismatch',
      message: `Bundle README has wrong template "${actual}". This path matches a content template's bundle pattern. Expected one of: ${expectedBundleTemplates.join(', ')}.`,
      fix: `Set frontmatter "template:" to one of: ${expectedBundleTemplates.join(' OR ')}. folder-readme-template is for category folder READMEs only — bundle root READMEs must declare the content template. See vault.create-file SKILL.md § "Bundle pre-flight checklist".`,
    });
  }

  const errors = allIssues.filter((i) => i.level === 'error');
  const warnings = allIssues.filter((i) => i.level === 'warning');

  return {
    filepath,
    docType: inferDocType(fm),
    valid: errors.length === 0,
    errors,
    warnings,
    rulesSource: null,
    frontmatter: {
      template: fm.template,
      status: fm.status,
      owner: fm.owner,
    },
  };
}

/**
 * Bundle-mismatch detector state.
 *
 * When a `<id>/README.md` sits at a path that some content template's
 * `$path.pattern` accepts as a bundle root, but the doc's own `template:`
 * field is missing or set to `folder-readme-template`, the doc would
 * otherwise silently escape schema validation (folder-readme-template's
 * regex is permissive — matches any `/README.md`).
 *
 * `findBundleReadmes()` populates this map at scan time; `validateDocument()`
 * consults it and synthesizes a `bundle-readme-template-mismatch` error.
 * Generic / template-driven — no hardcoded vault paths.
 */
const _bundleMismatchMap = new Map(); // normalizedFilepath -> string[] candidate templates
let _bundleTemplatePatternsCache = null;

async function loadContentTemplateBundlePatterns(projectRoot = process.cwd()) {
  if (_bundleTemplatePatternsCache) return _bundleTemplatePatternsCache;
  const patterns = [];
  const tmplFiles = glob.sync('templates/*-template.md', { cwd: projectRoot });
  for (const tf of tmplFiles) {
    // folder-readme-template's path pattern is permissive by design —
    // exclude it so it never serves as the "expected" bundle template.
    if (tf.endsWith('folder-readme-template.md')) continue;
    const rules = await loadTemplateRules(tf, projectRoot);
    // Extract the path pattern from the composable $path field.
    // The `pattern` primitive can be shorthand (string) or expanded ({ value }).
    const rawPattern = rules?.fields?.$path?.pattern;
    const pathRegex = typeof rawPattern === 'string'
      ? rawPattern
      : typeof rawPattern === 'object' && rawPattern !== null
        ? rawPattern.value
        : null;
    if (!pathRegex) continue;
    // Only collect templates whose regex actually advertises bundle support
    // (has a `/README\.md` alternative). Flat-only templates are skipped.
    if (!pathRegex.includes('/README\\.md')) continue;
    try {
      patterns.push({
        template: `templates/${tf.split('/').pop()}`,
        regex: new RegExp(pathRegex),
      });
    } catch {
      // Invalid regex — applyFieldSchema surfaces this elsewhere.
    }
  }
  _bundleTemplatePatternsCache = patterns;
  return patterns;
}

/**
 * Bundle README re-include.
 *
 * `**\/README.md` is globally excluded as folder-orientation noise. When a
 * README.md sits at the top of a bundle folder (folder-as-page pattern) and
 * declares a `template:` field pointing to a content template (anything other
 * than `folder-readme-template`), it IS a canonical vault document and must
 * be validated.
 *
 * Generic: no hardcoded paths or discipline names. The document's own
 * `template:` field decides whether it's bundle canonical content. Any
 * template whose `$path.pattern` permits a `/README.md$` suffix automatically
 * opts into this mechanism.
 *
 * Pass 4 (bundle enforcement): when a README's path matches some
 * content template's bundle regex but its template field is missing or set to
 * folder-readme-template, INCLUDE it anyway and record the mismatch — the
 * synthesized error then fires from validateDocument(). Prevents silent
 * skip on bundle conversions gone wrong (e.g. `git mv foo.md foo/README.md`
 * without updating template:).
 *
 * Scope: scans `**\/README.md` under CONFIG.contentFolders only — does not
 * touch the global `**\/README.md` exclusion in CONFIG.excludePatterns.
 * Templates and node_modules are still respected (template README, source
 * repo README, etc. don't get inadvertently validated).
 */
async function findBundleReadmes(projectRoot = process.cwd()) {
  const readmes = [];
  _bundleMismatchMap.clear();
  const bundlePatterns = await loadContentTemplateBundlePatterns(projectRoot);
  // Exclude non-README excludes (codebase/, node_modules/, etc.) but allow
  // README.md itself through this scan.
  const ignore = CONFIG.excludePatterns.filter((p) => p !== '**/README.md');
  for (const folder of CONFIG.contentFolders) {
    const candidates = glob.sync(`${folder}/**/README.md`, { ignore });
    for (const candidate of candidates) {
      try {
        const doc = await parseDocument(candidate);
        const tmpl = doc?.frontmatter?.template;

        // Pass 4: detect bundle mismatch BEFORE the silent-skip branches.
        // Match candidate path against every content template's bundle regex,
        // but only count BUNDLE-SPECIFIC matches — exclude templates whose
        // flat alternative `[^/]+\.md` happens to also match `README.md` as
        // a flat-named file. Probe: if replacing README.md with a non-README
        // basename ALSO matches, the regex doesn't care it's named
        // README.md → it's a flat form, not a bundle form. Skip.
        const normalized = candidate.replace(/\\/g, '/');
        const flatProbe = normalized.replace(/README\.md$/, '__not_readme_probe__.md');
        const matchingContentTemplates = bundlePatterns
          .filter((p) => p.regex.test(normalized) && !p.regex.test(flatProbe))
          .map((p) => p.template);
        const hasNoUsefulTemplate =
          !tmpl || tmpl === 'templates/folder-readme-template.md';

        if (matchingContentTemplates.length > 0 && hasNoUsefulTemplate) {
          _bundleMismatchMap.set(normalized, matchingContentTemplates);
          readmes.push(candidate);
          continue;
        }

        if (!tmpl) continue;
        // folder-readme-template stays excluded — those README.md files are
        // folder-orientation, not bundle canonical content.
        if (tmpl === 'templates/folder-readme-template.md') continue;
        readmes.push(candidate);
      } catch {
        // Unparseable README.md = not a vault document; skip silently.
      }
    }
  }
  return readmes;
}

/**
 * Find all documents to validate
 */
async function findDocuments(targetPath) {
  const documents = [];

  if (targetPath) {
    // Validate specific path
    const pathStat = await stat(targetPath);
    if (pathStat.isFile() && targetPath.endsWith('.md')) {
      documents.push(targetPath);
    } else if (pathStat.isDirectory()) {
      const files = glob.sync(`${targetPath}/**/*.md`, {
        ignore: CONFIG.excludePatterns
      });
      documents.push(...files);
    }
  } else {
    // Validate all content folders
    for (const folder of CONFIG.contentFolders) {
      const files = glob.sync(`${folder}/**/*.md`, {
        ignore: CONFIG.excludePatterns
      });
      documents.push(...files);
    }
  }

  // Generic bundle README re-include (folder-as-page
  // pattern). Driven entirely by each document's own `template:` field.
  const bundleReadmes = await findBundleReadmes();
  for (const readme of bundleReadmes) {
    if (!documents.includes(readme)) {
      documents.push(readme);
    }
  }

  return documents;
}

/**
 * Enumerate every file under the slug-scan scope (content folders +
 * templates/) regardless of extension. Used by the slug pass so non-md
 * assets (images, json, html, yaml) still have to follow the naming rule.
 *
 * Templates are included because their filenames flow into URLs and grep
 * the same way content does — but their CONTENT is intentionally skipped
 * by validateDocument (placeholders are not real authoring).
 */
async function findAllFiles(targetPath) {
  const files = [];
  const ignore = CONFIG.excludePatterns;

  if (targetPath) {
    const pathStat = await stat(targetPath);
    if (pathStat.isFile()) {
      files.push(targetPath);
    } else if (pathStat.isDirectory()) {
      files.push(...glob.sync(`${targetPath}/**/*`, { ignore, nodir: true }));
    }
    return files;
  }

  const roots = [
    ...CONFIG.contentFolders,
    CONFIG.templateFolder,
  ];
  for (const root of roots) {
    files.push(...glob.sync(`${root}/**/*`, { ignore, nodir: true }));
  }

  // Generic bundle README re-include. See
  // findBundleReadmes() above — driven by each doc's own `template:` field,
  // no hardcoded paths.
  const bundleReadmes = await findBundleReadmes();
  for (const readme of bundleReadmes) {
    if (!files.includes(readme)) {
      files.push(readme);
    }
  }

  return files;
}

/**
 * Generate summary statistics
 */
function generateSummary(validationResults) {
  const summary = {
    total: validationResults.length,
    skipped: validationResults.filter(r => r.skipped).length,
    valid: validationResults.filter(r => r.valid && !r.skipped).length,
    invalid: validationResults.filter(r => !r.valid).length,
    errorCount: validationResults.reduce((sum, r) => sum + r.errors.length, 0),
    warningCount: validationResults.reduce((sum, r) => sum + r.warnings.length, 0),

    byDocType: {},
    byFolder: {},
    commonIssues: {}
  };

  // Group by document type
  validationResults.forEach(result => {
    const docType = result.docType || 'unknown';
    if (!summary.byDocType[docType]) {
      summary.byDocType[docType] = { total: 0, valid: 0, invalid: 0 };
    }
    summary.byDocType[docType].total++;
    if (result.valid) {
      summary.byDocType[docType].valid++;
    } else {
      summary.byDocType[docType].invalid++;
    }
  });

  // Group by folder
  validationResults.forEach(result => {
    const folder = dirname(result.filepath).split('/').slice(0, 3).join('/');
    if (!summary.byFolder[folder]) {
      summary.byFolder[folder] = { total: 0, valid: 0, invalid: 0 };
    }
    summary.byFolder[folder].total++;
    if (result.valid) {
      summary.byFolder[folder].valid++;
    } else {
      summary.byFolder[folder].invalid++;
    }
  });

  // Count common issues
  validationResults.forEach(result => {
    [...result.errors, ...result.warnings].forEach(issue => {
      const key = `${issue.field}: ${issue.message.split(':')[0]}`;
      summary.commonIssues[key] = (summary.commonIssues[key] || 0) + 1;
    });
  });

  return summary;
}

/**
 * Print results to console
 */
function printResults(validationResults, summary, options = {}) {
  console.log('\n' + '='.repeat(60));
  console.log('VAULT TEMPLATE VALIDATION REPORT');
  console.log('='.repeat(60));

  // Summary — compliance rate excludes skipped templates (they're scaffolds, not docs)
  const validatedCount = summary.total - summary.skipped;
  console.log(`\n📊 SUMMARY`);
  console.log(`Total Documents: ${summary.total}`);
  if (summary.skipped > 0) {
    console.log(`⏭️  Skipped (templates): ${summary.skipped}`);
  }
  if (validatedCount > 0) {
    const complianceRate = ((summary.valid / validatedCount) * 100).toFixed(1);
    console.log(`✅ Valid: ${summary.valid}/${validatedCount} (${complianceRate}%)`);
  } else {
    console.log(`✅ Valid: 0/0 (no content documents to validate)`);
  }
  console.log(`❌ Invalid: ${summary.invalid}`);
  console.log(`⚠️  Warnings: ${summary.warningCount}`);
  console.log(`🚨 Errors: ${summary.errorCount}`);

  // By Document Type
  console.log(`\n📁 BY DOCUMENT TYPE`);
  for (const [type, stats] of Object.entries(summary.byDocType)) {
    const rate = ((stats.valid / stats.total) * 100).toFixed(1);
    const icon = stats.invalid === 0 ? '✅' : '⚠️';
    console.log(`${icon} ${type}: ${stats.valid}/${stats.total} (${rate}%)`);
  }

  // Common Issues
  console.log(`\n🔍 TOP ISSUES`);
  const topIssues = Object.entries(summary.commonIssues)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  topIssues.forEach(([issue, count]) => {
    console.log(`   ${count}x - ${issue}`);
  });

  // Document-level issues
  if (summary.invalid > 0) {
    console.log(`\n❌ INVALID DOCUMENTS (${summary.invalid})`);
    validationResults
      .filter(r => !r.valid)
      .forEach(result => {
        console.log(`\n📄 ${relative(process.cwd(), result.filepath)}`);
        result.errors.forEach(error => {
          console.log(`   🚨 ${error.field}: ${error.message}`);
          if (error.fix) {
            console.log(`      💡 Fix: ${error.fix}`);
          }
        });
      });
  }

  // Warnings (if not in strict mode)
  if (!options.strict && summary.warningCount > 0) {
    console.log(`\n⚠️  WARNINGS`);
    validationResults
      .filter(r => r.warnings.length > 0)
      .forEach(result => {
        console.log(`\n📄 ${relative(process.cwd(), result.filepath)}`);
        result.warnings.forEach(warning => {
          console.log(`   ⚠️  ${warning.field}: ${warning.message}`);
        });
      });
  }

  // Success message
  if (summary.invalid === 0) {
    console.log(`\n✅ All documents are compliant!`);
  }

  console.log('\n' + '='.repeat(60));
}

/**
 * Main execution.
 *
 * Accepts an explicit argv array so the multi-tool (`cli/main.js`) can
 * dispatch into this entry point after consuming its own subcommand
 * positional arg. Defaults to `process.argv.slice(2)` for direct invocation.
 */
async function main(argv = process.argv.slice(2)) {
  const args = argv;
  const options = {
    path: args.includes('--path') ? args[args.indexOf('--path') + 1] : null,
    strict: args.includes('--strict'),
    json: args.includes('--json')
  };

  // Resolve the vault project root (--root / CLAUDE_PROJECT_DIR / walk-up)
  // and chdir into it BEFORE any scan. This file derives every path from
  // process.cwd() (globs in findDocuments/findAllFiles, loadTemplateRules'
  // default projectRoot, the lazy loadVaultConfig() behind
  // CONFIG.contentFolders/excludePatterns, and relative()
  // calls). chdir is the single, explicit rebind point.
  const cliRoot = args.includes('--root')
    ? args[args.indexOf('--root') + 1]
    : undefined;
  const resolvedRoot = resolveProjectRoot({ root: cliRoot });
  process.chdir(resolvedRoot);
  // chdir alone is not enough: the lazy no-arg loadVaultConfig() behind
  // CONFIG.contentFolders calls resolveProjectRoot() with no opts, whose
  // STABLE-marker walk-up (`.git` tier first) escapes the chdir'd cwd when
  // the vault is nested inside a parent git repo. Pinning CLAUDE_PROJECT_DIR
  // — checked BEFORE the walk-up in vault-config.js — makes every downstream
  // resolver agree with the root we just chdir'd into.
  process.env.CLAUDE_PROJECT_DIR = resolvedRoot;

  try {
    // Find documents
    const documents = await findDocuments(options.path);

    if (documents.length === 0) {
      console.log('No documents found to validate');
      process.exit(0);
    }

    // Keep --json output pure: pollution on stdout breaks any JSON parser
    // consuming `bun run validate:json` (vault:gate's python step in CI is
    // the immediate caller; the contract is "stdout is JSON or nothing").
    if (!options.json) {
      console.log(`🔍 Validating ${documents.length} documents...`);
    }

    // Validate all documents
    const validationResults = await Promise.all(
      documents.map((doc) => validateDocument(doc)),
    );

    // Slug pass over non-md assets (images, json, html, yaml, etc.) — the
    // .md path through validateDocument already covers their basenames and
    // every folder segment leading to them, but free-standing assets only
    // surface through this dedicated scan.
    const allFiles = await findAllFiles(options.path);
    const mdSet = new Set(documents);
    for (const filepath of allFiles) {
      if (mdSet.has(filepath)) continue;       // already covered above
      if (filepath.endsWith('.md')) continue;  // .md handled by validateDocument
      const slugIssues = validateSlug(filepath);
      if (slugIssues.length === 0) continue;
      const errors = slugIssues.filter((i) => i.level === 'error');
      const warnings = slugIssues.filter((i) => i.level === 'warning');
      validationResults.push({
        filepath,
        docType: 'asset',
        valid: errors.length === 0,
        skipped: false,
        errors,
        warnings,
        frontmatter: {},
      });
    }

    // Generate summary
    const summary = generateSummary(validationResults);

    // Output results
    if (options.json) {
      console.log(JSON.stringify({ summary, results: validationResults }, null, 2));
    } else {
      printResults(validationResults, summary, options);
    }

    // Exit code based on results
    if (summary.invalid > 0 || (options.strict && summary.warningCount > 0)) {
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Validation failed:', error.message);
    process.exit(1);
  }
}

// Run if invoked directly. `process.argv[1]` is the symlink path under
// `node_modules/.bin/`, so we resolve it to the real path before comparing
// against `import.meta.url` (which is always the realpath of this module).
function __isDirectEntry() {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg1)).href;
  } catch {
    return false;
  }
}
if (__isDirectEntry()) {
  main();
}

// Export for use in other scripts and tests.
// Pure validators (no FS) are exported individually so unit tests can call
// them with inline frontmatter objects without needing fixture files.
export {
  // High-level orchestrators
  main,
  validateDocument,
  findDocuments,
  findAllFiles,
  parseDocument,
  // Pure validators (no I/O)
  validateTemplateField,
  validateTemplateMetaLeak,
  validateSlug,
  suggestSlug,
  validatePaths,
  validateSectionRulesLeak,
  // FS-touching validators
  validateLinkExistence,
  // Helpers
  isTemplateFile,
  isTemplateInstance,
  findTemplateMetaLeaks,
  resolveDocPath,
  inferDocType,
  stripCodeRegions,
  // Config (read-only — exposed for tests asserting against canonical rules)
  CONFIG,
};