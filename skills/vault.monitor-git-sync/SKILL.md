---
name: vault.monitor-git-sync
description: "Start the git-sync-watcher monitor for THIS session — auto fast-forwards `origin/main` into local on safe upstream advances; notifies only when a manual-resolution conflict is detected. Spawns scripts/poll-fetch.sh via Claude Code's Monitor tool as a persistent background task; the monitor lives until the session ends or you call TaskStop. Use when the user says 'start git-sync monitor', 'watch git sync', 'auto pull', 'bật git monitor', '/vault.monitor-git-sync'."
---

# vault.monitor-git-sync — start git-sync-watcher

When this skill is invoked, Claude MUST spawn `scripts/poll-fetch.sh "${CLAUDE_PROJECT_DIR}"` via the built-in **`Monitor` tool** as a persistent background task. Do this silently — no preamble, no status narration, no "I will now arm the monitor" message. Just call the tool and continue working.

> **Do NOT trust the plugin's `monitors.json` `when: on-skill-invoke:vault.monitor-git-sync` field to auto-spawn.** That trigger is currently inert on the runtime — the Monitor tool call is the only thing that actually starts the watcher. Without the explicit `Monitor` call, nothing is running.

## Pre-flight (silent — bail out only on failure)

Run in parallel via `Bash`; do NOT narrate to the user unless one fails:

1. **Git repo present** — `git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --is-inside-work-tree` must return `true`. If not → refuse with one line: "not in a git repo".
2. **Poll script exists** — `ls "${CLAUDE_PLUGIN_ROOT:-.claude/plugins/claude-code-vault-keeper}/scripts/poll-fetch.sh"` must succeed.
3. **Dedup** — if a `poll-fetch.sh` process for this repo is already running (`ps aux | grep '[p]oll-fetch.sh'`), STOP. Do not spawn a duplicate, do not announce — silent no-op.

If any check fails, surface the single root cause and stop. Otherwise proceed to arming without commentary.

## Arming step (the call that ACTUALLY starts the monitor)

Invoke the `Monitor` tool with these exact parameters (resolve env vars to absolute paths first):

```
Monitor({
  description: "Vault-keeper git-sync — auto fast-forward main, notify on conflict",
  command: "\"${CLAUDE_PLUGIN_ROOT}/scripts/poll-fetch.sh\" \"${CLAUDE_PROJECT_DIR}\"",
  persistent: true,
  timeout_ms: 3600000
})
```

Notes:
- `persistent: true` is required — `poll-fetch.sh` is an infinite poll loop.
- Clean fast-forwards advance silently; only manual-resolution conflicts emit stdout. Do not add filter wrappers.
- If the task exits within seconds, surface the failure briefly with `TaskOutput`. Otherwise: silence is success.

## After arming — stay silent

Do NOT send a user-facing confirmation, do NOT explain the limitation, do NOT list "how to stop early". The user knows what they asked for. Just continue with the next user request (or end the turn if there is none). The Monitor tool's own ack already exists in the transcript — no echo needed.

## Notification contract (what Claude does when the monitor emits)

ONLY when the monitor emits a stdout event:

1. **Acknowledge in one line** — branch + conflict shape, e.g.:
   `git-sync-watcher: conflict on main — local diverged from origin/main, manual rebase required`.
2. **Do not auto-resolve.** Conflicts mean local + remote both advanced past a common base — resolution is owned by the user (or by an explicit `/vault.sync`).
3. **Suggest next step**: `/vault.sync` (stash → `git pull --rebase` → restore → commit → push) or manual `git pull --rebase` + resolve markers.

The monitor never modifies tracked files on conflict — it only reports. Clean fast-forwards advance the local branch silently.

## Relationship to `/vault.sync`

`vault.sync` is the explicit one-shot bidirectional sync (pull-rebase + commit auto-message + push). `git-sync-watcher` is the passive background watcher that handles the trivial case (server advanced cleanly → local fast-forwards silently). They compose — `vault.sync` always re-fetches before pushing, independent of whether this watcher is armed.
