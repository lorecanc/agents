# Pipeline guard, tools and worktree launcher

Deterministic support for the `pipeline-*` and `flow-*` agent families. Prompts and
permissions in `packs/pipeline/agents/` and `packs/flow/agents/` are the primary control; everything
here is defense in depth plus the parts that must not be left to a model: scoped commits, process
cleanup, git-state tracking.

Only sessions whose agent name matches `pipeline-*` (or a legacy `*-pipeline-*` name) are affected by
`pipeline-guard`; `flow-guard` applies the lighter rules described below to `flow-*` sessions.
Other sessions are untouched.

## V2 layout

This catalog targets OpenCode V2 and `@opencode/plugin@2.2.5`. Plugins are directories, not single
files, and V2 does not discover `tools/*.ts`: every tool is registered by a plugin through
`ctx.tool.transform`. Sources live under `packs/<pack>/` and keep the same relative paths once
installed into `~/.config/opencode/`:

| Installed path | Pack | Purpose |
|------|------|---------|
| `plugins/pipeline-guard/index.ts` | `pipeline` | Hooks: scratch env, write/git guards, session registry, activity log, git-state check, compaction context |
| `plugins/pipeline-tools/index.ts` | `pipeline` | Registers the two pipeline-only tools, `pipeline_state` and `pipeline_commit` |
| `plugins/flow-guard/index.ts`, `plugins/flow-context/index.ts`, `plugins/flow-mode/index.ts` | `flow` | Flow guard, git/todo session context, and `flow_plan_enter` / `flow_plan_exit` |
| `plugins/dev-tools/index.ts` | `dev-tools` | Registers the four `dev_*` tools, shared by the `pipeline` and `flow` packs |
| `plugins/doc-tools/index.ts`, `plugins/slide-tools/index.ts` | `office-tools` | Registers the seven `doc_*` tools and the nine `slide_*` tools |
| `tools/toolkit/_tool.ts` | `toolkit` | Adapter from the tool definition shape to a V2 definition (`toV2Tool`) and JSON Schema builder |
| `tools/pipeline/pipeline_state.ts` | `pipeline` | Read-only: baseline, changed files (session / pre-existing / unattributed), anomalies, recorded `activity` |
| `tools/pipeline/pipeline_commit.ts` | `pipeline` | Commit only the session's files; never push, amend, branch or stash |
| `tools/pipeline/_pipeline_core.js` | `pipeline` | Pipeline-only logic: agent/role matching, activity log, stale-session cleanup, file claims, commit planning |
| `tools/dev-tools/dev_env.ts` | `dev-tools` | Read-only Phase 0 probe: Docker, binaries, contract, workspaces, guard/tools, MCP, env var presence, verification outlook |
| `tools/dev-tools/dev_verify.ts` | `dev-tools` | lint / typecheck / tests / build with timeouts and a failure-class hint |
| `tools/dev-tools/dev_smoke.ts` | `dev-tools` | Start service, check, always stop it and free the port |
| `tools/dev-tools/dev_serve.ts` | `dev-tools` | Keep the service running for a browser (`start` / `status` / `stop`), always bounded |
| `tools/dev-tools/_repo.js`, `_sessions.js`, `_bash_guard.js` | `dev-tools` | Shared logic: paths, git, repo info, scratch, snapshots and locks; session registry; bash parser and write/git checks (also used by `flow-guard`) |
| `tools/dev-tools/_run.js`, `_services.js`, `_serve.js`, `_env.js` | `dev-tools` | Shared logic of the `dev_*` tools: runners, dependent services, service lifecycle, env probe |
| `tools/office-tools/doc_*.ts`, `slide_*.ts` | `office-tools` | Document and presentation tools and Python/PPTX helpers |
| `tools/flow/_flow_guard.js`, `_flow_context.js`, `_flow_mode.js` | `flow` | Pure logic for the three `flow` plugins |
| `bin/opencode-wt.mjs` | *(catalog root)* | Opt-in isolated worktree CLI: `start`, `finish`, `abort`, `list`, `gc` |
| `packs/*/**/*.test.mjs` | *(not installed)* | Tests, executed against the merged `.tree/` directory via `npm test` |

