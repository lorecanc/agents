---
title: "OpenCode Tools and Plugin Hooks"
description: "Custom OpenCode tools and the pipeline session guard plugin"
category: "api"
source_files:
  - "src/tools/doc_create.ts"
  - "src/tools/doc_list.ts"
  - "src/tools/doc_view.ts"
  - "src/tools/doc_modify.ts"
  - "src/tools/doc_restore.ts"
  - "src/tools/doc_convert.ts"
  - "src/tools/doc_compile_theme.ts"
  - "src/tools/slide_analyze_template.ts"
  - "src/tools/slide_assemble_pptx.ts"
  - "src/tools/slide_build_pptx.ts"
  - "src/tools/slide_compile_composition.ts"
  - "src/tools/slide_compile_theme.ts"
  - "src/tools/slide_create_thumbnails.ts"
  - "src/tools/slide_download_image.ts"
  - "src/tools/slide_generate_image.ts"
  - "src/tools/slide_screenshot.ts"
  - "src/tools/pipeline_commit.ts"
  - "src/tools/dev_env.ts"
  - "src/tools/_env.js"
  - "src/tools/dev_serve.ts"
  - "src/tools/dev_smoke.ts"
  - "src/tools/pipeline_state.ts"
  - "src/tools/dev_verify.ts"
  - "src/plugins/pipeline-guard/index.ts"
  - "src/plugins/dev-tools/index.ts"
  - "src/plugins/pipeline-tools/index.ts"
  - "src/plugins/doc-tools/index.ts"
  - "src/plugins/slide-tools/index.ts"
  - "src/opencode.json"
created: "2026-10-16"
last_updated: "2026-11-02"
---

# OpenCode Tools and Plugin Hooks

This repository primarily extends OpenCode through custom tools and plugins that participate in session and tool-execution lifecycle hooks. It does not expose a conventional HTTP API with repository-defined routes and request/response endpoints. OpenCode tools declare validated arguments with `tool.schema` and implement an `execute(args, context)` function.

In OpenCode V2, `tools/*.ts` is not discovered automatically: every tool is registered by a plugin through `ctx.tool.transform`. The `dev-tools`, `pipeline-tools`, `doc-tools`, and `slide-tools` plugin directories (`src/plugins/*/index.ts`) are the tool registries; each imports its tool definitions statically from `src/tools/*.ts` and adds them in `ctx.tool.transform`. The `pipeline-guard` plugin is hook-only and registers no tools.

## Custom tool groups

| Group | Tools | Purpose |
|---|---|---|
| Documents | `doc_create`, `doc_list`, `doc_view`, `doc_modify`, `doc_restore`, `doc_convert`, `doc_compile_theme` | Create and edit canonical document sources, inspect project outputs, restore a DOCX snapshot, convert formats, and compile document CSS themes. |
| Slides | `slide_analyze_template`, `slide_assemble_pptx`, `slide_build_pptx`, `slide_compile_composition`, `slide_compile_theme`, `slide_create_thumbnails`, `slide_download_image`, `slide_generate_image`, `slide_screenshot` | Analyze templates, generate and assemble presentations, prepare themes/assets, and capture slide or deck previews. |
| Development (`dev-tools`, shared by `pipeline` and `flow`) | `dev_env`, `dev_verify`, `dev_smoke`, `dev_serve` | Probe the machine's verification capabilities (read-only), run configured validation and smoke checks, and manage a bounded local service. |
| Pipeline (`pipeline-tools`, pipeline only) | `pipeline_state`, `pipeline_commit` | Inspect session changes and create a scoped local commit. |

Arguments are tool-specific. For example, `dev_verify` accepts an ordered `checks` array, optional `files` for targeted tests, and `continue_on_fail`; `dev_serve` accepts `action` (`start`, `status`, or `stop`) and an optional `ttl_s`. `dev_env` takes no arguments beyond an optional `workspace` (a repo-relative sub-project directory). Tools commonly return human-readable text or JSON-encoded results rather than HTTP response objects.

## Pipeline guard plugin

`src/plugins/pipeline-guard/index.ts` exports `setupPipelineGuard(ctx, options)`, the V2 setup function, and a default plugin descriptor `Plugin.define({ id: "pipeline-guard", setup: setupPipelineGuard })` with ID `pipeline-guard`. It limits its behavior to sessions whose agent name matches `pipeline-*` or `*-pipeline-*`; other sessions are left untouched. Set `OPENCODE_PIPELINE_GUARD=off` to disable it.

