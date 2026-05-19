/**
 * cli/main.js — multi-tool CLI smoke tests.
 *
 * Drives the bin via `node cli/main.js <subcommand>` (mirroring how end users
 * invoke `vault-keeper` after install). Each test owns a tmp directory so
 * filesystem-mutating subcommands (init) don't pollute the repo.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(TESTS_DIR, '..');
const BIN = join(REPO_ROOT, 'cli', 'main.js');

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vk-cli-'));
});

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

describe('vault-keeper (multi-tool CLI)', () => {
  test('no args → prints top-level help, exit 0', () => {
    const { code, stdout } = runCli([]);
    expect(code).toBe(0);
    expect(stdout).toContain('vault-keeper');
    expect(stdout).toContain('Commands:');
    expect(stdout).toContain('validate');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('install-claude-code-plugin');
    expect(stdout).toContain('init');
  });

  test('--version prints the package version', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    );
    const { code, stdout } = runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  test('help <command> prints subcommand-specific usage', () => {
    const { code, stdout } = runCli(['help', 'doctor']);
    expect(code).toBe(0);
    expect(stdout).toContain('vault-keeper doctor');
    expect(stdout).toContain('Health-check');
  });

  test('unknown subcommand exits 1 with usage', () => {
    const { code, stderr } = runCli(['this-is-not-a-command']);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command');
  });

  test('doctor → exits 0 with a checklist', () => {
    const { code, stdout } = runCli(['doctor']);
    expect(code).toBe(0);
    expect(stdout).toContain('Node ≥ 18');
    expect(stdout).toContain('vault-keeper');
    expect(stdout).toContain('LSP bundle');
    expect(stdout).toContain('Summary:');
  });

  test('doctor --json emits a parseable report', () => {
    const { code, stdout } = runCli(['doctor', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(typeof parsed.version).toBe('string');
  });

  test('init <empty dir> → scaffolds three files, exits 0', () => {
    const target = join(sandbox, 'fresh');
    const { code, stdout } = runCli(['init', target]);
    expect(code).toBe(0);
    expect(stdout).toContain('Vault scaffolded');
    expect(existsSync(join(target, '.claude', 'vault-keeper.json'))).toBe(true);
    expect(existsSync(join(target, 'templates', 'note-template.md'))).toBe(true);
    expect(existsSync(join(target, 'notes', 'note-001-hello.md'))).toBe(true);
  });

  test('init refuses to clobber a non-empty dir without --force', () => {
    const target = join(sandbox, 'nonempty');
    require('node:fs').mkdirSync(target, { recursive: true });
    require('node:fs').writeFileSync(join(target, 'preexisting'), 'x');

    const { code, stderr } = runCli(['init', target]);
    expect(code).toBe(1);
    expect(stderr).toContain('is not empty');
  });

  test('scaffolded vault validates clean (init + validate end-to-end)', () => {
    const target = join(sandbox, 'e2e');
    const initRes = runCli(['init', target]);
    expect(initRes.code).toBe(0);

    const valRes = runCli(['validate', '--root', target, '--json']);
    expect(valRes.code).toBe(0);
    const parsed = JSON.parse(valRes.stdout);
    expect(parsed.summary.total).toBe(1);
    expect(parsed.summary.valid).toBe(1);
    expect(parsed.summary.invalid).toBe(0);
  });

  test('REGRESSION — invoking through a symlinked bin still runs main()', () => {
    // npm/bun place a symlink to cli/main.js at node_modules/.bin/vault-keeper
    // when the package is installed. Earlier v0.6.0 had an entry-guard bug
    // that compared `import.meta.url` against `pathToFileURL(process.argv[1])`
    // directly — under symlink invocation the latter pointed at the symlink
    // path and the former at the realpath, so main() never ran (silent
    // success, no output). The fix resolves argv[1] with realpathSync first.
    const linkDir = join(sandbox, 'fake-bin');
    require('node:fs').mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, 'vault-keeper');
    symlinkSync(join(REPO_ROOT, 'cli', 'main.js'), link);

    // Invoke through the symlink — must produce output, must exit 0.
    const stdout = execFileSync('node', [link, '--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    );
    expect(stdout.trim()).toBe(pkg.version);

    // Same check for the legacy validate-documents.js bin.
    const linkValidate = join(linkDir, 'vault-keeper-validate');
    symlinkSync(
      join(REPO_ROOT, 'cli', 'validate-documents.js'),
      linkValidate,
    );
    // Should at least *try* to scan and report (no docs, no config → "No
    // documents found"); we only care that any output appears, proving
    // main() ran past the entry guard.
    const out = (() => {
      try {
        return execFileSync('node', [linkValidate, '--root', sandbox], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return err.stdout?.toString() ?? '';
      }
    })();
    expect(out.length).toBeGreaterThan(0);
  });

  test('validate sub delegates to validate-documents.js (matches direct run)', () => {
    const examples = join(REPO_ROOT, 'examples', 'example');
    const subRes = runCli(['validate', '--root', examples, '--json']);
    // examples/example ships invalid fixtures → exit 1
    expect(subRes.code).toBe(1);
    const subSummary = JSON.parse(subRes.stdout).summary;

    // Compare against direct invocation of the legacy bin script
    const directBin = join(REPO_ROOT, 'cli', 'validate-documents.js');
    let directStdout;
    try {
      directStdout = execFileSync(
        'node',
        [directBin, '--root', examples, '--json'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      directStdout = err.stdout?.toString() ?? '';
    }
    const directSummary = JSON.parse(directStdout).summary;

    expect(subSummary).toEqual(directSummary);
  });
});
