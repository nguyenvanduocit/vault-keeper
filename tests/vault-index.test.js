/**
 * Tests for lib/vault-index.js — pure-function incoming-link counter.
 *
 * Builds a tmp vault on disk with three .md files (A links to B; C is orphan)
 * and asserts countIncomingLinks() returns the expected per-target counts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countIncomingLinks } from '../lib/vault-index.js';

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-vi-')));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('countIncomingLinks', () => {
  test('counts incoming markdown body links by absolute target path', async () => {
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    writeFileSync(
      join(tmp, 'notes', 'a.md'),
      '---\ntitle: A\n---\n# A\n\nSee [B](./b.md) and [B again](./b.md#section).\n',
    );
    writeFileSync(
      join(tmp, 'notes', 'b.md'),
      '---\ntitle: B\n---\n# B\n',
    );
    writeFileSync(
      join(tmp, 'notes', 'c.md'),
      '---\ntitle: C orphan\n---\n# C\n',
    );

    const counts = await countIncomingLinks(join(tmp, 'notes'));

    expect(counts.get(join(tmp, 'notes', 'b.md'))).toBe(2);
    expect(counts.get(join(tmp, 'notes', 'c.md')) ?? 0).toBe(0);
    expect(counts.get(join(tmp, 'notes', 'a.md')) ?? 0).toBe(0);
  });

  test('skips http(s) links and code-fence-looking refs', async () => {
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    writeFileSync(
      join(tmp, 'notes', 'a.md'),
      '# A\n\nSee [external](https://example.com/foo.md) and [B](./b.md).\n',
    );
    writeFileSync(join(tmp, 'notes', 'b.md'), '# B\n');

    const counts = await countIncomingLinks(join(tmp, 'notes'));
    expect(counts.get(join(tmp, 'notes', 'b.md'))).toBe(1);
  });

  test('empty vault → empty Map', async () => {
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    const counts = await countIncomingLinks(join(tmp, 'notes'));
    expect(counts.size).toBe(0);
  });
});
