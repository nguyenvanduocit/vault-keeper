---
name: vault.changelog
description: "Read-only remote changelog for THIS vault — runs `git fetch` (safe: only updates remote-tracking refs), then shows what's new on `origin/<branch>` that local doesn't have yet, recent activity across the vault folders, most-touched docs and top contributors. Filters to `vaultFolders` from `.claude/vault-keeper.json` (default `[\".\"]`), never merges, never modifies working tree. Hands off to `/vault.sync` to integrate. Use when the user says 'vault changelog', 'what's new in vault', 'remote vault history', 'recent changes', 'show remote commits', 'có gì mới trong vault', 'vault có gì mới', 'lịch sử vault', 'xem commit từ remote', '/vault.changelog'."
---

# vault.changelog — read-only remote changelog

This skill answers one question: **"what changed in the vault on remote that I haven't pulled yet, and what's the recent shape of activity?"** It only touches remote-tracking refs (`git fetch`) — it never merges, rebases, modifies the working tree, or runs `vault.sync` for the user. For integration, hand off to `/vault.sync`.

## Pre-flight (silent — proceed unless something is fatal)

Resolve project root: `${CLAUDE_PROJECT_DIR:-$PWD}`. Run in parallel via `Bash`:

1. **In a git repo** — `git -C <root> rev-parse --is-inside-work-tree` returns `true`. Otherwise refuse with one line: `vault.changelog: not in a git repo`.
2. **Vault folder config** — read `.claude/vault-keeper.json` if present. Capture `vaultFolders` (default `["."]`) and `vaultRoot` (default `.`). These become git pathspec for every log query so output stays scoped to the vault.
3. **Upstream tracking** — `git rev-parse --abbrev-ref --symbolic-full-name @{u}`. No upstream → switch to **local-only mode** (note in report; skip ahead/behind + remote-new sections, keep recent activity). Don't ask the user to configure one — that's a `/vault.sync` concern.
4. **Has remote** — `git remote`. None → local-only mode same as above.

## Step 1 — fetch (unless `--no-fetch`)

```
git fetch --all --tags --prune
```

`--prune` so deleted remote branches stop appearing. `--tags` so changelog-style tag reads work.

`--no-fetch` flag → skip this step entirely. Use this when `vault.monitor-git-sync` is armed (the watcher fetched seconds ago) or when offline. Note `(fetch skipped)` in the output.

A fetch failure (network down, auth missing) is non-fatal — switch to local-only mode for this run, surface the fetch error once at the top of the report, continue.

## Step 2 — ahead/behind summary

```
git rev-list --left-right --count <upstream>...HEAD
```

Output is `<behind>\t<ahead>` (behind = remote commits local doesn't have, ahead = local commits remote doesn't have). Capture both.

## Step 3 — what's new on remote (vault folders only)

The headline section. Show commits remote has that local does not, scoped to `vaultFolders`, newest first to match the output contract:

```
git log HEAD..<upstream> --no-merges \
  --pretty='format:%h%x09%ad%x09%an%x09%s' --date=short \
  -- <vaultFolders…>
```

For each commit, also collect touched files via `git show --name-only --format= <sha> -- <vaultFolders…>` (cap at 5 files per commit; `…and K more` for the rest).

Cap commit list at `--limit <N>` (default 20, max 100). If truncated, show `… and K older commits — use --since <ref|date> or --limit` at the bottom.

## Step 4 — `--since` mode (alternative range)

If user passed `--since <value>`, **detect ref vs date deterministically before logging** — `git log --since=v1.0` silently returns zero rows because `v1.0` isn't a parseable date, which would masquerade as "nothing changed":

```
git rev-parse --verify --quiet <value>^{commit}
```

Exit 0 → `<value>` is a ref/tag/sha → use `git log <value>..<upstream>` (or `<value>..HEAD` if no upstream).
Exit non-zero → treat as a date string → use `git log --since=<value> <upstream>` (or `--since=<value>` if no upstream).

In both shapes, scope to `vaultFolders` and use the same `--pretty/--date` format as Step 3. `--since` mode overrides the `HEAD..<upstream>` range and shows commits in the given window across local + remote-tracking refs.

## Step 5 — recent activity digest (last 30 days)

