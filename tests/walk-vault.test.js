/**
 * Tests for lib/walk-vault.js — shared markdown walker honoring
 * minimatch-style excludePatterns.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkVaultMarkdown } from '../lib/walk-vault.js';

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-walk-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function touch(...parts) {
  const p = join(tmp, ...parts);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '# stub\n');
  return p;
}

describe('walkVaultMarkdown', () => {
  test('finds .md files in nested folders, sorted ascending', async () => {
    const a = touch('notes', 'a.md');
    const b = touch('notes', 'sub', 'b.md');
    const c = touch('notes', 'c.md');

    const files = await walkVaultMarkdown(tmp);

    expect(files).toEqual([a, c, b].sort());
  });

  test('honors **/README.md exclude', async () => {
    touch('notes', 'a.md');
    touch('notes', 'README.md');
    touch('notes', 'sub', 'README.md');
    touch('notes', 'sub', 'real.md');

    const files = await walkVaultMarkdown(tmp, {
      excludePatterns: ['**/README.md'],
    });

    const rel = files.map((f) => f.slice(tmp.length + 1));
    expect(rel).toContain('notes/a.md');
    expect(rel).toContain('notes/sub/real.md');
    expect(rel.find((p) => p.endsWith('README.md'))).toBeUndefined();
  });

  test('skips dotdirs except .specify', async () => {
    touch('notes', 'a.md');
    touch('.claude', 'b.md');
    touch('.vitepress', 'c.md');
    touch('.specify', 'd.md');

    const files = await walkVaultMarkdown(tmp);
    const rel = files.map((f) => f.slice(tmp.length + 1));

    expect(rel).toContain('notes/a.md');
    expect(rel).toContain('.specify/d.md');
    expect(rel.find((p) => p.startsWith('.claude/'))).toBeUndefined();
    expect(rel.find((p) => p.startsWith('.vitepress/'))).toBeUndefined();
  });

  test('skips node_modules', async () => {
    touch('notes', 'a.md');
    touch('node_modules', 'pkg', 'b.md');

    const files = await walkVaultMarkdown(tmp);
    const rel = files.map((f) => f.slice(tmp.length + 1));

    expect(rel).toContain('notes/a.md');
    expect(rel.find((p) => p.startsWith('node_modules/'))).toBeUndefined();
  });

  test('prunes whole directory via glob exclude', async () => {
    touch('notes', 'a.md');
    touch('notes', 'drafts', 'b.md');
    touch('notes', 'drafts', 'c.md');

    const files = await walkVaultMarkdown(tmp, {
      excludePatterns: ['notes/drafts/**'],
    });

    const rel = files.map((f) => f.slice(tmp.length + 1));
    expect(rel).toEqual(['notes/a.md']);
  });

  test('non-existent root → empty array', async () => {
    const files = await walkVaultMarkdown(join(tmp, 'nope'));
    expect(files).toEqual([]);
  });

  test('no excludePatterns option → no excludes applied', async () => {
    touch('notes', 'a.md');
    touch('notes', 'README.md');

    const files = await walkVaultMarkdown(tmp);
    expect(files.length).toBe(2);
  });
});
