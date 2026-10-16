# Pipeline guard, tools and worktree launcher

Deterministic support for the `*-pipeline-*` agent family (hybrid, mistral, free, ...). Prompts and
permissions in `../agents/` are the primary control; everything here is defense in depth plus the
parts that must not be left to a model: scoped commits, process cleanup, git-state tracking.

Only sessions whose agent name matches `*-pipeline-*` are affected. Other sessions are untouched.

## Files

| Path | Purpose |
|------|---------|
| `plugins/pipeline-guard.js` | Hooks: scratch env, write/git guards, session registry, git-state check, compaction context |
| `tools/_pipeline_core.js` | Shared logic (git, session registry, bash/path guards, commit planning, locks) |
| `tools/_pipeline_run.js` | `verify` and `smoke` runners (timeouts, process-group kill, port handling) |
| `tools/pipeline_state.ts` | Read-only: baseline, changed files (session / pre-existing / unattributed), anomalies |
| `tools/pipeline_commit.ts` | Commit only the session's files; never push, amend, branch or stash |
| `tools/pipeline_verify.ts` | lint / typecheck / tests / build with timeouts and a failure-class hint |
| `tools/pipeline_smoke.ts` | Start service, check, always stop it and free the port |
| `tools/pipeline_serve.ts` | Keep the service running for a browser (`start` / `status` / `stop`), always bounded |
| `tools/_pipeline_serve.js` | Service lifecycle: sh supervisor, time limit, owner-death detection, group kill |
| `bin/opencode-wt.mjs` | Opt-in isolated worktree: `start`, `finish`, `abort`, `list`, `gc` |
| `tools/_pipeline_*.test.mjs` | Tests, run by `manage-agents` (`npm test`) |

## Install

Not copied by `manage-agents export`. Mirror the layout into the OpenCode config directory
(`plugins/` and `tools/` must stay siblings: the plugin imports `../tools/_pipeline_core.js`):

```bash
cp -R agents/general/plugins/. ~/.config/opencode/plugins/
cp agents/general/tools/_pipeline_*.js agents/general/tools/pipeline_*.ts ~/.config/opencode/tools/
# optional launcher
ln -s "$PWD/agents/general/bin/opencode-wt.mjs" ~/.local/bin/opencode-wt
```

Emergency switch for the plugin: `OPENCODE_PIPELINE_GUARD=off`.

## What the plugin enforces

- `shell.env`: `TMPDIR`, `TMP`, `TEMP`, `PIPELINE_SCRATCH` point to a scratch directory inside the repo
  (`<git-common-dir>/opencode-scratch`, or `.opencode-scratch/` in a linked worktree, excluded from git);
  `GIT_EDITOR=:` and `GIT_MERGE_AUTOEDIT=no` keep merge, rebase and pull continuations from hanging on an
  interactive editor.
- Explicit `/tmp` (and `os.tmpdir()`) paths are also allowed for temporary command outputs and logs. Other
  `bash` writes (redirections, `cp`, `mv`, `rm`, `tee`, `curl -o`, `cd` ...) outside the repo or into `.git`
  are blocked. Reads are not restricted here.
- Blocks `edit` / `write` / `apply_patch` outside the repo or into `.git`.
- Git inspection and diagnostic subcommands, plus `git fetch` (without `--upload-pack`), are allowed for all
  roles. `ops`, `fast_lane`, `executor` and `refactorer` may also run `git pull` (without `--upload-pack`) and resolve
  conflicts with `git merge` / `git cherry-pick` (without `-e` / `--edit`), non-interactive `git rebase`
  (without `-i` / `--interactive` / `-x` / `--exec`), `git checkout --ours|--theirs|--merge <files>`,
  `git restore --staged|-S|--ours|--theirs|--merge <files>` and `git add <explicit-files>`; these commands
  also allow `-c core.editor=true|:`. `post_session` may additionally run `git commit` (without `--amend`,
  `-a` or `--no-verify`), `git add <explicit-files>` and `git restore --staged <files>` (prefer `pipeline_commit`).
  Destructive or workspace-escaping mutations remain blocked for every role: `push`, branch switching via
  `checkout <branch>` / `switch`, branch/worktree/stash/tag creation or deletion, `reset`, `clean` and plain
  working-tree `restore`.
- Refuses edits to a file that another **live** session (same repository, other root session, busy, process
  alive, updated in the last 15 minutes) has already edited. If parent sessions cannot be resolved it does
  not guess and does not block.
- On idle, compares git state with the session baseline and warns about new branches, worktrees, stashes or a
  changed branch.
- On idle of the root session, stops the service that session started with `pipeline_serve`.
- On compaction, keeps baseline, edited files and verification state in the summary.

Session state lives in `<git-common-dir>/opencode-pipeline/` (inside `.git`, never committable).

## Project contract: `.opencode/pipeline.json`