Independent of ahead/behind — answers "how alive is this vault?":

```
git log --since='30 days ago' --no-merges \
  --pretty='format:%h%x09%ad%x09%an%x09%s' --date=short \
  -- <vaultFolders…>
```

From this set, compute:

- **Most touched docs** — `git log --since='30 days ago' --name-only --pretty=format: -- <vaultFolders…> | sort | uniq -c | sort -rn | head -10`. Display `path  —  K commits`.
- **Top contributors** — `git log --since='30 days ago' --pretty='%an' -- <vaultFolders…> | sort | uniq -c | sort -rn | head -5`. Display `name  —  K commits`.

If the vault is younger than 30 days, the window shrinks to repo lifetime; note this.

## Step 6 — `--all-branches` mode (optional)

If the user passes `--all-branches`, replace `<upstream>` with the union of all remote branches and exclude every local branch (not just HEAD's ancestry — otherwise sibling local branches still show up as "new"):

```
git log --remotes='origin/*' --not --branches --no-merges \
  --pretty='format:%h%x09%ad%x09%d%x09%an%x09%s' --date=short \
  -- <vaultFolders…>
```

The extra `%d` column shows which ref each commit lives on. Useful for vaults with feature branches the user hasn't checked out yet.

## Output contract

A single multi-line block, no preamble. Sections that have nothing to show collapse to a single dash line — don't omit them, the reader scans for shape:

```
vault.changelog — <branch> ↔ <remote> (vault folders: <vaultFolders>)

Remote
  fetched     <UTC timestamp>   (or `(fetch skipped)` / `(fetch failed: <reason>)`)
  ahead       <N> local commits not yet on <remote>/<branch>
  behind      <M> remote commits not yet local

What's new on remote (HEAD..<upstream>, vault-scoped)
  <sha>  <date>  <author>  <subject>
         files: <path>, <path>, … and K more
  …
  (or:  — none —)

Recent activity (last 30 days, vault-scoped)
  <sha>  <date>  <author>  <subject>
  …
  (or:  — none —)

Most touched docs (last 30 days)
  <path>                                    K commits
  …

Top contributors (last 30 days)
  <name>                                    K commits
  …

vault.changelog: <M> new remote, <N> local-ahead — run /vault.sync to integrate
```

Sort: "what's new" reverse-chrono (newest first); "recent activity" reverse-chrono; "most touched" + "top contributors" by count desc.

If `--all-branches` was used, the "What's new on remote" section's header becomes `What's new across all remote branches` and each row includes the branch decoration column.

## What this skill DOES NOT do

- Does NOT run `git pull`, `git merge`, `git rebase`, `git reset`, or any ref-moving operation on local branches. `git fetch` updates only remote-tracking refs (`refs/remotes/...`) and is the only network/state op this skill performs.
- Does NOT modify files. Working tree stays untouched.
- Does NOT auto-trigger `/vault.sync`. The handoff is a suggestion in the last line; the user decides.
- Does NOT loop. One run, one report, exit.
- Does NOT validate documents. For per-doc rule violations use `/vault.health`.

## Composition

- With **`vault.monitor-git-sync`** — the watcher fast-forwards `origin/<branch>` into local silently when possible, so by the time the user runs `/vault.changelog`, the local branch may already be up-to-date. That's expected — the "What's new on remote" section will be empty and "ahead/behind" will be `0/0`. Recent activity still tells the story. Use `--no-fetch` if the watcher just ran to avoid a redundant network call.
- With **`/vault.sync`** — `vault.changelog` is the read-only preview; `vault.sync` is the write-side integration. The final output line of `vault.changelog` always names `/vault.sync` as the next step when `behind > 0` or there are uncommitted local docs.
- With **`/vault.health`** — independent surfaces: one answers "what changed?", the other answers "what's broken?". Run them in either order.

## Exit contract

Last line is one of:

- `vault.changelog: <M> new remote, <N> local-ahead — run /vault.sync to integrate` (when there's anything to integrate)
- `vault.changelog: in sync with <remote>/<branch> — last activity <date>` (when ahead=behind=0)
- `vault.changelog: local-only mode — no upstream tracking, showing recent activity only` (when no remote/upstream)

No emoji, no celebration. Evidence over enthusiasm — same contract as `/vault.health`.