The guard is one of the five V2 plugin directories shipped with the pipeline: `plugins/dev-tools`, `plugins/pipeline-guard`, `plugins/pipeline-tools`, `plugins/doc-tools`, and `plugins/slide-tools`. Its bash parser and write/git checks live in `src/tools/_bash_guard.js`, which `flow-guard` reuses; the session registry is `src/tools/_sessions.js`, and the pipeline-only parts (role matching, activity log, file claims) stay in `src/tools/_pipeline_core.js`. It registers V2 lifecycle hooks to maintain pipeline session state and enforce workspace constraints:

- `session.hook("model.request")` and `session.hook("prompt")` register sessions, resolve root sessions, and mark work busy.
- `shell.hook("create.before")` redirects temporary-file variables to a repository-local scratch directory and sets pipeline-specific Git/session environment values.
- `tool.hook("execute.before")` checks shell commands and file-write targets. It blocks disallowed repository/path operations and edits that conflict with another live session's claimed files. It also applies the doom-loop guard (see below).
- `tool.hook("execute.after")` records files changed through write tools or shell commands, and logs each tool call to the activity log.
- `event.subscribe` tracks idle/busy status. On idle it stops a service owned by that session, compares the current Git state with the session baseline, and warns about Git-state anomalies.
- `session.hook("compaction")` preserves pipeline baseline, changed-file, task, and verification context in the compacted session.
- `permission.hook("evaluate")` records permission requests that resolve to `allow` or `ask` in the activity log. It only records; it does not change the permission decision.

### Doom-loop guard

V2 has no `doom_loop` permission action, so the guard reproduces it: the third consecutive call with the same tool name and identical input is rejected. Input objects are serialized with keys sorted at every level, so key order cannot defeat the comparison. The check runs only after the path and shell checks pass. A different call ends the streak, and the streak is cleared when the session goes idle or is deleted. At most 500 sessions are tracked.

### Git-state anomalies

On idle, the guard compares the session baseline with a fresh Git snapshot (`gitAnomalies`). It reports new branches, new worktrees, new stashes, and a changed branch. Findings are logged as a warning, stored on the root session record, and written to the activity log.

### Service cleanup

On idle, `stopServicesOwnedBy` stops any service that the session started with `dev_serve`, so a service does not outlive its work.

### Activity log

The guard appends JSON Lines to `<git-common-dir>/opencode-pipeline/logs/<rootId>.jsonl`, one file per root session. Event types written by the guard are:

- `tool`: a tool call with `ok`, and optionally `command`, `exit`, `error`, and `denied`.
- `guard_block`: a call rejected by the guard, with `reason`.
- `permission`: a permission request or reply.
- `steps`: LLM and tool call counters, flushed on idle.
- `session_error`: a session error event.
- `warning`: Git-state anomalies, or a compaction payload with no array field to inject into.

`pipeline_state` reads this log back as `activity`.

The guard is defense in depth and intentionally fails open on unexpected inspection errors; its source comments identify agent permissions as the primary control. The source also registers process-exit handling to mark owned session records idle.

## OpenCode configuration

`src/opencode.json` configures local MCP servers and language servers; it does not define HTTP routes for the tools. MCP entries include enabled `chrome-devtools`, `codebase-memory-mcp`, `shadcn`, `magic`, `axiom`, and `cwe-search`, while `XcodeBuildMCP` and `cupertino` are disabled in this configuration. The seven remote MCP entries (`bigquery`, `cloud-run`, `cloud-logging`, `cloud-monitoring`, `cloud-sql`, `cloud-storage`, `cloud-cli`) are all `disabled`. The `magic` entry reads its `API_KEY` from `TWENTYFIRST_API_KEY`.

The `plugins` array lists `./plugins/dev-tools`, `./plugins/pipeline-guard`, `./plugins/pipeline-tools`, `./plugins/doc-tools`, and `./plugins/slide-tools`. The LSP map configures language servers for Python (`basedpyright`, `ruff`), HTML and Vue (`html`), CSS, SCSS, and Less (`css`), SQL (`sqls`), and Markdown (`marksman`).
