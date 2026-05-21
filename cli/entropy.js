#!/usr/bin/env node
/**
 * cli/entropy.js — `vault-keeper entropy` subcommand.
 *
 * Always exits 0 on successful measurement; entropy is a gradient, CI gating
 * is the caller's responsibility (parse JSON + threshold check).
 */

import { resolve } from 'node:path';
import {
  measureEntropy,
  writeSnapshot,
  readLatestSnapshot,
  listSnapshots,
  diffSnapshots,
} from '../lib/entropy/index.js';

const USAGE = `vault-keeper entropy [options]

Measure vault entropy across 4 dimensions and write a snapshot.

Options:
  --root <path>     Vault project root (else CLAUDE_PROJECT_DIR, else cwd)
  --json            Emit EntropyReport JSON to stdout
  --no-snapshot     Do not persist a snapshot
  --diff[=<spec>]   Compare latest vs previous snapshot; print delta
  --history         List existing snapshots
  --help            Show this help

Exit code: always 0 on successful measurement.
`;

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = args.root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const vaultRoot = resolve(root);

  if (args.history) {
    return renderHistory(vaultRoot);
  }
  if (args.diff) {
    return renderDiff(vaultRoot);
  }

  const report = await measureEntropy({ vaultRoot });

  if (!args.noSnapshot) {
    writeSnapshot(report, vaultRoot);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(report) + '\n');
  }
  return 0;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-snapshot') out.noSnapshot = true;
    else if (a === '--history') out.history = true;
    else if (a === '--diff' || a.startsWith('--diff=')) out.diff = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a.startsWith('--root=')) out.root = a.slice(7);
  }
  return out;
}

function renderHuman(report) {
  const lines = [];
  lines.push(`vault-keeper entropy — ${report.vault_root}`);
  lines.push(`Snapshot: ${report.measured_at}` + (report.git_head ? ` (git: ${report.git_head})` : ''));
  lines.push('');
  lines.push(`Overall health: ${formatScore(report.overall_score)}/100`);
  for (const dim of ['schema', 'vocab', 'lifecycle', 'distribution']) {
    const label = ({ schema: 'Schema drift', vocab: 'Vocab drift', lifecycle: 'Lifecycle decay', distribution: 'Distribution' })[dim];
    const score = report.dimensions[dim].score;
    lines.push(`  ${label.padEnd(16)} ${formatScore(score)}  ${verdict(score)}`);
  }
  const emergCount = report.emergence.field_candidates.length + report.emergence.section_candidates.length;
  lines.push(`  Pattern garden   ${emergCount} candidate${emergCount === 1 ? '' : 's'} emerging`);

  // Health flags: surface alarms that DON'T move dimension scores but that
  // the gardener needs to see (e.g. docs referencing templates that don't
  // exist would otherwise be silently dropped from the templated set).
  const missing = report.health_flags?.missing_templates ?? [];
  if (missing.length > 0) {
    lines.push('');
    lines.push('Health flags:');
    const head = missing.slice(0, 3).join(', ');
    const tail = missing.length > 3 ? `, ... (+${missing.length - 3} more)` : '';
    lines.push(`  ${missing.length} missing template ref${missing.length === 1 ? '' : 's'}: ${head}${tail}`);
  }

  lines.push('');
  lines.push(`${report.stats.total_docs} docs · ${report.stats.total_templates} templates · scan ${report.stats.scan_duration_ms}ms`);
  return lines.join('\n');
}

function formatScore(s) {
  if (s === null || s === undefined) return ' --';
  return String(s).padStart(3, ' ');
}

function verdict(score) {
  if (score === null) return '— n/a';
  if (score >= 80) return '✓ healthy';
  if (score >= 60) return '⚠ moderate';
  return '✗ degraded';
}

function renderDiff(vaultRoot) {
  const snapshots = listSnapshots(vaultRoot);
  if (snapshots.length < 2) {
    process.stderr.write('Need at least 2 snapshots to diff. Run `vault-keeper entropy` twice.\n');
    return 0;
  }
  const after = snapshots[snapshots.length - 1];
  const before = snapshots[snapshots.length - 2];
  const delta = diffSnapshots(before, after);
  process.stdout.write(
    `Elapsed: ${delta.elapsed_days.toFixed(1)} days\n` +
    `Overall: ${before.overall_score} → ${after.overall_score} (${signed(delta.overall_delta)})\n` +
    Object.entries(delta.dimensions).map(([k, v]) =>
      `  ${k.padEnd(14)} ${v.before} → ${v.after} (${signed(v.delta)})`).join('\n') + '\n',
  );
  return 0;
}

function renderHistory(vaultRoot) {
  const snapshots = listSnapshots(vaultRoot);
  if (snapshots.length === 0) {
    process.stdout.write('No snapshots yet. Run `vault-keeper entropy` to create one.\n');
    return 0;
  }
  for (const s of snapshots) {
    process.stdout.write(`${s.measured_at}  score=${s.overall_score ?? 'null'}  docs=${s.stats.total_docs}\n`);
  }
  return 0;
}

function signed(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return ' n/a';
  return (n >= 0 ? '+' : '') + n;
}
