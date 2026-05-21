/**
 * Tests for lib/vault-config.js — vault-agnostic config resolution.
 *
 * Two concerns:
 *   1. resolveProjectRoot precedence (opts.root → CLAUDE_PROJECT_DIR →
 *      walk-up markers → cwd).
 *   2. loadVaultConfig defaults (no file → built-in defaults) + file override
 *      + cache + malformed-file degradation.
 *
 * The reusability proof (validate-documents/update-board scanning a non-
 * `product-knowledge` root) lives in tests/reusability.test.js — this file
 * covers the config primitive in isolation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveProjectRoot,
  loadVaultConfig,
  _resetVaultConfigCache,
} from '../lib/vault-config.js';

let tmp;
const savedEnv = {};

beforeEach(() => {
  _resetVaultConfigCache();
  savedEnv.CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;
  savedEnv.VAULT_KEEPER_CONFIG = process.env.VAULT_KEEPER_CONFIG;
  delete process.env.CLAUDE_PROJECT_DIR;
  delete process.env.VAULT_KEEPER_CONFIG;
  // realpathSync so comparisons against process.cwd() (which is realpath-
  // resolved on macOS: /var → /private/var) are apples-to-apples.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-cfg-')));
});

afterEach(() => {
  for (const k of ['CLAUDE_PROJECT_DIR', 'VAULT_KEEPER_CONFIG']) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmp, { recursive: true, force: true });
  _resetVaultConfigCache();
});

// ── resolveProjectRoot ───────────────────────────────────────────────────────

describe('resolveProjectRoot', () => {
  test('opts.root wins over everything', () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/other/dir';
    expect(resolveProjectRoot({ root: tmp })).toBe(tmp);
  });

  test('CLAUDE_PROJECT_DIR used when no opts.root', () => {
    process.env.CLAUDE_PROJECT_DIR = tmp;
    expect(resolveProjectRoot()).toBe(tmp);
  });

  test('walk-up finds .git/ ancestor', () => {
    const repo = join(tmp, 'repo');
    const deep = join(repo, 'a', 'b');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(deep, { recursive: true });
    const orig = process.cwd();
    try {
      process.chdir(deep);
      expect(resolveProjectRoot()).toBe(repo);
    } finally {
      process.chdir(orig);
    }
  });

  test('.git outranks a closer CLAUDE.md-only dir', () => {
    const repo = join(tmp, 'repo');
    const sub = join(repo, 'sub');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'CLAUDE.md'), '# sub');
    const orig = process.cwd();
    try {
      process.chdir(sub);
      // .git tier walks first → repo, not sub (CLAUDE.md tier).
      expect(resolveProjectRoot()).toBe(repo);
    } finally {
      process.chdir(orig);
    }
  });

  test('falls back to cwd when no marker found', () => {
    const isolated = join(tmp, 'isolated');
    mkdirSync(isolated, { recursive: true });
    const orig = process.cwd();
    try {
      process.chdir(isolated);
      // tmp itself may sit under a real repo on the CI box, so we only assert
      // it does not throw and returns an absolute path.
      const r = resolveProjectRoot();
      expect(typeof r).toBe('string');
      expect(r.startsWith('/')).toBe(true);
    } finally {
      process.chdir(orig);
    }
  });
});

// ── loadVaultConfig ──────────────────────────────────────────────────────────

describe('loadVaultConfig', () => {
  test('no config file → neutral defaults (whole repo as vault, generic excludes)', () => {
    const cfg = loadVaultConfig(tmp);
    expect(cfg.vaultRoot).toBe('.');
    expect(cfg.vaultFolders).toEqual(['.']);
    // Generic exclusions only — no vault-specific paths.
    expect(cfg.excludePatterns).toContain('**/README.md');
    expect(cfg.excludePatterns).toContain('**/CLAUDE.md');
    expect(cfg.excludePatterns).toContain('**/node_modules/**');
  });

  test('config file overrides each atom', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({
        vaultRoot: 'docs',
        vaultFolders: ['docs'],
        excludePatterns: ['**/node_modules/**'],
      }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.vaultRoot).toBe('docs');
    expect(cfg.vaultFolders).toEqual(['docs']);
    expect(cfg.excludePatterns).toEqual(['**/node_modules/**']);
  });

  test('partial config keeps defaults for unspecified atoms', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({ vaultRoot: 'docs' }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.vaultRoot).toBe('docs');
    // unspecified atoms fall back to defaults
    expect(cfg.vaultFolders).toEqual(['.']);
  });

  test('malformed config → defaults (engine still works)', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(join(tmp, '.claude', 'vault-keeper.json'), '{ not valid json');
    const cfg = loadVaultConfig(tmp);
    expect(cfg.vaultRoot).toBe('.');
  });

  test('VAULT_KEEPER_CONFIG path override is honored', () => {
    const explicit = join(tmp, 'custom-cfg.json');
    writeFileSync(explicit, JSON.stringify({ vaultRoot: 'kb' }));
    process.env.VAULT_KEEPER_CONFIG = explicit;
    const cfg = loadVaultConfig(tmp);
    expect(cfg.vaultRoot).toBe('kb');
  });

  test('result is cached per resolved config path', () => {
    const a = loadVaultConfig(tmp);
    const b = loadVaultConfig(tmp);
    expect(a).toBe(b); // same frozen object reference
  });

  test('returned config is frozen (immutable shared state)', () => {
    const cfg = loadVaultConfig(tmp);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.excludePatterns)).toBe(true);
  });
});

describe('loadVaultConfig — entropy block', () => {
  test('returns entropy: null when config omits the key', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({ vaultFolders: ['notes'] }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.entropy).toBe(null);
  });

  test('surfaces entropy block as-is when present', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({
        vaultFolders: ['notes'],
        entropy: {
          weights: { schema: 0.5, vocab: 0.5 },
          vocab: { distance_threshold: 0.15 },
        },
      }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.entropy).toEqual({
      weights: { schema: 0.5, vocab: 0.5 },
      vocab: { distance_threshold: 0.15 },
    });
  });

  test('entropy block is frozen', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({ entropy: { weights: { schema: 1 } } }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(Object.isFrozen(cfg.entropy)).toBe(true);
  });

  test('rejects array entropy as null (defense-in-depth)', () => {
    mkdirSync(join(tmp, '.claude'), { recursive: true });
    writeFileSync(
      join(tmp, '.claude', 'vault-keeper.json'),
      JSON.stringify({ entropy: [1, 2, 3] }),
    );
    const cfg = loadVaultConfig(tmp);
    expect(cfg.entropy).toBe(null);
  });
});
