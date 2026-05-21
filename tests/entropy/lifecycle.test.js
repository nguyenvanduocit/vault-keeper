import { describe, test, expect } from 'bun:test';
import { measureLifecycle } from '../../lib/entropy/lifecycle.js';

const NOW = new Date('2026-05-21T10:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400 * 1000);

const doc = ({
  filepath = '/v/notes/a.md',
  template = 'templates/note-template.md',
  frontmatter = {},
  mtime = NOW,
  created_at = NOW,
} = {}) => ({ filepath, template, frontmatter, mtime, created_at });

const defaultCfg = {
  default: {
    stale_after_days: 90,
    zombie_after_days: 30,
    orphan_grace_days: 14,
    zombie_status_set: ['in-progress', 'draft', 'wip'],
  },
  perTemplate: {},
};

describe('measureLifecycle — stale', () => {
  test('mtime older than threshold → stale', () => {
    const out = measureLifecycle(
      [doc({ mtime: daysAgo(100) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.stale_docs.length).toBe(1);
    expect(out.stale_docs[0].days_idle).toBe(100);
  });

  test('per-template override beats default', () => {
    const out = measureLifecycle(
      [doc({ template: 'templates/daily-note.md', mtime: daysAgo(10) })],
      new Map(),
      {
        default: defaultCfg.default,
        perTemplate: { 'templates/daily-note.md': { stale_after_days: 7 } },
      },
      NOW,
    );
    expect(out.stale_docs.length).toBe(1);
  });
});

describe('measureLifecycle — orphan', () => {
  test('zero incoming links past grace period → orphan', () => {
    const out = measureLifecycle(
      [doc({ filepath: '/v/notes/a.md', created_at: daysAgo(30) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.orphan_docs.length).toBe(1);
  });

  test('within grace period → not orphan', () => {
    const out = measureLifecycle(
      [doc({ created_at: daysAgo(5) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.orphan_docs.length).toBe(0);
  });

  test('one incoming link → not orphan', () => {
    const out = measureLifecycle(
      [doc({ filepath: '/v/notes/a.md', created_at: daysAgo(30) })],
      new Map([['/v/notes/a.md', 1]]),
      defaultCfg,
      NOW,
    );
    expect(out.orphan_docs.length).toBe(0);
  });
});

describe('measureLifecycle — zombie', () => {
  test('status in zombie set + stuck past threshold', () => {
    const out = measureLifecycle(
      [doc({ frontmatter: { status: 'in-progress' }, mtime: daysAgo(40) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.zombie_docs.length).toBe(1);
  });

  test('status not in zombie set → not zombie', () => {
    const out = measureLifecycle(
      [doc({ frontmatter: { status: 'done' }, mtime: daysAgo(40) })],
      new Map(),
      defaultCfg,
      NOW,
    );
    expect(out.zombie_docs.length).toBe(0);
  });
});

describe('measureLifecycle — decay_score', () => {
  test('dedupe across categories', () => {
    const docs = [
      doc({ filepath: '/v/a.md', mtime: daysAgo(100), created_at: daysAgo(100) }),
      doc({ filepath: '/v/b.md', created_at: daysAgo(60) }),
      doc({ filepath: '/v/c.md', frontmatter: { status: 'draft' }, mtime: daysAgo(40), created_at: daysAgo(40) }),
      doc({ filepath: '/v/d.md' }),
    ];
    const incoming = new Map([
      ['/v/a.md', 1],
      ['/v/c.md', 1],
    ]);
    const out = measureLifecycle(docs, incoming, defaultCfg, NOW);
    expect(out.decay_score).toBeCloseTo(3 / 4, 5);
  });

  test('empty vault → 0', () => {
    const out = measureLifecycle([], new Map(), defaultCfg, NOW);
    expect(out.decay_score).toBe(0);
  });
});
