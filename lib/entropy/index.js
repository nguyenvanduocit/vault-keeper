/**
 * Public barrel for the entropy engine. Stable external surface for both
 * the CLI subcommand and any future consumers.
 */

export { measureEntropy } from './measure.js';
export { writeSnapshot, readLatestSnapshot, listSnapshots, diffSnapshots } from './snapshot.js';
export { aggregateScore, dimensionHealth } from './score.js';
export { ENTROPY_DEFAULTS, resolveEntropyConfig } from './defaults.js';
