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
  - "src/tools/pipeline_serve.ts"
  - "src/tools/pipeline_smoke.ts"
  - "src/tools/pipeline_state.ts"
  - "src/tools/pipeline_verify.ts"
  - "src/plugins/pipeline-guard.js"
  - "src/opencode.json"
created: "2026-10-16"
last_updated: "2026-10-16"
---

# OpenCode Tools and Plugin Hooks

This repository primarily extends OpenCode through custom tools and a plugin that participates in session and tool-execution lifecycle hooks. It does not expose a conventional HTTP API with repository-defined routes and request/response endpoints. OpenCode tools declare validated arguments with `tool.schema` and implement an `execute(args, context)` function.

## Custom tool groups

| Group | Tools | Purpose |
|---|---|---|
| Documents | `doc_create`, `doc_list`, `doc_view`, `doc_modify`, `doc_restore`, `doc_convert`, `doc_compile_theme` | Create and edit canonical document sources, inspect project outputs, restore a DOCX snapshot, convert formats, and compile document CSS themes. |
| Slides | `slide_analyze_template`, `slide_assemble_pptx`, `slide_build_pptx`, `slide_compile_composition`, `slide_compile_theme`, `slide_create_thumbnails`, `slide_download_image`, `slide_generate_image`, `slide_screenshot` | Analyze templates, generate and assemble presentations, prepare themes/assets, and capture slide or deck previews. |
| Pipeline | `pipeline_state`, `pipeline_verify`, `pipeline_smoke`, `pipeline_serve`, `pipeline_commit` | Inspect session changes, run configured validation and smoke checks, manage a bounded local service, and create a scoped local commit. |

Arguments are tool-specific. For example, `pipeline_verify` accepts an ordered `checks` array, optional `files` for targeted tests, and `continue_on_fail`; `pipeline_serve` accepts `action` (`start`, `status`, or `stop`) and an optional `ttl_s`. Tools commonly return human-readable text or JSON-encoded results rather than HTTP response objects.

## Pipeline guard plugin

`src/plugins/pipeline-guard.js` exports `createPipelineGuard` and the default plugin descriptor with ID `pipeline-guard`. It limits its behavior to sessions whose agent name matches `pipeline-*` or `*-pipeline-*`; other sessions are left untouched. Set `OPENCODE_PIPELINE_GUARD=off` to disable it.

The plugin registers lifecycle hooks to maintain pipeline session state and enforce workspace constraints:

- `chat.params` and `chat.message` register sessions, resolve root sessions, and mark work busy.
- `shell.env` redirects temporary-file variables to a repository-local scratch directory and sets pipeline-specific Git/session environment values.
- `tool.execute.before` checks shell commands and file-write targets. It blocks disallowed repository/path operations and edits that conflict with another live session's claimed files.
- `tool.execute.after` records files changed through write tools or shell commands.
- `event` tracks idle/busy status. On idle it stops a service owned by that session and checks for Git-state anomalies.
- `experimental.session.compacting` preserves pipeline baseline, changed-file, task, and verification context in the compacted session.

The guard is defense in depth and intentionally fails open on unexpected inspection errors; its source comments identify agent permissions as the primary control. The source also registers process-exit handling to mark owned session records idle.

## OpenCode configuration

`src/opencode.json` configures local MCP servers and language servers; it does not define HTTP routes for the tools. MCP entries include enabled `chrome-devtools`, `codebase-memory-mcp`, `shadcn`, `magic`, `axiom`, and `cwe-search`, while `XcodeBuildMCP` and `cupertino` are disabled in this configuration. The `magic` entry reads its `API_KEY` from `TWENTYFIRST_API_KEY`. The LSP map configures language servers for Python, HTML, CSS, SQL, and Markdown extensions.
