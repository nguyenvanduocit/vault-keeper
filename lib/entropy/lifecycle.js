/**
 * lifecycle.js — stale / orphan / zombie detection.
 *
 * Inputs are pure data:
 *   - docs:    Array<{filepath, template, frontmatter, mtime, created_at}>
 *              (mtime/created_at are Date objects, supplied by caller from
 *               git log %at or fs.stat — this primitive never touches the FS)
 *   - incoming: Map<string, number>  filepath → incoming link count (Task 2)
 *   - lifecycleCfg: { default: {...}, perTemplate: {...} }  (Task 3)
 *   - now:    reference Date for "days since" math (testable)
 *
 * A doc may appear in multiple categories; decay_score counts each doc at
 * most once.
 */

const DAY_MS = 86400 * 1000;

export function measureLifecycle(docs, incoming, lifecycleCfg, now) {
  const stale_docs = [];
  const orphan_docs = [];
  const zombie_docs = [];
  const decayed = new Set();

  for (const d of docs) {
    const thresholds = resolveThresholds(d.template, lifecycleCfg);

    const daysIdle = Math.floor((now - d.mtime) / DAY_MS);
    if (daysIdle > thresholds.stale_after_days) {
      stale_docs.push({ path: d.filepath, days_idle: daysIdle, template: d.template });
      decayed.add(d.filepath);
    }

    const daysSinceCreated = Math.floor((now - d.created_at) / DAY_MS);
    const inCount = incoming.get(d.filepath) ?? 0;
    if (inCount === 0 && daysSinceCreated > thresholds.orphan_grace_days) {
      orphan_docs.push({
        path: d.filepath,
        incoming_links: 0,
        days_since_created: daysSinceCreated,
      });
      decayed.add(d.filepath);
    }

    const status = d.frontmatter?.status;
    if (
      typeof status === 'string' &&
      thresholds.zombie_status_set.includes(status) &&
      daysIdle > thresholds.zombie_after_days
    ) {
      zombie_docs.push({
        path: d.filepath,
        status_field: status,
        stuck_for_days: daysIdle,
      });
      decayed.add(d.filepath);
    }
  }

  const decay_score = docs.length === 0 ? 0 : decayed.size / docs.length;
  return { stale_docs, orphan_docs, zombie_docs, decay_score };
}

function resolveThresholds(templatePath, cfg) {
  const dflt = cfg.default;
  const override = (cfg.perTemplate ?? {})[templatePath] ?? {};
  return {
    stale_after_days: override.stale_after_days ?? dflt.stale_after_days,
    zombie_after_days: override.zombie_after_days ?? dflt.zombie_after_days,
    orphan_grace_days: override.orphan_grace_days ?? dflt.orphan_grace_days,
    zombie_status_set: override.zombie_status_set ?? dflt.zombie_status_set,
  };
}
