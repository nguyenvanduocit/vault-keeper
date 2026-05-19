#!/bin/bash
# git-sync-monitor: poll `git fetch --all` every $GIT_SYNC_INTERVAL seconds.
#
# AUTO-PULL policy (silent — no notification emitted):
#   - Current branch (HEAD):     `git merge --ff-only $upstream` when working tree is clean and local is not ahead.
#   - Other tracked branches:    `git update-ref refs/heads/$branch $upstream` when fast-forward is possible.
#
# CONFLICT NOTIFY policy (emit one stdout line — Claude surfaces to user):
#   - Local diverged: ahead>0 AND behind>0  → rebase/merge required (also covers force-push that left local
#                                             with unique commits).
#   - Working tree dirty on the current branch while upstream is behind → pull may conflict; suggest stash/commit.
#   - `git merge --ff-only` returned non-zero (FF unexpectedly impossible, e.g. local ref drifted mid-loop).
#   - `git update-ref` CAS failed for a non-current branch (ref moved between check and update).
#   - GIT_SYNC_NO_AUTOPULL=1 set (legacy notify-only mode) — every upstream move notifies.
#
# Args:
#   $1  repo dir (defaults to CWD if unset, but plugin passes ${CLAUDE_PROJECT_DIR})
#
# Env knobs:
#   GIT_SYNC_INTERVAL     poll seconds, default 10
#   GIT_SYNC_BRANCHES     space-separated branch allowlist, empty = all local branches with upstream
#   GIT_SYNC_NO_AUTOPULL  set to "1" to disable auto-pull and notify on every upstream move (legacy behavior)
#
# Stdout: 1 line per conflict event. Stderr: lifecycle + auto-pull info (NOT surfaced as notifications).

set -u

REPO="${1:-$PWD}"
INTERVAL="${GIT_SYNC_INTERVAL:-10}"
BRANCH_FILTER="${GIT_SYNC_BRANCHES:-}"
AUTOPULL_DISABLED="${GIT_SYNC_NO_AUTOPULL:-0}"

# --- guards: bail quietly if context is wrong, so plugin doesn't spam errors ---
if [ ! -d "$REPO" ]; then
  echo "[git-sync-monitor] repo dir does not exist: $REPO — exiting" >&2
  exit 0
fi
cd "$REPO" || exit 0
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[git-sync-monitor] not a git repo: $REPO — exiting" >&2
  exit 0
fi

# --- per-repo state file (survives across sessions so we still notify after a restart) ---
STATE_DIR="${TMPDIR:-/tmp}/git-sync-monitor"
mkdir -p "$STATE_DIR"
STATE_KEY=$(printf '%s' "$REPO" | tr '/ ' '__')
STATE_FILE="$STATE_DIR/$STATE_KEY.state"
touch "$STATE_FILE"

# --- singleton lock: only one monitor per repo across all Claude sessions ---
# Multiple sessions on the same repo would race state-file writes, double-fetch,
# and emit duplicate conflict notifications. PID-based lock with atomic O_EXCL
# create (`set -C`) + stale-lock recovery via `kill -0`.
#
# Dormant-wait pattern: secondary sessions DO NOT exit when the lock is held.
# Exiting would trigger Claude Code monitor framework's "stream ended"
# notification every time the user opens a new session on the same repo.
# Instead, secondary processes sleep dormant and retry — when the primary
# dies (its session closes → release_lock trap fires), one dormant process
# picks up the lock on the next poll iteration and takes over.
LOCK_FILE="$STATE_DIR/$STATE_KEY.lock"

acquire_lock() {
  if (set -C; echo "$$" > "$LOCK_FILE") 2>/dev/null; then
    return 0
  fi
  local holder
  holder=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 1   # lock genuinely held by a live process
  fi
  # Stale lock — previous holder crashed without cleanup. Reclaim.
  rm -f "$LOCK_FILE"
  (set -C; echo "$$" > "$LOCK_FILE") 2>/dev/null
}

release_lock() {
  # Defensive: only remove lock if we still own it (avoid clobbering a successor).
  # Dormant processes that never acquired the lock will no-op here — safe.
  [ "$(cat "$LOCK_FILE" 2>/dev/null)" = "$$" ] && rm -f "$LOCK_FILE"
}
# Traps installed BEFORE lock acquisition so the dormant-wait sleep is
# interruptible cleanly. EXIT runs on normal exit AND after explicit `exit`
# from signal handlers. INT/TERM handlers must call `exit` — otherwise bash
# interrupts `sleep`, runs the trap, then resumes the surrounding loop with
# state inconsistent (defeats singleton or leaves dormant orphans).
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

announced_dormant=0
until acquire_lock; do
  if [ "$announced_dormant" = "0" ]; then
    echo "[git-sync-monitor] another session already monitoring $REPO — staying dormant; will take over if primary exits" >&2
    announced_dormant=1
  fi
  sleep "$INTERVAL"
done

last_sha() {
  awk -v b="$1" '$1==b {print $3; exit}' "$STATE_FILE"
}

