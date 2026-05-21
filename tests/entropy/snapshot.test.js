import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSnapshot,
  readLatestSnapshot,
  listSnapshots,
  diffSnapshots,
} from '../../lib/entropy/snapshot.js';

let tmp;
beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'vk-snap-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const sampleReport = (score, ts) => ({
  schema_version: 1,
  measured_at: ts,
  vault_root: '/x',
  git_head: 'abc123',
  overall_score: score,
  dimensions: {
    schema: { score, details: {} },
    vocab: { score, details: {} },
    lifecycle: { score, details: {} },
    distribution: { score, details: {} },
  },
  emergence: { field_candidates: [], section_candidates: [] },
  stats: { total_docs: 0, total_templates: 0, scan_duration_ms: 0 },
});

describe('writeSnapshot', () => {
  test('writes timestamped file + latest.json', () => {
    const report = sampleReport(78, '2026-05-21T10:30:00.000Z');
    const file = writeSnapshot(report, tmp);
    expect(file.endsWith('2026-05-21T10-30-00.000Z.json')).toBe(true);
    expect(existsSync(join(tmp, '.vault-keeper', 'snapshots', 'latest.json'))).toBe(true);

    const latest = JSON.parse(readFileSync(join(tmp, '.vault-keeper', 'snapshots', 'latest.json'), 'utf-8'));
    expect(latest.overall_score).toBe(78);
  });

  test('dryRun returns null and writes nothing', () => {
    const file = writeSnapshot(sampleReport(50, '2026-05-21T11:00:00.000Z'), tmp, { dryRun: true });
    expect(file).toBe(null);
    expect(existsSync(join(tmp, '.vault-keeper'))).toBe(false);
  });
});

describe('readLatestSnapshot', () => {
  test('returns null when no snapshots exist', () => {
    expect(readLatestSnapshot(tmp)).toBe(null);
  });

  test('returns most-recent snapshot', () => {
    writeSnapshot(sampleReport(60, '2026-05-20T10:00:00.000Z'), tmp);
    writeSnapshot(sampleReport(80, '2026-05-21T10:00:00.000Z'), tmp);
    const latest = readLatestSnapshot(tmp);
    expect(latest.overall_score).toBe(80);
  });
});

describe('listSnapshots', () => {
  test('returns sorted ascending by measured_at', () => {
    writeSnapshot(sampleReport(80, '2026-05-21T10:00:00.000Z'), tmp);
    writeSnapshot(sampleReport(60, '2026-05-20T10:00:00.000Z'), tmp);
    const list = listSnapshots(tmp);
    expect(list.length).toBe(2);
    expect(list[0].overall_score).toBe(60);
    expect(list[1].overall_score).toBe(80);
  });
});

describe('diffSnapshots', () => {
  test('computes per-dimension deltas', () => {
    const before = sampleReport(70, '2026-05-20T10:00:00.000Z');
    const after = sampleReport(82, '2026-05-21T10:00:00.000Z');
    const delta = diffSnapshots(before, after);
    expect(delta.overall_delta).toBe(12);
    expect(delta.dimensions.schema.delta).toBe(12);
    expect(delta.elapsed_days).toBeCloseTo(1, 1);
  });

  test('null overall_score on either side → overall_delta = null', () => {
    const before = sampleReport(null, '2026-05-20T10:00:00.000Z');
    const after = sampleReport(80, '2026-05-21T10:00:00.000Z');
    const delta = diffSnapshots(before, after);
    expect(delta.overall_delta).toBe(null);
  });

  test('null overall_score on after side → overall_delta = null', () => {
    const before = sampleReport(80, '2026-05-20T10:00:00.000Z');
    const after = sampleReport(null, '2026-05-21T10:00:00.000Z');
    const delta = diffSnapshots(before, after);
    expect(delta.overall_delta).toBe(null);
  });

  test('null per-dimension score → per-dimension delta = null', () => {
    const before = sampleReport(80, '2026-05-20T10:00:00.000Z');
    before.dimensions.schema.score = null;
    const after = sampleReport(90, '2026-05-21T10:00:00.000Z');
    const delta = diffSnapshots(before, after);
    expect(delta.dimensions.schema.delta).toBe(null);
    expect(delta.dimensions.schema.before).toBe(null);
    expect(delta.dimensions.schema.after).toBe(90);
    // Other dimensions still compute numerically.
    expect(delta.dimensions.vocab.delta).toBe(10);
  });
});
