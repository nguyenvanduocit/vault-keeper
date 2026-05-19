/**
 * Reusability proof — the engine is genuinely vault-agnostic, not a cosmetic
 * rename whose default is still hardcoded `product-knowledge`.
 *
 * Builds a throwaway mini-vault in a tmpdir whose `.claude/vault-keeper.json`
 * sets `vaultRoot: "docs"` (NOT product-knowledge), drops a minimal templated
 * doc under `docs/`, then asserts that validate-documents.js (invoked with
 * --root <tmp>) scans `docs/`, finds + validates the doc there, and does NOT
 * look for `product-knowledge/`.
 *
 * This test MUST fail if anyone reverts a `product-knowledge` literal back
 * into the scan path (it pins the genericization, not just the config
 * primitive).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = resolve(import.meta.dir, '..');
const VALIDATE = join(REPO, 'cli', 'validate-documents.js');

let vault;

// Minimal template with a validation_rules block: required `title`, an
// allowed_folders regex, and the body Relationships section the engine knows.
const MINI_TEMPLATE = `---
template_path: templates/note-template.md
document_type: note
validation_rules:
  tier: KNOWLEDGE
  required_fields: [template, document_type, title, owner]
  allowed_folders: "^docs/notes/"
---

# Note Template

\`\`\`yaml section-rules
relationships:
  required: false
\`\`\`

## Relationships
`;

// A valid instance doc that lives under docs/notes/ (NOT product-knowledge/).
const MINI_DOC = `---
template: templates/note-template.md
document_type: note
title: Hello Generic Vault
owner: '@alice'
---

# Hello Generic Vault

A doc that proves the engine scans a configured \`vaultRoot\` of "docs".

## Relationships
`;

beforeAll(() => {
  vault = realpathSync(mkdtempSync(join(tmpdir(), 'vk-reuse-')));

  mkdirSync(join(vault, '.claude'), { recursive: true });
  writeFileSync(
    join(vault, '.claude', 'vault-keeper.json'),
    JSON.stringify(
      { vaultRoot: 'docs', vaultFolders: ['docs'] },
      null,
      2,
    ),
  );

  // CLAUDE.md so resolveProjectRoot's walk-up has a marker (also realistic).
  writeFileSync(join(vault, 'CLAUDE.md'), '# Generic vault\n');

  mkdirSync(join(vault, 'templates'), { recursive: true });
  writeFileSync(join(vault, 'templates', 'note-template.md'), MINI_TEMPLATE);

  mkdirSync(join(vault, 'docs', 'notes'), { recursive: true });
  writeFileSync(join(vault, 'docs', 'notes', 'note-001-hello.md'), MINI_DOC);

  // Deliberately NO product-knowledge/ dir — if the engine still hardcodes it
  // the scan finds zero docs and the assertions below fail.
});

afterAll(() => {
  if (vault) rmSync(vault, { recursive: true, force: true });
});

describe('reusability — configured vaultRoot=docs', () => {
  test('validate-documents.js --root scans docs/, not product-knowledge/', () => {
    const out = execFileSync(
      'bun',
      [VALIDATE, '--root', vault, '--json'],
      { cwd: REPO, encoding: 'utf-8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.summary.total).toBeGreaterThan(0);

    const paths = parsed.results.map((r) => r.filepath || r.file || '');
    // The configured vault doc is found under docs/.
    expect(paths.some((p) => p.includes('docs/notes/note-001-hello.md'))).toBe(
      true,
    );
    // No result path is rooted at product-knowledge/ (engine did not fall
    // back to the old literal).
    expect(paths.some((p) => p.includes('product-knowledge/'))).toBe(false);

    // The doc validates clean against its template (proves template
    // resolution also followed --root, not cwd).
    const docResult = parsed.results.find((r) =>
      (r.filepath || r.file || '').includes('note-001-hello.md'),
    );
    expect(docResult).toBeDefined();
    expect(docResult.valid).toBe(true);
  });
});