update_state() {
  local branch="$1" upstream="$2" sha="$3" tmp
  tmp=$(mktemp "$STATE_DIR/state.XXXXXX")
  awk -v b="$branch" '$1!=b' "$STATE_FILE" > "$tmp"
  printf '%s %s %s\n' "$branch" "$upstream" "$sha" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# Branch passes filter if filter is empty OR branch appears in space-padded list
branch_passes_filter() {
  [ -z "$BRANCH_FILTER" ] && return 0
  case " $BRANCH_FILTER " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ "$AUTOPULL_DISABLED" = "1" ]; then
  autopull_label="off (legacy notify-only)"
else
  autopull_label="on"
fi
echo "[git-sync-monitor] watching $REPO every ${INTERVAL}s (filter='${BRANCH_FILTER:-<all>}', autopull=$autopull_label)" >&2

while true; do
  # Silent fetch. Don't let stderr leak — fetch errors (auth prompt, no network)
  # would otherwise turn into notification spam.
  git fetch --all --quiet >/dev/null 2>&1 || true

  current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

  # Loop all local branches with an upstream
  git for-each-ref --format='%(refname:short) %(upstream:short)' refs/heads \
  | while read -r branch upstream; do
      [ -z "$upstream" ] && continue
      branch_passes_filter "$branch" || continue

      after=$(git rev-parse "$upstream" 2>/dev/null) || continue
      before=$(last_sha "$branch")

      if [ -z "$before" ]; then
        # First sighting — record silently, never spam on startup
        update_state "$branch" "$upstream" "$after"
        continue
      fi

      if [ "$before" = "$after" ]; then
        continue   # no upstream movement
      fi

      # Upstream moved — compute relationship between local branch ref and upstream ref
      counts=$(git rev-list --left-right --count "$branch...$upstream" 2>/dev/null || echo "? ?")
      ahead=$(echo "$counts" | awk '{print $1}')
      behind=$(echo "$counts" | awk '{print $2}')

      # If local is now fully in sync (user pulled out-of-band), just absorb silently
      if [ "$behind" = "0" ]; then
        update_state "$branch" "$upstream" "$after"
        continue
      fi

      short_before=$(printf '%s' "$before" | cut -c1-7)
      short_after=$(printf '%s' "$after"  | cut -c1-7)

      # --- Decide: auto-pull (silent) or notify (conflict) ---
      conflict_reason=""
      auto_pulled=0

      if [ "$AUTOPULL_DISABLED" = "1" ]; then
        # Legacy notify-only mode — every upstream move is a notification
        if [ "$ahead" != "0" ]; then
          conflict_reason="auto-pull disabled; diverged (ahead=$ahead, behind=$behind)"
        elif git merge-base --is-ancestor "$before" "$after" 2>/dev/null; then
          conflict_reason="auto-pull disabled; fast-forward available (behind=$behind)"
        else
          conflict_reason="auto-pull disabled; upstream history rewritten (behind=$behind)"
        fi
      elif [ "$ahead" != "0" ]; then
        # Diverged — local has commits not in upstream. Covers force-push leaving us with unique commits
        # and the normal "concurrent local + remote work" case. Auto-rebase is unsafe → notify.
        conflict_reason="local diverged from upstream (ahead=$ahead, behind=$behind) — manual rebase/merge required"
      elif [ "$branch" = "$current_branch" ] && ! git diff-index --quiet HEAD -- 2>/dev/null; then
        # Dirty working tree on the branch we're about to advance — pull may collide with edits.
        conflict_reason="working tree dirty on current branch — stash or commit before pulling (behind=$behind)"
      elif [ "$branch" = "$current_branch" ]; then
        # Safe to fast-forward HEAD. Use `merge --ff-only` instead of `pull --ff-only` to avoid
        # re-fetching and to keep auth-prompt risk zero.
        if merge_out=$(git merge --ff-only --quiet "$upstream" 2>&1); then
          echo "[git-sync-monitor] auto-FF current branch '$branch' by $behind commit(s) ($short_before..$short_after)" >&2
          auto_pulled=1
        else
          first_line=$(echo "$merge_out" | head -1 | tr -d '\r\n')
          conflict_reason="git merge --ff-only failed unexpectedly: ${first_line:-<no message>}"
        fi
      else
        # Non-current branch — advance the local ref via update-ref. CAS form ensures we only
        # advance if the ref is still at $before (no race with user `git checkout` + commit).
        if git update-ref "refs/heads/$branch" "$after" "$before" 2>/dev/null; then
          echo "[git-sync-monitor] auto-FF non-current branch '$branch' by $behind commit(s) ($short_before..$short_after)" >&2
          auto_pulled=1
        else
          conflict_reason="update-ref failed for non-current branch '$branch' (local ref moved between check and update)"
        fi
      fi

      if [ "$auto_pulled" = "1" ]; then
        update_state "$branch" "$upstream" "$after"
        continue
      fi

      # --- Notify: this is a conflict situation that needs user attention ---
      last_msg=$(git log -1 --format='%s' "$upstream" 2>/dev/null | tr -d '\r\n' | cut -c1-80)
      last_author=$(git log -1 --format='%an' "$upstream" 2>/dev/null)

      printf '[%s] GIT-SYNC CONFLICT: branch "%s" | %s..%s | ahead=%s behind=%s | upstream: "%s" by %s | reason: %s | ACTION: resolve manually in %s\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" \
        "$branch" \
        "$short_before" "$short_after" \
        "$ahead" "$behind" \
        "$last_msg" "$last_author" \
        "$conflict_reason" \
        "$REPO"

      update_state "$branch" "$upstream" "$after"
    done

  sleep "$INTERVAL"
done