## Plugins and tool registration

Every plugin directory exports a default `Plugin.define(...)` object with a stable `id` and a
`setup(ctx)` function:

```ts
export default Plugin.define({
  id: "pipeline-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const tools = definitions.map(([name, def]) =>
      toV2Tool(def, {
        name,
        namespace: "pipeline",
        permission: `pipeline_${name}`,
        directory,
        worktree: directory,
      }),
    )
    await ctx.tool.transform((editor) => {
      for (const t of tools) editor.add(t)
    })
  },
})
```

The registries use **static imports only**. Dynamic `import()` would make the installed bundle
layout less predictable, and V2 has no `tools/*.ts` discovery to fall back on: adding a tool module
means adding a static import and a `definitions` entry to its domain registry.

Effective tool names are `namespace_name`, derived from the stem without the domain prefix:

| Registry | Namespace | Effective names |
|----------|-----------|-----------------|
| `dev-tools` | `dev` | `dev_env`, `dev_verify`, `dev_smoke`, `dev_serve` |
| `pipeline-tools` | `pipeline` | `pipeline_state`, `pipeline_commit` |
| `doc-tools` | `doc` | `doc_compile_theme`, `doc_convert`, `doc_create`, `doc_list`, `doc_modify`, `doc_restore`, `doc_view` |
| `slide-tools` | `slide` | `slide_analyze_template`, `slide_assemble_pptx`, `slide_build_pptx`, `slide_compile_composition`, `slide_compile_theme`, `slide_create_thumbnails`, `slide_download_image`, `slide_generate_image`, `slide_screenshot` |

`toV2Tool` builds a JSON Schema input (`type: "object"`, `additionalProperties: false`) from the
`tool.schema` arguments and normalizes the result into a V2 tool result. Each definition also
carries `options.permission` set to its full effective name, alongside `namespace`, `name`,
`directory` and `worktree`. Unsupported `tool.schema` methods fail closed at registration time.

## Install

