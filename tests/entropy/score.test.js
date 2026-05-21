import { describe, test, expect } from 'bun:test';
import { aggregateScore, dimensionHealth } from '../../lib/entropy/score.js';
import { ENTROPY_DEFAULTS } from '../../lib/entropy/defaults.js';

describe('dimensionHealth', () => {
  test('chaos 0 → health 100', () => {
    expect(dimensionHealth(0)).toBe(100);
  });
  test('chaos 1 → health 0', () => {
    expect(dimensionHealth(1)).toBe(0);
  });
  test('chaos 0.3 → health 70', () => {
    expect(dimensionHealth(0.3)).toBe(70);
  });
  test('null chaos → null health', () => {
    expect(dimensionHealth(null)).toBe(null);
  });
});

describe('aggregateScore', () => {
  test('all 100 → 100', () => {
    const out = aggregateScore(
      { schema: 0, vocab: 0, lifecycle: 0, distribution: 0 },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(100);
  });

  test('weighted avg with defaults', () => {
    // chaos: schema 0.2, vocab 0.4, lifecycle 0.1, distribution 0.3
    // health: 80, 60, 90, 70
    // defaults: 0.30*80 + 0.25*60 + 0.30*90 + 0.15*70 = 24 + 15 + 27 + 10.5 = 76.5 → 77
    const out = aggregateScore(
      { schema: 0.2, vocab: 0.4, lifecycle: 0.1, distribution: 0.3 },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(77);
  });

  test('user weights override', () => {
    // chaos: schema 0.5, vocab 0.5; weights schema=1, vocab=0
    // health: 50, 50; weighted: 1*50 + 0*50 = 50
    const out = aggregateScore(
      { schema: 0.5, vocab: 0.5, lifecycle: 0.5, distribution: 0.5 },
      { schema: 1, vocab: 0, lifecycle: 0, distribution: 0 },
    );
    expect(out).toBe(50);
  });

  test('null chaos dimension excluded from average', () => {
    // schema=0, distribution=0 known; vocab and lifecycle = null (skipped)
    // remaining weights: schema 0.30 + distribution 0.15 = 0.45
    // weighted: (0.30*100 + 0.15*100) / 0.45 = 100
    const out = aggregateScore(
      { schema: 0, vocab: null, lifecycle: null, distribution: 0 },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(100);
  });

  test('all dimensions null → null', () => {
    const out = aggregateScore(
      { schema: null, vocab: null, lifecycle: null, distribution: null },
      ENTROPY_DEFAULTS.weights,
    );
    expect(out).toBe(null);
  });
});
