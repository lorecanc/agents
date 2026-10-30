# Pipeline guard, tools and worktree launcher

Deterministic support for the `*-pipeline-*` agent family (hybrid, mistral, free, ...). Prompts and
permissions in `../agents/` are the primary control; everything here is defense in depth plus the
parts that must not be left to a model: scoped commits, process cleanup, git-state tracking.

Only sessions whose agent name matches `*-pipeline-*` are affected. Other sessions are untouched.

## Files

| Path | Purpose |
|------|---------|
| `plugins/pipeline-guard.js` | Hooks: scratch env, write/git guards, session registry, activity log, git-state check, compaction context |
| `tools/_pipeline_core.js` | Shared logic (git, session registry, activity log, bash/path guards, commit planning, locks) |
| `tools/_pipeline_run.js` | `verify` and `smoke` runners (timeouts, process-group kill, port handling) |
| `tools/pipeline_state.ts` | Read-only: baseline, changed files (session / pre-existing / unattributed), anomalies, recorded `activity` |
| `tools/pipeline_env.ts` | Read-only Phase 0 probe: Docker, binaries, contract, workspaces, guard/tools, MCP, env var presence, verification outlook |
| `tools/_pipeline_env.js` | Probe logic for `pipeline_env` (bounded, never throws, never returns env values) |
| `tools/pipeline_commit.ts` | Commit only the session's files; never push, amend, branch or stash |
| `tools/pipeline_verify.ts` | lint / typecheck / tests / build with timeouts and a failure-class hint |
| `tools/pipeline_smoke.ts` | Start service, check, always stop it and free the port |
| `tools/pipeline_serve.ts` | Keep the service running for a browser (`start` / `status` / `stop`), always bounded |
| `tools/_pipeline_serve.js` | Service lifecycle: sh supervisor, time limit, owner-death detection, group kill |
| `bin/opencode-wt.mjs` | Opt-in isolated worktree: `start`, `finish`, `abort`, `list`, `gc` |
| `tools/_pipeline_*.test.mjs` | Tests, run by `manage-agents` (`npm test`) |

## Install

Sources live in `src/plugins` and `src/tools` (never edit the generated `export/`). `manage-agents export` installs
the plugin, every `pipeline_*` tool and the helper modules they import together with the pipeline agents, and
`category check` fails when an agent permits a `pipeline_*` tool that is not shipped. To install by hand instead, mirror
the layout into the OpenCode config directory (`plugins/` and `tools/` must stay siblings: the plugin imports `../tools/_pipeline_core.js`,
and `pipeline_env` looks for `../plugins/pipeline-guard.js` next to its own directory):

```bash
cp src/plugins/pipeline-guard.js ~/.config/opencode/plugins/
cp src/tools/_pipeline_*.js src/tools/pipeline_*.ts ~/.config/opencode/tools/
rm -f ~/.config/opencode/tools/_pipeline_*.test.mjs   # tests are not needed at runtime
# optional launcher
ln -s "$PWD/src/bin/opencode-wt.mjs" ~/.local/bin/opencode-wt
```

Emergency switch for the plugin: `OPENCODE_PIPELINE_GUARD=off`.

## What the plugin enforces

- `shell.env`: `TMPDIR`, `TMP`, `TEMP`, `PIPELINE_SCRATCH` point to a scratch directory inside the repo
  (`<git-common-dir>/opencode-scratch`, or `.opencode-scratch/` in a linked worktree, excluded from git);
  `GIT_EDITOR=:` and `GIT_MERGE_AUTOEDIT=no` keep merge, rebase and pull continuations from hanging on an
  interactive editor.
- Explicit `/tmp` (and `os.tmpdir()`) paths are also allowed for temporary command outputs and logs. Except for
  the target-scoped removals below, `bash` writes (redirections, `cp`, `mv`, `tee`, `curl -o`, `cd` ...) outside
  the repo or into `.git` are blocked. Reads are not restricted here.
- Path-checks `edit`, `write`, `multiedit`, `apply_patch` and `patch`, blocking writes outside the repo or into
  `.git`.
- Target-scoped `rm`, `rm -f`, `rm -rf` and `rmdir` are allowed for coding roles (`executor`, `refactorer`,
  `fast_lane`, `tester`) on explicit subpaths inside the repo (excluding `.git`), `$PIPELINE_SCRATCH` or `/tmp`.
  Root targets `.`, `./`, `..`, `/`, `~`, `.git`, paths into `.git`, and wildcard targets are blocked.
- Git inspection and diagnostic subcommands, plus `git fetch` (without `--upload-pack`), are allowed for all
  roles. `ops`, `fast_lane`, `executor` and `refactorer` may also run `git pull` (without `--upload-pack`) and resolve
  conflicts with `git merge` / `git cherry-pick` (without `-e` / `--edit`), non-interactive `git rebase`
  (without `-i` / `--interactive` / `-x` / `--exec`), `git checkout --ours|--theirs|--merge <files>`,
  `git restore --staged|-S|--ours|--theirs|--merge <files>`, `git add <explicit-files>`, and `git mv` / `git rm`
  on explicit repo paths; these commands also allow `-c core.editor=true|:`. `post_session` may additionally run
  `git commit` (without `--amend`, `-a` or `--no-verify`), `git add <explicit-files>`, `git restore --staged <files>`,
  and `git rm --cached` (prefer `pipeline_commit`).
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

