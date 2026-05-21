/**
 * Integration test for measure.js — builds a tiny vault on disk and asserts
 * the EntropyReport shape end-to-end.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureEntropy } from '../../lib/entropy/measure.js';
import { _resetVaultConfigCache } from '../../lib/vault-config.js';

let tmp;
beforeEach(() => {
  _resetVaultConfigCache();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-measure-')));
});
afterEach(() => {
  _resetVaultConfigCache();
  rmSync(tmp, { recursive: true, force: true });
});

const VK_CONFIG = JSON.stringify({
  vaultRoot: '.',
  vaultFolders: ['notes'],
  entropy: {},
});

const TEMPLATE = `---
template_path: templates/note-template.md
document_type: note
fields:
  title:
    type: string
    required: true
  status:
    type: string
    enum: [draft, review, done]
---

# Note template

\`\`\`yaml section-rules
required: false
\`\`\`

## Reflections
`;

function writeDoc(name, fm, body = '') {
  writeFileSync(
    join(tmp, 'notes', name),
    `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}`,
  );
}

describe('measureEntropy — integration', () => {
  test('returns full EntropyReport shape on a populated vault', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'vault-keeper.json'), VK_CONFIG);
    mkdirSync(join(tmp, 'templates'), { recursive: true });
    writeFileSync(join(tmp, 'templates', 'note-template.md'), TEMPLATE);
    mkdirSync(join(tmp, 'notes'), { recursive: true });

    writeDoc('a.md', { template: 'templates/note-template.md', title: 'A', status: 'draft' });
    writeDoc('b.md', { template: 'templates/note-template.md', title: 'B', status: 'done' });

    const report = await measureEntropy({ vaultRoot: tmp });

    expect(report.schema_version).toBe(1);
    expect(typeof report.measured_at).toBe('string');
    expect(report.vault_root).toBe(tmp);
    expect(typeof report.overall_score).toBe('number');
    expect(report.dimensions.schema).toBeDefined();
    expect(report.dimensions.vocab).toBeDefined();
    expect(report.dimensions.lifecycle).toBeDefined();
    expect(report.dimensions.distribution).toBeDefined();
    expect(Array.isArray(report.emergence.field_candidates)).toBe(true);
    expect(report.stats.total_docs).toBe(2);
  });

  test('empty vault → safe nulls', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'vault-keeper.json'), VK_CONFIG);
    mkdirSync(join(tmp, 'notes'), { recursive: true });

    const report = await measureEntropy({ vaultRoot: tmp });
    expect(report.stats.total_docs).toBe(0);
    expect(report.overall_score).toBe(null);
  });

  test('default excludePatterns drop README.md from the count', async () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'vault-keeper.json'), VK_CONFIG);
    mkdirSync(join(tmp, 'templates'), { recursive: true });
    writeFileSync(join(tmp, 'templates', 'note-template.md'), TEMPLATE);
    mkdirSync(join(tmp, 'notes'), { recursive: true });

    writeDoc('a.md', { template: 'templates/note-template.md', title: 'A', status: 'draft' });
    writeDoc('README.md', { template: 'templates/note-template.md', title: 'R', status: 'draft' });

    const report = await measureEntropy({ vaultRoot: tmp });
    // README.md is in default excludePatterns ('**/README.md'); only a.md counts.
    expect(report.stats.total_docs).toBe(1);
  });
});
