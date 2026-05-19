/**
 * vault-config.js — Vault-agnostic config resolution.
 *
 * A vault declares its shape via `${projectRoot}/.claude/vault-keeper.json`
 * (or an explicit path in `VAULT_KEEPER_CONFIG`). With no config file, the
 * built-in defaults below apply.
 *
 * Three config atoms + a root resolver — pure infra, no engine logic.
 *
 * Consumers:
 *   - lib/validators.js             (CONFIG.contentFolders / .excludePatterns / .namingPatterns)
 *   - cli/validate-documents.js     (root derivation: --root / CLAUDE_PROJECT_DIR)
 *   - server/main.js                (vaultFolders)
 *   - server/smoke.js               (fixture-driven via config)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ── Defaults ────────────────────────────────────────────────────────────────
//
// `namingPatterns` are serialized as `{ folder: "<regex source>" }` in the
// config file (JSON has no RegExp literal). loadVaultConfig() compiles the
// source strings back to RegExp. Internally the defaults are kept as live
// RegExp so the no-config path never round-trips through string compilation.
// Generic exclusions: AI-agent prompts, npm deps, common static-site dirs,
// folder-meta README.md (canonical vault docs that LIVE as a folder's
// README.md must be re-included by the orchestrator, which already does).
const DEFAULT_EXCLUDE_PATTERNS = [
  '**/README.md',
  '**/CLAUDE.md',
  '**/CLAUDE.local.md',
  '**/.vitepress/**',
  '**/node_modules/**',
];

// No default folder→filename regex map. Vault opts in by declaring
// namingPatterns in `.claude/vault-keeper.json`.
const DEFAULT_NAMING_PATTERNS = {};

const DEFAULTS = {
  // With no config file, the whole repo IS the vault — single-doc / flat-
  // layout vaults work without any setup. Multi-section vaults configure
  // explicit vaultFolders.
  vaultRoot: '.',
  vaultFolders: ['.'],
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  namingPatterns: DEFAULT_NAMING_PATTERNS,
};

// Stable repo markers, most specific first. Used by resolveProjectRoot()'s
// walk-up. NOT a config file lookup — that would be circular (the config file
// lives under `.claude/`, which is itself one of these markers).
const ROOT_MARKERS = ['.git', '.claude', 'CLAUDE.md'];

/**
 * Resolve the vault project root.
 *
 * Precedence (no circular dependency — uses STABLE filesystem markers, never
 * the config file that vaultRoot is defined in):
 *   1. opts.root  (CLI `--root <path>`)
 *   2. process.env.CLAUDE_PROJECT_DIR  (canonical Claude Code project signal)
 *   3. walk up from process.cwd(): first dir with `.git/`, else `.claude/`,
 *      else `CLAUDE.md`
 *   4. process.cwd()  (fallback)
 *
 * @param {{ root?: string }} [opts]
 * @returns {string} absolute project root
 */
export function resolveProjectRoot(opts = {}) {
  if (opts && typeof opts.root === 'string' && opts.root.length > 0) {
    return resolve(opts.root);
  }
  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (envDir && envDir.length > 0) {
    return resolve(envDir);
  }

  // Walk up once per marker tier (most specific first) so a `.git` parent
  // outranks a closer `CLAUDE.md`-only dir.
  const start = process.cwd();
  for (const marker of ROOT_MARKERS) {
    let dir = start;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (existsSync(join(dir, marker))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return start;
}

// ── Config file loading (cached once per process, keyed by resolved path) ────

const _cache = new Map();

function configPathFor(projectRoot) {
  const override = process.env.VAULT_KEEPER_CONFIG;
  if (override && override.length > 0) return resolve(override);
  return join(projectRoot, '.claude', 'vault-keeper.json');
}

function compileNamingPatterns(raw) {
  // Accept either { folder: "<regex source>" } (from JSON) or live RegExp
  // (defaults). Foreign vaults supply strings; we compile them once.
  const out = {};
  for (const [folder, val] of Object.entries(raw)) {
    out[folder] = val instanceof RegExp ? val : new RegExp(val);
  }
  return out;
}

/**
 * Load the vault config for a project root. With no file present (and no
 * VAULT_KEEPER_CONFIG override) the returned object is the built-in defaults.
 *
 * Cached per process, keyed by the resolved config path. Frozen so consumers
 * cannot mutate shared state.
 *
 * @param {string} [projectRoot]  defaults to resolveProjectRoot()
 * @returns {{ vaultRoot: string, vaultFolders: string[],
 *             excludePatterns: string[], namingPatterns: Record<string,RegExp> }}
 */
export function loadVaultConfig(projectRoot) {
  const root = projectRoot || resolveProjectRoot();
  const cfgPath = configPathFor(root);
  if (_cache.has(cfgPath)) return _cache.get(cfgPath);

  let fileConfig = {};
  try {
    if (existsSync(cfgPath) && statSync(cfgPath).isFile()) {
      fileConfig = JSON.parse(readFileSync(cfgPath, 'utf-8')) || {};
    }
  } catch {
    // Unreadable / malformed config → fall back to defaults rather than
    // crashing the whole validator. A foreign vault with a broken config
    // still gets a working (default) engine.
    fileConfig = {};
  }

  const merged = {
    vaultRoot:
      typeof fileConfig.vaultRoot === 'string' && fileConfig.vaultRoot.length > 0
        ? fileConfig.vaultRoot
        : DEFAULTS.vaultRoot,
    vaultFolders:
      Array.isArray(fileConfig.vaultFolders) && fileConfig.vaultFolders.length > 0
        ? fileConfig.vaultFolders.slice()
        : DEFAULTS.vaultFolders.slice(),
    excludePatterns:
      Array.isArray(fileConfig.excludePatterns) && fileConfig.excludePatterns.length > 0
        ? fileConfig.excludePatterns.slice()
        : DEFAULTS.excludePatterns.slice(),
    namingPatterns: compileNamingPatterns(
      fileConfig.namingPatterns && typeof fileConfig.namingPatterns === 'object'
        ? fileConfig.namingPatterns
        : DEFAULTS.namingPatterns,
    ),
  };

  Object.freeze(merged.vaultFolders);
  Object.freeze(merged.excludePatterns);
  Object.freeze(merged.namingPatterns);
  Object.freeze(merged);
  _cache.set(cfgPath, merged);
  return merged;
}

/** Test-only: clear the per-process config cache. */
export function _resetVaultConfigCache() {
  _cache.clear();
}