Sources live in `packs/<pack>/` (`pipeline`, `flow`, `dev-tools`, `office-tools`, `toolkit`, ...).
[`manage-agents`](https://github.com/lorecanc/manage-agents) resolves each requested pack together with
its `requires` closure and installs the plugin directories and their `tools/<pack>/` modules into
`~/.config/opencode` (or `--target <dir>`), omitting `*.test.*` files from the target. `manage-agents pack validate --git packs/*/`
checks each pack's layout, manifest and namespaces and lists external imports, while `manage-agents resolve`
verifies that every cross-pack import is supplied by a directly required pack.

```bash
manage-agents source add catalog https://github.com/lorecanc/agents.git
manage-agents source pull
manage-agents install flow pipeline

# optional worktree launcher from a local catalog checkout
ln -s "$PWD/bin/opencode-wt.mjs" ~/.local/bin/opencode-wt
```

To inspect the merged tree locally without touching `~/.config/opencode`, run `npm run merge`, which
assembles all packs into `.tree/` (`plugins/` and `tools/<pack>/` stay siblings because registries
import `../../tools/<pack>/*.js`).

The V2 config lists each plugin directory by its config-relative path. Do not add a separate
`tools/` entry for a tool module: registration happens inside the domain registry.

Emergency switch for the guard: `OPENCODE_PIPELINE_GUARD=off`.

## flow-guard (flow family)

`packs/flow/plugins/flow-guard/index.ts` is the guard for the `flow-*` agents (the Claude Code style v2). It acts only
on sessions whose agent matches `flow-*` and keeps nothing on disk: no session registry, git snapshots,
activity log, doom-loop rule or cross-session locks. Allow/ask decisions belong to the agent permissions;
the guard only stops what must never run. The logic lives in `tools/flow/_flow_guard.js` and reuses the bash
parser and path checks of `tools/dev-tools/_bash_guard.js` (`checkBash` with a `gitPolicy` override), shared with pipeline-guard.

- Blocks writes outside the repository or into `.git`, `sudo`, dangerous env overrides, reading real
  `.env` files (templates are fine), and any repository write from the read-only agents (all but
  `flow-build`; `flow-plan` may write `.opencode/plans/*`).
- Git: branches, switches, stashes, commits with `-m` and normal pushes are allowed (the permissions ask
  for push). Destructive commands (`push --force/--delete`, `reset --hard`, `clean -f`, `checkout .`,
  `restore .`, `branch -D`, `stash drop/clear`, history rewriting) and interactive ones (`rebase -i`,
  `add -p`, `commit` without a message) are blocked, as are custom transports and `config` of hooks,
  editors, credentials or aliases.
- Unlike pipeline-guard, it allows redirects such as `2>/dev/null`, `curl`, `tar` and `mktemp` for
  read-only agents as long as nothing in the repository is written.
- After an edit it scans the added text (hardcoded secrets, injection sinks, SQL built by interpolation,
  TLS verification off, debug leftovers, new TODOs) and appends one short `[flow-guard] Check …` note to
  the tool result. The scan is advisory and fail-open.
- Stops the service a session started with `dev_serve` when that session goes idle.
- Read before edit, as in Claude Code: an `edit`, a `write` over an existing file or a patch `Update
  File` needs a `read` of that file in the same session, and the file must not have changed since (a
  formatter, a script or the user). The session's own edits keep the file fresh. New files and deletes
  are exempt. The record lives in memory only.

Emergency switch: `OPENCODE_FLOW_GUARD=off`.

## flow-context (session context, Claude Code style)

`packs/flow/plugins/flow-context/index.ts` adds per-request system text to `flow-*` sessions through the `context`
session hook. Nothing is persisted: the text is rebuilt for every model call. The logic lives in
`tools/flow/_flow_context.js`.

- `flow-build` and `flow-plan` get the git snapshot taken at the session's first model call: current
  branch, main branch, `git status --short` (truncated at 2000 characters) and the last 5 commits,
  labelled as a snapshot that does not update.
- `flow-build` gets a todo reminder when its latest `todowrite` list has open items and 10 tool calls
  passed without an update. The reminder then waits for another 10 calls.

Switch: `OPENCODE_FLOW_CONTEXT=off`.

## flow-mode (plan mode, Claude Code style)

`packs/flow/plugins/flow-mode/index.ts` makes `flow-plan` a mode of the same conversation, like Claude Code's
EnterPlanMode / ExitPlanMode. The rules and texts live in `tools/flow/_flow_mode.js`.

- `flow_plan_enter` (only `flow-build`): asks the user, then switches the session to `flow-plan`.
- `flow_plan_exit` (only `flow-plan`): checks that the plan is a non-empty `.opencode/plans/*.md`, asks
  the user to approve it (the prompt shows the plan path), then switches back to `flow-build`, which
  implements it. A rejection keeps plan mode; a rejection with a message returns it to the planner.
- OpenCode does not run a permission check for plugin tools (a `deny` rule only hides them), so each
  tool calls `ctx.permission.assert` itself, without `save`: "always" cannot disable the approval.
  The agents declare `flow_plan_enter` / `flow_plan_exit` as `ask`.
- `ctx.session.switchAgent` takes effect on the next model step of the same turn (OpenCode re-reads the
  session agent before every step); the model stays the session's.
- Users can still switch by hand: Shift+Tab cycles the visible primaries, `/flow-plan` starts planning.

## manage-agents-router (runtime model routing)

When at least one installed pack declares `archetype` (`flow` or `pipeline`), [`manage-agents`](https://github.com/lorecanc/manage-agents)
installs its own runtime plugin into `plugins/manage-agents-router/index.ts` (`router.js`) and writes a
`routing.json` file next to it. Each subagent's model follows the provider or exact model the calling
agent runs on, so one set of canonical agents serves every provider. It acts only when a caller listed in
`routing.json` (`flow-build`, `flow-plan` and `pipeline-orchestrator`) calls the `subagent` tool; other
agents are untouched.

- `model.request` records the agent and model of each session (title/summary/compaction are ignored).
- `tool.execute.before` sets `input.model` on `subagent` calls. OpenCode picks a subagent's model as
  `input.model ?? agent.model ?? parent session model`, so the order is: a model the caller passed
  explicitly, then a pinned subagent (fixed `model` in its frontmatter or user override), then the
  configuration for `provider/model` or `provider`, otherwise the caller's model (`inherit`).
- `routing.json` is regenerated by `manage-agents` at every reconcile by layering each pack's
  `routingDefaults` in `opencode-pack.json` (edited in the TUI with `m` on the archetype pack folder)
  under user settings in `~/.config/manage-agents/routing.json` (edited with `manage-agents models`).
  Never edit `routing.json` by hand. It is re-read on every subagent call, so changes need no restart.
- Fail-open: a missing or invalid `routing.json` routes nothing.

Switches: `OPENCODE_AGENT_ROUTER=off` disables it; `OPENCODE_AGENT_ROUTING=<path>` reads another file.

## What the guard enforces

- `shell.create.before`: `TMPDIR`, `TMP`, `TEMP`, `PIPELINE_SCRATCH` point to a scratch directory
  inside the repo (`<git-common-dir>/opencode-scratch`, or `.opencode-scratch/` in a linked
  worktree, excluded from git); `GIT_EDITOR=:` and `GIT_MERGE_AUTOEDIT=no` keep merge, rebase and
  pull continuations from hanging on an interactive editor.
- Explicit `/tmp` (and `os.tmpdir()`) paths are also allowed for temporary command outputs and logs.
  Except for the target-scoped removals below, `bash` writes (redirections, `cp`, `mv`, `tee`,
  `curl -o`, `cd` ...) outside the repo or into `.git` are blocked. Reads are not restricted here.
- Path-checks `edit`, `write`, `multiedit`, `apply_patch` and `patch`, blocking writes outside the
  repo or into `.git`.
- Target-scoped `rm`, `rm -f`, `rm -rf` and `rmdir` are allowed for coding roles (`executor`,
  `refactorer`, `fast_lane`, `tester`) on explicit subpaths inside the repo (excluding `.git`),
  `$PIPELINE_SCRATCH` or `/tmp`. Root targets `.`, `./`, `..`, `/`, `~`, `.git`, paths into `.git`,
  and wildcard targets are blocked.
- Git inspection and diagnostic subcommands, plus `git fetch` (without `--upload-pack`), are
  allowed for all roles. `ops`, `fast_lane`, `executor` and `refactorer` may also run `git pull`
  (without `--upload-pack`) and resolve conflicts with `git merge` / `git cherry-pick` (without
  `-e` / `--edit`), non-interactive `git rebase` (without `-i` / `--interactive` / `-x` /
  `--exec`), `git checkout --ours|--theirs|--merge <files>`,
  `git restore --staged|-S|--ours|--theirs|--merge <files>`, `git add <explicit-files>`, and
  `git mv` / `git rm` on explicit repo paths; these commands also allow
  `-c core.editor=true|:`. `post_session` may additionally run `git commit` (without `--amend`,
  `-a` or `--no-verify`), `git add <explicit-files>`, `git restore --staged <files>`, and
  `git rm --cached` (prefer `pipeline_commit`). Destructive or workspace-escaping mutations remain
  blocked for every role: `push`, branch switching via `checkout <branch>` / `switch`,
  branch/worktree/stash/tag creation or deletion, `reset`, `clean` and plain working-tree
  `restore`.
- Refuses edits to a file that another **live** session (same repository, other root session, busy,
  process alive, updated in the last 15 minutes) has already edited. If parent sessions cannot be
  resolved it does not guess and does not block.
- On idle, compares git state with the session baseline and warns about new branches, worktrees,
  stashes or a changed branch.
- On idle of the root session, stops the service that session started with `dev_serve`.
- On compaction, keeps baseline, edited files and verification state in the summary.

The guard also rejects the third consecutive identical tool call in the same session: V2 dropped the
V1 `doom_loop` permission action, so this is reproduced here. Calls are compared as a
`(tool, stableInput)` signature, where `stableInput` is JSON with object keys sorted at every level,
so key order cannot defeat it. A different call, a session idle or a session end resets the streak;
the state is in-memory only, capped per session and evicted on idle/end. The error names the tool and
tells the agent to bound the wait inside one command instead of polling with the same call.

The guard is fail-open: anything unexpected (unparseable command, no git repository, API
differences) lets the call through. Permissions in the agent files remain the primary control.
Session state lives in `<git-common-dir>/opencode-pipeline/` (inside `.git`, never committable).

## Activity log

For post-mortems based on recorded data instead of the orchestrator's recollection, the guard
appends one JSON line per event to `<git-common-dir>/opencode-pipeline/logs/<rootId>.jsonl` (one
file per root session, shared by all its subagents). Every event carries `at` (epoch ms),
`sessionId` and `agent`:

| `type` | Fields |
|--------|--------|
| `tool` | `tool`, `callId`, `ok`, `command` (bash command or file path, redacted, at most ~300 chars), `exit` (when known), `error` (short), `denied: true` when the error text looks like a permission denial (`permission`, `denied`, `rejected`, `prevents you from using`) |
| `guard_block` | `tool`, `callId`, `command`, `reason` (the guard's message) |
| `permission` | `event` (`permission.asked` / `permission.updated` / `permission.replied`), `permission`, `pattern`, `callId`, `decision` (null for asks) |
| `steps` | `tool_calls`, `llm_calls` per session, written when that session goes idle and on process exit |
| `session_error` | `error` (short) |
| `truncated` | `dropped`: the file is capped at 512 KB; when full, the oldest half is dropped |

Successful calls come from `tool.execute.after`; failed ones (including permission denials, which
never reach the after hook) from `message.part.updated` events with a tool part in `error` state.
Logging is fail-open: a write error is ignored and never blocks a call. Logs are removed with
their stale session records (`removeStaleSessions`), orphan logs once older than 7 days.
`pipeline_state` summarizes the log as `activity`: `per_agent` (tool calls, errors, denied, guard
blocks, sessions), `subagents` (tool and LLM calls per child session), `errors`, the last 30
`denied` commands (agent, command, reason, source) and `guard_blocks`, and `permissions` counts.

## Environment probe: `dev_env`

Read-only, called once by the orchestrator at session start (Phase 0) so the planner writes a
verification plan the machine can actually run. Optional `workspace` argument (repo-relative
sub-project). It reports:

- `docker`: CLI path, sockets found (`$DOCKER_HOST`, `/var/run/docker.sock`, `~/.docker/run`,
  colima, OrbStack, Rancher Desktop, rootless/podman), daemon reachable (`docker info`, 3 s
  timeout, only if the CLI exists).
- `binaries`: PATH lookup (no execution) of database servers/clients, language runtimes and test
  runners, plus Homebrew keg-only / Postgres.app installs that are not on PATH.
- `contract`: `.opencode/pipeline.json` existence and problems, verify checks defined vs
  autodetected vs missing, declared `services` (name, kind, image), `smoke` / `serve`,
  `workspaces`, unknown top-level keys.
- `workspaces_detected`: directories up to depth 2 with `package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, `pom.xml` or `build.gradle(.kts)` (vendored and build dirs skipped).
- `pipeline`: whether the guard registered this session (root record, baseline), which
  `dev_*` / `pipeline_*` tool modules sit in the tools directory (the `pipeline_*` ones count as
  missing only for a registered pipeline session), whether the `pipeline-guard` plugin directory
  is present.
- `mcp`: MCP server names / type / enabled flag from the opencode config files (never commands,
  URLs or headers).
- `env_vars`: for each name in `.env.example` / `.env.sample`, whether it is set. Values are never
  returned and `.env` is never read.
- `verification_outlook`: `unit_tests`, `db_backed_tests`, `runtime_smoke`, `browser`, each
  `feasible` (`true` / `false` / `"unknown"` / `"n/a"`) with a reason.

It never modifies anything and never throws: a failing probe becomes
`{ "status": "unknown", "reason": ... }`.

## Project contract: `.opencode/pipeline.json`

Optional, committed in the target repository. Without it, `dev_verify` autodetects commands
(npm/pnpm/yarn/bun scripts, `tsc`, go, cargo, pytest). If it contains no `smoke`/`serve` section,
`dev_smoke` and `dev_serve` automatically fall back to autodetected `package.json`
`dev`/`start` scripts when available.

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

- `${PORT}` is a free port chosen per run (or set `smoke.port` for a fixed one; if it is taken the
  run is `blocked`, the foreign process is never killed). `ready` can use `url`, `port` or `log`
  (regex).
- `serve` (optional) is used by `dev_serve`, with the same fields as `smoke` plus `url` (the
  address handed to the browser, default `http://127.0.0.1:${PORT}/`). Without it,
  `dev_serve` uses the `smoke` section.
- Smoke checks only reach `localhost`. `env_file` must be inside the repo and its values are never
  echoed.
- Runs are serialized per repository (`verify` and `smoke` locks), so concurrent sessions do not
  fight over ports or half-written files.
- `verify.test_filter` runs tests by name (`dev_verify` `filter` argument); it must contain
  `{filter}` and may contain `{files}`. `{packages}` expands to the Go packages (`./dir`) of the
  given files. Without a contract, `test_targeted` and `test_filter` are autodetected for pytest,
  vitest, jest, go (and cargo for `test_filter`).
- `services` declares dependencies started for a run and always stopped after it: `dev_verify`
  `with_services: ["db"]`, or `smoke.services: ["db"]`. `{ "kind": "postgres", "version": "16" }`
  is a throwaway cluster (native `initdb`/`postgres` when installed, otherwise Docker if the daemon
  is reachable, otherwise `blocked` / `env`) exporting `DATABASE_URL` (or `env_var`) and
  `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`. A custom service is `{ "start", "ready", "env", "stop"? }`
  with `${PORT}`.
- `workspaces.<dir>` holds `verify`, `services` and `timeouts` for a sub-project; `dev_verify`
  `workspace` runs the checks there (autodetected inside that directory when the entry is missing).
- The `/pipeline-init` command drafts this file from repository evidence and validates it.

## Serving for the browser: `dev_serve`

`dev_smoke` starts a service, checks it and always stops it, so nothing is left running for a
browser. `dev_serve` is for the visual validation done by `chrome_devtools`: `start` returns a
localhost URL on a free port, `stop` ends it. A start never leaves anything behind: the first of
these ends the service.

1. `stop` by the owner (a service of another live session is refused), or the idle of the owning
   root session.
2. The supervisor notices the owning opencode process is gone, even after `kill -9` (about one
   second).
3. The time limit (default 900 s, at most 3600 s).

Stopping kills the whole process group, so grandchildren die too. Only one service per repository
runs at a time; a second `start` reuses it. It needs `/bin/sh` (macOS and Linux).

## Shared mode (default) and worktree mode (opt-in)

Shared mode: every session works in the current checkout on the current branch. File claims make
the second session stop instead of overwriting; commits contain only the committing session's
files.

Worktree mode, for large or risky work:

```bash
opencode-wt start fix-login -- --agent pipeline-orchestrator   # worktree in .git/opencode-worktrees/
opencode-wt finish fix-login   # rebase on the base branch, ff-only merge, remove worktree and branch
opencode-wt abort fix-login    # discard everything
opencode-wt gc [--dry-run]     # prune stale metadata and merged pipeline/* branches
```

`finish` never force-merges: with a dirty worktree, rebase conflicts, a moved base, or a main
checkout that is not on the base branch, it leaves the branch in place and prints why.
Dependencies are not shared: use `setup` (and `worktree.copy` for untracked files such as
`.env.local`).

## Known limits

- The bash guard is a best-effort parser. It does not see what a program does internally (for
  example a test runner writing outside the repo); the agents' `external_directory: deny` covers
  the file tools, not child processes.
- Session ownership relies on the SDK exposing `parentID`; verify it after upgrading opencode.
- If the `dev_serve` supervisor itself is killed with SIGKILL, its service keeps running
  until `stop`, the idle of the owning session, or a manual kill: nothing else is watching it.
- V2 loads the `default` export of a plugin directory; keep helpers out of the plugin's named
  exports.
- V2 also fires model hooks for hidden internal agents (`title`, `summary`, `compaction`) on the
  same session id; the guard ignores them so they cannot switch it off.
- `session.compaction` is an experimental hook and may change.
