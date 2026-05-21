import { describe, test, expect } from 'bun:test';
import {
  ENTROPY_DEFAULTS,
  resolveEntropyConfig,
} from '../../lib/entropy/defaults.js';

describe('ENTROPY_DEFAULTS', () => {
  test('weights sum to 1.0', () => {
    const w = ENTROPY_DEFAULTS.weights;
    const total = w.schema + w.vocab + w.lifecycle + w.distribution;
    expect(Math.abs(total - 1.0)).toBeLessThan(1e-9);
  });

  test('object is frozen', () => {
    expect(Object.isFrozen(ENTROPY_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(ENTROPY_DEFAULTS.weights)).toBe(true);
    expect(Object.isFrozen(ENTROPY_DEFAULTS.lifecycle)).toBe(true);
  });
});

describe('resolveEntropyConfig', () => {
  test('null → defaults', () => {
    const cfg = resolveEntropyConfig(null);
    expect(cfg.weights.schema).toBe(0.30);
    expect(cfg.lifecycle.default.stale_after_days).toBe(90);
  });

  test('partial override merges shallow', () => {
    const cfg = resolveEntropyConfig({
      weights: { schema: 0.5, vocab: 0.5, lifecycle: 0, distribution: 0 },
    });
    expect(cfg.weights.schema).toBe(0.5);
    // Lifecycle untouched — still defaults
    expect(cfg.lifecycle.default.stale_after_days).toBe(90);
  });

  test('per-template lifecycle override takes precedence', () => {
    const cfg = resolveEntropyConfig({
      lifecycle: {
        perTemplate: { 'daily-note': { stale_after_days: 7 } },
      },
    });
    expect(cfg.lifecycle.perTemplate['daily-note'].stale_after_days).toBe(7);
    // Default still in place for other templates
    expect(cfg.lifecycle.default.stale_after_days).toBe(90);
  });

  test('returned config is frozen', () => {
    const cfg = resolveEntropyConfig(null);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.weights)).toBe(true);
  });

  test('deep freeze prevents mutation', () => {
    const cfg = resolveEntropyConfig(null);
    // Attempting to mutate should fail silently in non-strict mode, or throw in strict
    expect(() => {
      cfg.weights.schema = 0.5;
    }).toThrow();
  });
});
