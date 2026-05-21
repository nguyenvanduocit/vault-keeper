/**
 * End-to-end test for `vault-keeper entropy` CLI.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let tmp;
const CLI = join(import.meta.dir, '..', 'cli', 'main.js');

beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-cli-ent-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/**
 * Spawn the CLI with parent-process env scrubbed of vault-resolving vars.
 *
 * CLAUDE_PROJECT_DIR / VAULT_KEEPER_CONFIG leak into the child via the
 * default env inheritance — every test here passes `--root tmp` so the
 * misroute doesn't actually fire today, but a CI runner or developer
 * shell that has either var set would silently read the wrong config and
 * mask the bug we're trying to test. Defense-in-depth.
 */
function runCli(args) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.VAULT_KEEPER_CONFIG;
  return spawnSync('node', [CLI, ...args], { encoding: 'utf-8', env });
}

function setupVault() {
  mkdirSync(join(tmp, '.claude'), { recursive: true });
  writeFileSync(
    join(tmp, '.claude', 'vault-keeper.json'),
    JSON.stringify({ vaultRoot: '.', vaultFolders: ['notes'] }),
  );
  mkdirSync(join(tmp, 'templates'), { recursive: true });
  writeFileSync(
    join(tmp, 'templates', 'note-template.md'),
    `---
template_path: templates/note-template.md
document_type: note
fields:
  title: { type: string, required: true }
  status: { type: string, enum: [draft, done] }
---
# Note
\`\`\`yaml section-rules
required: false
\`\`\`
## Reflections
`,
  );
  mkdirSync(join(tmp, 'notes'), { recursive: true });
  writeFileSync(
    join(tmp, 'notes', 'a.md'),
    `---\ntemplate: templates/note-template.md\ntitle: A\nstatus: draft\n---\n# A\n`,
  );
  writeFileSync(
    join(tmp, 'notes', 'b.md'),
    `---\ntemplate: templates/note-template.md\ntitle: B\nstatus: done\n---\n# B\n`,
  );
}

describe('vault-keeper entropy', () => {
  test('--json emits valid EntropyReport, exit 0, writes snapshot', () => {
    setupVault();
    const r = runCli(['entropy', '--json', '--root', tmp]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.stats.total_docs).toBe(2);
    expect(existsSync(join(tmp, '.vault-keeper', 'snapshots', 'latest.json'))).toBe(true);
  });

  test('--no-snapshot does not persist', () => {
    setupVault();
    const r = runCli(['entropy', '--json', '--no-snapshot', '--root', tmp]);
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, '.vault-keeper'))).toBe(false);
  });

  test('human output without --json', () => {
    setupVault();
    const r = runCli(['entropy', '--root', tmp]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Overall health');
    expect(r.stdout).toContain('Schema drift');
    expect(r.stdout).toContain('Vocab drift');
  });

  test('--diff requires two snapshots', () => {
    setupVault();
    runCli(['entropy', '--json', '--root', tmp]);
    writeFileSync(join(tmp, 'notes', 'c.md'),
      `---\ntemplate: templates/note-template.md\ntitle: C\nstatus: done\n---\n# C\n`);
    runCli(['entropy', '--json', '--root', tmp]);

    const r = runCli(['entropy', '--diff', '--root', tmp]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/schema|vocab|lifecycle|distribution/i);
  });

  test('--history lists snapshots', () => {
    setupVault();
    runCli(['entropy', '--root', tmp]);
    const r = runCli(['entropy', '--history', '--root', tmp]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/2026-|2025-|2027-/);
  });
});
