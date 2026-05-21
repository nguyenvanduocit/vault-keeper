/**
 * snapshot.js — read / write / diff entropy snapshot JSON.
 *
 * Snapshots live at `<vaultRoot>/.vault-keeper/snapshots/`. File names use
 * ISO timestamps with `:` replaced by `-` (FS-safe on Windows). `latest.json`
 * is an overwritten copy of the most recent snapshot for cheap reads.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR_REL = ['.vault-keeper', 'snapshots'];

function snapshotsDir(vaultRoot) {
  return join(vaultRoot, ...DIR_REL);
}

function filenameFor(measuredAt) {
  // 2026-05-21T10:30:00.123Z → 2026-05-21T10-30-00.123Z.json
  return measuredAt.replace(/:/g, '-') + '.json';
}

export function writeSnapshot(report, vaultRoot, { dryRun = false } = {}) {
  if (dryRun) return null;
  const dir = snapshotsDir(vaultRoot);
  mkdirSync(dir, { recursive: true });
  const filename = filenameFor(report.measured_at);
  const filepath = join(dir, filename);
  const json = JSON.stringify(report, null, 2);
  writeFileSync(filepath, json);
  writeFileSync(join(dir, 'latest.json'), json);
  return filepath;
}

export function readLatestSnapshot(vaultRoot) {
  const file = join(snapshotsDir(vaultRoot), 'latest.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function listSnapshots(vaultRoot) {
  const dir = snapshotsDir(vaultRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(
    (f) => f.endsWith('.json') && f !== 'latest.json',
  );
  const reports = [];
  for (const f of files) {
    try {
      reports.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')));
    } catch {
      // skip malformed
    }
  }
  reports.sort((a, b) => a.measured_at.localeCompare(b.measured_at));
  return reports;
}

export function diffSnapshots(before, after) {
  const elapsedMs = new Date(after.measured_at) - new Date(before.measured_at);
  const dim = (name) => ({
    before: before.dimensions[name].score,
    after: after.dimensions[name].score,
    delta: after.dimensions[name].score - before.dimensions[name].score,
  });
  return {
    elapsed_days: elapsedMs / (1000 * 60 * 60 * 24),
    overall_delta: after.overall_score - before.overall_score,
    dimensions: {
      schema: dim('schema'),
      vocab: dim('vocab'),
      lifecycle: dim('lifecycle'),
      distribution: dim('distribution'),
    },
  };
}