## Activity log

For post-mortems based on recorded data instead of the orchestrator's recollection, the plugin appends one JSON
line per event to `<git-common-dir>/opencode-pipeline/logs/<rootId>.jsonl` (one file per root session, shared by
all its subagents). Every event carries `at` (epoch ms), `sessionId` and `agent`:

| `type` | Fields |
|--------|--------|
| `tool` | `tool`, `callId`, `ok`, `command` (bash command or file path, redacted, at most ~300 chars), `exit` (when known), `error` (short), `denied: true` when the error text looks like a permission denial (`permission`, `denied`, `rejected`, `prevents you from using`) |
| `guard_block` | `tool`, `callId`, `command`, `reason` (the guard's message) |
| `permission` | `event` (`permission.asked` / `permission.updated` / `permission.replied`), `permission`, `pattern`, `callId`, `decision` (null for asks) |
| `steps` | `tool_calls`, `llm_calls` per session, written when that session goes idle and on process exit |
| `session_error` | `error` (short) |
| `truncated` | `dropped`: the file is capped at 512 KB; when full, the oldest half is dropped |

Successful calls come from `tool.execute.after`; failed ones (including permission denials, which never reach the
after hook) from `message.part.updated` events with a tool part in `error` state. Logging is fail-open: a write
error is ignored and never blocks a call. Logs are removed with their stale session records
(`removeStaleSessions`), orphan logs once older than 7 days. `pipeline_state` summarizes the log as `activity`:
`per_agent` (tool calls, errors, denied, guard blocks, sessions), `subagents` (tool and LLM calls per child
session), `errors`, the last 30 `denied` commands (agent, command, reason, source) and `guard_blocks`, and
`permissions` counts.

## Environment probe: `pipeline_env`

Read-only, called once by the orchestrator at session start (Phase 0) so the planner writes a verification plan
the machine can actually run. Optional `workspace` argument (repo-relative sub-project). It reports:

- `docker`: CLI path, sockets found (`$DOCKER_HOST`, `/var/run/docker.sock`, `~/.docker/run`, colima, OrbStack,
  Rancher Desktop, rootless/podman), daemon reachable (`docker info`, 3 s timeout, only if the CLI exists).
- `binaries`: PATH lookup (no execution) of database servers/clients, language runtimes and test runners, plus
  Homebrew keg-only / Postgres.app installs that are not on PATH.
- `contract`: `.opencode/pipeline.json` existence and problems, verify checks defined vs autodetected vs missing,
  declared `services` (name, kind, image), `smoke` / `serve`, `workspaces`, unknown top-level keys.
- `workspaces_detected`: directories up to depth 2 with `package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, `pom.xml` or `build.gradle(.kts)` (vendored and build dirs skipped).
- `pipeline`: whether the guard registered this session (root record, baseline), which `pipeline_*` tools are
  installed next to it, whether the plugin file is present.
- `mcp`: MCP server names / type / enabled flag from the opencode config files (never commands, URLs or headers).
- `env_vars`: for each name in `.env.example` / `.env.sample`, whether it is set. Values are never returned and
  `.env` is never read.
- `verification_outlook`: `unit_tests`, `db_backed_tests`, `runtime_smoke`, `browser`, each `feasible`
  (`true` / `false` / `"unknown"` / `"n/a"`) with a reason.

It never modifies anything and never throws: a failing probe becomes `{ "status": "unknown", "reason": ... }`.

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
- `verify.test_filter` runs tests by name (`pipeline_verify` `filter` argument); it must contain `{filter}` and may
  contain `{files}`. `{packages}` expands to the Go packages (`./dir`) of the given files. Without a contract,
  `test_targeted` and `test_filter` are autodetected for pytest, vitest, jest, go (and cargo for `test_filter`).
- `services` declares dependencies started for a run and always stopped after it: `pipeline_verify`
  `with_services: ["db"]`, or `smoke.services: ["db"]`. `{ "kind": "postgres", "version": "16" }` is a throwaway
  cluster (native `initdb`/`postgres` when installed, otherwise Docker if the daemon is reachable, otherwise
  `blocked` / `env`) exporting `DATABASE_URL` (or `env_var`) and `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`. A custom
  service is `{ "start", "ready", "env", "stop"? }` with `${PORT}`.
- `workspaces.<dir>` holds `verify`, `services` and `timeouts` for a sub-project; `pipeline_verify` `workspace`
  runs the checks there (autodetected inside that directory when the entry is missing).
- The `/pipeline-init` command drafts this file from repository evidence and validates it.

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