Optional, committed in the target repository. Without it, `pipeline_verify` autodetects commands
(npm/pnpm/yarn/bun scripts, `tsc`, go, cargo, pytest). If it contains no `smoke`/`serve` section,
`pipeline_smoke` and `pipeline_serve` automatically fall back to autodetected `package.json` `dev`/`start`
scripts when available.

```json
{
  "version": 1,
  "setup": "npm ci",
  "verify": {
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "test_targeted": "npx vitest run {files}",
    "test_fast": "npm test --silent",
    "test_full": "npm run test:all",
    "build": "npm run build"
  },
  "smoke": {
    "start": "npm run dev -- --port ${PORT}",
    "env": { "API_URL": "http://127.0.0.1:${PORT}" },
    "env_file": ".env.smoke",
    "ready": { "url": "http://127.0.0.1:${PORT}/health", "timeout_s": 60 },
    "checks": [
      { "name": "health", "url": "http://127.0.0.1:${PORT}/health", "expect_status": 200, "expect_body": "ok" },
      { "name": "cli", "cmd": "node scripts/ping.js", "expect_output": "pong" }
    ]
  },
  "serve": {
    "start": "npm run dev -- --port ${PORT}",
    "url": "http://127.0.0.1:${PORT}/",
    "ready": { "url": "http://127.0.0.1:${PORT}/", "timeout_s": 60 }
  },
  "timeouts": { "test_fast": 300 },
  "worktree": { "copy": [".env.local"] }
}
```

- `${PORT}` is a free port chosen per run (or set `smoke.port` for a fixed one; if it is taken the run is
  `blocked`, the foreign process is never killed). `ready` can use `url`, `port` or `log` (regex).
- `serve` (optional) is used by `pipeline_serve`, with the same fields as `smoke` plus `url` (the address handed
  to the browser, default `http://127.0.0.1:${PORT}/`). Without it, `pipeline_serve` uses the `smoke` section.
- Smoke checks only reach `localhost`. `env_file` must be inside the repo and its values are never echoed.
- Runs are serialized per repository (`verify` and `smoke` locks), so concurrent sessions do not fight over
  ports or half-written files.

## Serving for the browser: `pipeline_serve`

`pipeline_smoke` starts a service, checks it and always stops it, so nothing is left running for a browser.
`pipeline_serve` is for the visual validation done by `chrome_devtools`: `start` returns a localhost URL on a
free port, `stop` ends it. A start never leaves anything behind: the first of these ends the service.

1. `stop` by the owner (a service of another live session is refused), or the idle of the owning root session.
2. The supervisor notices the owning opencode process is gone, even after `kill -9` (about one second).
3. The time limit (default 900 s, at most 3600 s).

Stopping kills the whole process group, so grandchildren die too. Only one service per repository runs at a
time; a second `start` reuses it. It needs `/bin/sh` (macOS and Linux).

## Shared mode (default) and worktree mode (opt-in)

Shared mode: every session works in the current checkout on the current branch. File claims make the
second session stop instead of overwriting; commits contain only the committing session's files.

Worktree mode, for large or risky work:

```bash
opencode-wt start fix-login -- --agent hybrid-pipeline-orchestrator   # worktree in .git/opencode-worktrees/
opencode-wt finish fix-login   # rebase on the base branch, ff-only merge, remove worktree and branch
opencode-wt abort fix-login    # discard everything
opencode-wt gc [--dry-run]     # prune stale metadata and merged pipeline/* branches
```

`finish` never force-merges: with a dirty worktree, rebase conflicts, a moved base, or a main checkout that is
not on the base branch, it leaves the branch in place and prints why. Dependencies are not shared: use
`setup` (and `worktree.copy` for untracked files such as `.env.local`).

## Known limits

- The bash guard is a best-effort parser. It does not see what a program does internally (for example a test
  runner writing outside the repo); the agents' `external_directory: deny` covers the file tools, not child
  processes.
- Session ownership relies on the SDK exposing `parentID`; verify it after upgrading opencode.
- If the `pipeline_serve` supervisor itself is killed with SIGKILL, its service keeps running until `stop`, the
  idle of the owning session, or a manual kill: nothing else is watching it.
- Verified in a live opencode 1.18.29 (no model reply needed): the plugin loads, `chat.params` fires with the
  agent name, the root session is resolved, and the baseline with the files already modified is written.
  Hook signatures match the `@opencode-ai/plugin` 1.19.0 types. Not verified with a live model: blocking in
  `tool.execute.before`, the `shell.env` scratch directory, the claim recording in `tool.execute.after`, and
  compaction. They are covered by tests with a simulated client.
- opencode only loads the `default` export of a plugin file; keep helpers out of the plugin's named exports.
- opencode also fires `chat.params` for hidden internal agents (`title`, `summary`, `compaction`) on the same
  session id; the guard ignores them so they cannot switch it off.
- `experimental.session.compacting` is an experimental hook and may change.
