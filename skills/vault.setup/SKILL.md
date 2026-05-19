---
name: vault.setup
description: "Onboard a fresh repo to claude-code-vault-keeper — interview the user for vault shape (vault root, document types, path regex, owner format), scaffold `.claude/vault-keeper.json` + per-type templates with `validation_rules`, then verify the setup with `vault-keeper validate`. Wraps `vault-keeper init` rather than reinventing it; adds the interactive shaping `init` cannot do on its own. Use when the user says 'setup vault', 'init vault-keeper', 'bật vault-keeper cho repo này', 'thêm template mới', 'add document type', '/vault.setup'."
---

# vault.setup — onboard a repo to vault-keeper

When this skill is invoked, Claude shepherds the user through configuring the plugin for THIS repo. The skill is **idempotent** and **branching**: if no config exists, run full onboarding; if a config exists, run augment-mode (add a new template, edit existing rules) instead of scaffold.

## Pre-flight (silent unless something blocks)

Run in parallel via `Bash`:

1. **In a git repo** — `git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --is-inside-work-tree`. Not a repo → ask user: "Vault-keeper expects a git repo. Run `git init` first?" before continuing.
2. **vault-keeper on PATH** — `command -v vault-keeper || ls "${CLAUDE_PLUGIN_ROOT:-.claude/plugins/claude-code-vault-keeper}/cli/main.js"`. Neither → tell user: "Plugin CLI not reachable. Install with `claude plugin install claude-code-vault-keeper@vault-keeper`."
3. **Detect existing config** — `test -f "${CLAUDE_PROJECT_DIR}/.claude/vault-keeper.json"`. Exists → branch to **augment mode**. Missing → branch to **scaffold mode**.

## Mode A — scaffold mode (no config yet)

### Step 1 — interview vault shape via AskUserQuestion

Ask exactly these in ONE batched `AskUserQuestion` call:

- **vault root folder** — where vault documents live. Default `docs`. Options to surface: `docs`, `notes`, `vault`, `.` (whole repo).
- **document types** — which kinds of docs this vault tracks. Multi-select: `note`, `task`, `prd`, `decision`, `meeting`, `other` (free-form). Drives how many templates to scaffold.
- **path regex strictness** — `strict` (each type lives in its own folder, e.g. `docs/tasks/t-NNN-slug.md`) vs `loose` (any path under vault root, no naming enforcement).
- **owner convention** — `@github-handle`, `email`, `freeform`. Drives the `field_rules` for the `owner` field.

> Do NOT ask all of these in narrative prose. Use the `AskUserQuestion` tool. One call. The user picks; you proceed.

### Step 2 — scaffold via `vault-keeper init`

Run `vault-keeper init <vault-root> [--force]` to lay down the minimal skeleton (`.claude/vault-keeper.json` + a baseline template + sample doc). This is the **single source of truth** for scaffolding — do NOT hand-write the config or templates. If `init` refuses because the target dir is non-empty, surface that to the user and ask whether to pass `--force`. Never pass `--force` silently.

After `init` completes, you have:
- `.claude/vault-keeper.json` with `{ vaultRoot, vaultFolders }`
- `templates/note-template.md` with a baseline `validation_rules`
- One sample doc under `<vault-root>/notes/note-001-hello.md`

### Step 3 — extend templates per the interview answers

For each additional document type the user selected (beyond `note`), create `templates/<type>-template.md` using the **strict** or **loose** path_regex they chose. Copy the shape from `examples/example/templates/<type>-template.md` — those files are the canonical reference. Apply the owner convention to `field_rules`:

- `@github-handle` → `{ field: owner, type: string, pattern: "^@[a-z0-9-]+$" }`
- `email` → `{ field: owner, type: string, pattern: ".+@.+\\..+" }`
- `freeform` → no rule on owner

### Step 4 — verify

Run `vault-keeper validate --root "${CLAUDE_PROJECT_DIR}"`. Expect exit 0. If non-zero, paste the first error to the user and stop — do NOT patch the template silently. The user must see what their answers produced.

Then run `vault-keeper doctor` and surface the result. End with one line confirming next steps: how to author a new doc, and where to edit the templates.

## Mode B — augment mode (config exists)

Skip scaffold. Ask the user via `AskUserQuestion`:

- **what to do** — `add a new document type`, `edit an existing template`, `change vaultRoot/vaultFolders`, `none — re-validate only`.

Then:

- **add new type** → `ls templates/` to list current ones, ask for the new type name + path_regex shape, create the new template file modeled on the closest existing one, run validate.
- **edit existing** → open the chosen template with the user, propose the edit explicitly (diff), apply only on confirmation, run validate.
- **change config** → edit `.claude/vault-keeper.json` directly, run `vault-keeper doctor` then `validate`.
- **re-validate only** → just run `validate` and report.

## Refusal contract

If the user asks for something the plugin CANNOT enforce via `validation_rules` (e.g. cross-document graph rules, custom-language frontmatter parsing), say so explicitly and point at `CLAUDE.md`'s template-vs-code-branch rule. Do not add hardcoded vault knowledge to plugin JS. This skill never edits files under `cli/`, `lib/`, or `server/`.

## Output contract

After the skill finishes:
1. List of files created / modified (one line each, file:size).
2. The `vault-keeper validate` exit code + first 3 lines of report.
3. One concrete next-step suggestion: `try authoring a doc at <path>` or `run /vault.health to see live diagnostics`.

That's the whole output. No preamble, no "I will now...", no recap of the interview answers.
