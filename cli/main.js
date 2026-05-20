#!/usr/bin/env node
/**
 * vault-keeper — multi-tool entry point.
 *
 * Dispatches to per-subcommand handlers. The legacy `vault-keeper-validate`
 * bin still points at `cli/validate-documents.js` directly, so existing
 * tooling keeps working without modification.
 *
 * Subcommands:
 *   validate                     — full-vault validation (delegates to validate-documents.js)
 *   doctor                       — environment + vault + plugin health-check
 *   install-claude-code-plugin   — wraps `claude plugin marketplace add` + `claude plugin install`
 *   init [dir]                   — scaffold a minimal vault skeleton
 *   help [cmd]                   — usage banner (top-level or per-command)
 *   --version / -v               — print the package version
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));

const REPO_HTTPS_URL = (pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');
const PLUGIN_MARKETPLACE_URL =
  (pkg.repository?.url ?? '').replace(/^git\+/, '') ||
  'https://github.com/nguyenvanduocit/claude-code-vault-keeper.git';
const PLUGIN_NAME = 'claude-code-vault-keeper@vault-keeper';

// ── Help text ───────────────────────────────────────────────────────────────

const USAGE_MAIN = `vault-keeper — knowledge-vault tooling for Claude Code (v${pkg.version})

Usage:
  vault-keeper <command> [options]
  vault-keeper --version
  vault-keeper --help

Commands:
  validate                     Validate vault docs against template rules
  doctor                       Diagnose environment, config, plugin state
  install-claude-code-plugin   Install this plugin into Claude Code
  init [dir]                   Scaffold a minimal vault skeleton in <dir>
  help [command]               Show top-level or per-command help

Run \`vault-keeper help <command>\` for command-specific options.

Repo:  ${REPO_HTTPS_URL || '<unknown>'}
`;

const USAGE_SUB = {
  validate: `vault-keeper validate [options]

Validate vault documents against the rules declared by each doc's template.

Options:
  --root <path>     Vault project root (else CLAUDE_PROJECT_DIR, else walk-up)
  --path <path>     Validate a single file or sub-directory
  --strict          Fail (exit 1) on warnings, not just errors
  --json            Emit a machine-readable report to stdout

Exit codes:
  0  every doc is valid (zero warnings in --strict mode)
  1  one or more invalid docs, or a runtime error

The legacy bin \`vault-keeper-validate <opts>\` is equivalent to
\`vault-keeper validate <opts>\` — both remain supported.
`,
  doctor: `vault-keeper doctor [options]

Health-check the environment, the current-directory vault config, and the
Claude Code plugin install state.

Options:
  --json            Emit a machine-readable report (one check per row)

Exit codes:
  0  no failed checks (warnings are allowed)
  1  at least one check failed
`,
  'install-claude-code-plugin': `vault-keeper install-claude-code-plugin

Install this package into Claude Code via its plugin manifest. Equivalent to:

  claude plugin marketplace add ${PLUGIN_MARKETPLACE_URL}
  claude plugin install ${PLUGIN_NAME}

Requires the \`claude\` CLI on \$PATH. If absent, the command prints the
manual install steps instead of silently failing.
`,
  init: `vault-keeper init [dir]

Scaffold a fresh vault skeleton:
  <dir>/.claude/vault-keeper.json   — minimal config (vaultRoot=notes)
  <dir>/templates/note-template.md  — minimal template with fields schema
  <dir>/notes/note-001-hello.md     — sample conforming document

Refuses to overwrite an existing non-empty <dir>. Pass --force to override.
`,
};

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE_MAIN);
    return 0;
  }
  if (argv[0] === '-v' || argv[0] === '--version' || argv[0] === 'version') {
    console.log(pkg.version);
    return 0;
  }
  if (argv[0] === 'help') {
    const cmd = argv[1];
    if (!cmd) {
      process.stdout.write(USAGE_MAIN);
      return 0;
    }
    if (USAGE_SUB[cmd]) {
      process.stdout.write(USAGE_SUB[cmd]);
      return 0;
    }
    console.error(`No help available for unknown command: ${cmd}\n`);
    process.stdout.write(USAGE_MAIN);
    return 1;
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  switch (subcommand) {
    case 'validate': {
      // validate-documents.js owns its own process.exit on success/failure,
      // so this awaits then never resolves on the success/error paths. The
      // return value below is reachable only if validate-documents changes
      // its exit semantics (defensive fallthrough).
      const mod = await import('./validate-documents.js');
      await mod.main(rest);
      return 0;
    }
    case 'doctor':
      return runDoctor(rest);
    case 'install-claude-code-plugin':
      return runInstallPlugin(rest);
    case 'init':
      return runInit(rest);
    default: {
      console.error(`Unknown command: ${subcommand}\n`);
      process.stderr.write(USAGE_MAIN);
      return 1;
    }
  }
}

// ── doctor ──────────────────────────────────────────────────────────────────

async function runDoctor(args) {
  const wantJson = args.includes('--json');
  const checks = [];

  // Node version
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'Node ≥ 18',
    status: nodeMajor >= 18 ? 'ok' : 'error',
    detail: `v${process.versions.node}${nodeMajor >= 18 ? '' : ' — please upgrade to Node 18+'}`,
  });

  // Package version + LSP bundle
  checks.push({
    name: 'claude-code-vault-keeper',
    status: 'ok',
    detail: `v${pkg.version} @ ${pkgRoot}`,
  });
  const bundlePath = resolve(pkgRoot, 'server', 'main.bundled.cjs');
  if (existsSync(bundlePath)) {
    const size = statSync(bundlePath).size;
    checks.push({
      name: 'LSP bundle (server/main.bundled.cjs)',
      status: 'ok',
      detail: `${(size / 1024).toFixed(0)} KB`,
    });
  } else {
    checks.push({
      name: 'LSP bundle (server/main.bundled.cjs)',
      status: 'error',
      detail: `missing — expected at ${bundlePath}`,
    });
  }

  // bun runtime (optional)
  const bunDetect = await detectBinary('bun', ['--version']);
  checks.push({
    name: 'bun runtime',
    status: bunDetect.ok ? 'ok' : 'info',
    detail: bunDetect.ok
      ? `v${bunDetect.stdout.trim()}`
      : 'not on $PATH — optional; bunx requires bun. Install via https://bun.sh',
  });

  // claude CLI (needed for install-claude-code-plugin)
  const claudeDetect = await detectBinary('claude', ['--version']);
  checks.push({
    name: 'claude CLI',
    status: claudeDetect.ok ? 'ok' : 'warning',
    detail: claudeDetect.ok
      ? claudeDetect.stdout.split('\n')[0].trim()
      : 'not on $PATH — `install-claude-code-plugin` will print manual steps instead. Install via https://claude.com/claude-code',
  });

  // Current-dir vault state
  const cwd = process.cwd();
  const cfgPath = resolve(cwd, '.claude', 'vault-keeper.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      checks.push({
        name: 'vault config (.claude/vault-keeper.json)',
        status: 'ok',
        detail: `vaultRoot=${JSON.stringify(cfg.vaultRoot ?? '.')}, vaultFolders=${JSON.stringify(cfg.vaultFolders ?? ['.'])}`,
      });
    } catch (err) {
      checks.push({
        name: 'vault config (.claude/vault-keeper.json)',
        status: 'error',
        detail: `parse failure: ${err.message}`,
      });
    }
  } else {
    checks.push({
      name: 'vault config (.claude/vault-keeper.json)',
      status: 'info',
      detail: 'no file in cwd — using defaults (whole repo is the vault)',
    });
  }

  // templates/ dir
  const templatesDir = resolve(cwd, 'templates');
  if (existsSync(templatesDir) && statSync(templatesDir).isDirectory()) {
    const tmpls = readdirSync(templatesDir).filter((f) => f.endsWith('.md'));
    checks.push({
      name: 'templates/ directory (cwd)',
      status: tmpls.length > 0 ? 'ok' : 'warning',
      detail:
        tmpls.length > 0
          ? `${tmpls.length} template${tmpls.length === 1 ? '' : 's'}: ${tmpls.join(', ')}`
          : 'directory exists but contains no *.md templates',
    });
  } else {
    checks.push({
      name: 'templates/ directory (cwd)',
      status: 'info',
      detail: 'none — current dir is not a vault root (run `vault-keeper init`)',
    });
  }

  // Output
  if (wantJson) {
    console.log(JSON.stringify({ checks, version: pkg.version }, null, 2));
  } else {
    const ICON = { ok: '✅', warning: '⚠️ ', info: 'ℹ️ ', error: '❌' };
    console.log(`vault-keeper doctor — v${pkg.version}\n`);
    for (const c of checks) {
      console.log(`${ICON[c.status] || '? '} ${c.name}`);
      console.log(`     ${c.detail}`);
    }
    const fails = checks.filter((c) => c.status === 'error').length;
    const warns = checks.filter((c) => c.status === 'warning').length;
    console.log(
      `\nSummary: ${checks.length} checks · ${fails} error${fails === 1 ? '' : 's'} · ${warns} warning${warns === 1 ? '' : 's'}`,
    );
  }

  return checks.some((c) => c.status === 'error') ? 1 : 0;
}

// ── install-claude-code-plugin ──────────────────────────────────────────────

async function runInstallPlugin(_args) {
  console.log(
    `Installing claude-code-vault-keeper as a Claude Code plugin...\n`,
  );
  const claudeDetect = await detectBinary('claude', ['--version']);
  if (!claudeDetect.ok) {
    console.error(
      `❌ The \`claude\` CLI was not found on $PATH.\n` +
        `   Install Claude Code first: https://claude.com/claude-code\n` +
        `   Then run the manual steps yourself:\n\n` +
        `     claude plugin marketplace add ${PLUGIN_MARKETPLACE_URL}\n` +
        `     claude plugin install ${PLUGIN_NAME}\n`,
    );
    return 1;
  }

  console.log(`▶ claude plugin marketplace add ${PLUGIN_MARKETPLACE_URL}`);
  const addCode = await runChild('claude', [
    'plugin',
    'marketplace',
    'add',
    PLUGIN_MARKETPLACE_URL,
  ]);
  if (addCode !== 0) {
    console.error(
      `\n❌ \`claude plugin marketplace add\` exited with code ${addCode}.`,
    );
    return addCode;
  }

  console.log(`\n▶ claude plugin install ${PLUGIN_NAME}`);
  const installCode = await runChild('claude', [
    'plugin',
    'install',
    PLUGIN_NAME,
  ]);
  if (installCode !== 0) {
    console.error(
      `\n❌ \`claude plugin install\` exited with code ${installCode}.`,
    );
    return installCode;
  }

  console.log(
    `\n✅ Plugin installed. Open any .md file in a vault to see inline LSP diagnostics.`,
  );
  return 0;
}

// ── init ────────────────────────────────────────────────────────────────────

const SCAFFOLD_VAULT_CONFIG = JSON.stringify(
  { vaultRoot: 'notes', vaultFolders: ['notes'] },
  null,
  2,
) + '\n';

const SCAFFOLD_TEMPLATE = `---
template_path: templates/note-template.md
document_type: note
fields:
  template:
    required: true
  document_type:
    required: true
  title:
    required: true
    type: string
  owner:
    required: true
    type: string
  status:
    type: string
    enum: [draft, review, approved]
  tags:
    type: array
  $path:
    pattern: "^notes/"
---

# Note template

A minimal template for free-form notes. Edit \`fields:\` above to match your
vault's authoring contract.

\`\`\`yaml section-rules
required: false
\`\`\`

## Relationships
`;

const SCAFFOLD_DOC = `---
template: templates/note-template.md
document_type: note
title: Hello vault
owner: '@alice'
status: draft
---

# Hello vault

This is your first vault document. Run \`vault-keeper validate --root .\`
to see it pass validation. Try removing the \`owner:\` line to see the
template rule fire.

## Relationships
`;

function runInit(args) {
  const force = args.includes('--force');
  const dir = args.find((a) => !a.startsWith('-')) ?? '.';
  const targetDir = resolve(process.cwd(), dir);

  if (existsSync(targetDir)) {
    if (!statSync(targetDir).isDirectory()) {
      console.error(`❌ ${targetDir} exists and is not a directory.`);
      return 1;
    }
    const entries = readdirSync(targetDir);
    if (entries.length > 0 && !force) {
      console.error(
        `❌ ${targetDir} is not empty (found ${entries.length} entries). ` +
          `Pass --force to scaffold inside it anyway.`,
      );
      return 1;
    }
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  const writes = [
    {
      path: join(targetDir, '.claude', 'vault-keeper.json'),
      content: SCAFFOLD_VAULT_CONFIG,
    },
    {
      path: join(targetDir, 'templates', 'note-template.md'),
      content: SCAFFOLD_TEMPLATE,
    },
    {
      path: join(targetDir, 'notes', 'note-001-hello.md'),
      content: SCAFFOLD_DOC,
    },
  ];

  for (const { path, content } of writes) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && !force) {
      console.error(
        `❌ ${path} already exists. Pass --force to overwrite.`,
      );
      return 1;
    }
    writeFileSync(path, content, 'utf-8');
    console.log(`  + ${path}`);
  }

  console.log(
    `\n✅ Vault scaffolded in ${targetDir}\n\nNext:\n  cd ${dir}\n  vault-keeper validate\n`,
  );
  return 0;
}

// ── Process helpers ─────────────────────────────────────────────────────────

/**
 * Probe whether a binary is on $PATH and capture its version output. Resolves
 * to `{ ok, stdout, stderr }`. Never rejects.
 */
function detectBinary(cmd, args) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => resolveFn({ ok: false, stdout: '', stderr: '' }));
    child.on('close', (code) =>
      resolveFn({ ok: code === 0, stdout, stderr }),
    );
  });
}

/**
 * Spawn a child and pipe its stdio through. Resolves to the exit code.
 */
function runChild(cmd, args) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`spawn ${cmd}: ${err.message}`);
      resolveFn(127);
    });
    child.on('close', (code) => resolveFn(code ?? 1));
  });
}

// ── Entry guard ─────────────────────────────────────────────────────────────
//
// `process.argv[1]` is whatever the OS resolved when launching node — when
// the bin is invoked via the npm/bun symlink at `node_modules/.bin/<name>`
// that's the symlink path, but `import.meta.url` is always the resolved
// real-path of this module. Comparing the two raw URLs would diverge under
// any global/local bin install and silently skip main(). Resolving the
// symlink before comparing fixes it for all install shapes.

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
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.stack || err.message || err);
      process.exit(1);
    },
  );
}

export { main };
