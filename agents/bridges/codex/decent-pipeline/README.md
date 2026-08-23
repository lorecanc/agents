# decent-pipeline

This directory is a generated translation layer. Source agents are unchanged.

## Contents

- `.codex-plugin/plugin.json` — Codex plugin manifest.
- `.mcp.json` — enabled MCP servers plus servers explicitly required by translated agents.
- `.codex/agents/` — project-scoped Codex subagent definitions.
- `skills/` — plugin skills containing translated instructions.

Note: custom prompts in `~/.codex/prompts` are deprecated; prefer skills such as the ones generated here.

## MCP setup

`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.

- `chrome-devtools`: runs as `npx -y chrome-devtools-mcp@latest` (Node.js, npm, and network required).
- `codebase-memory-mcp`: install `codebase-memory-mcp` and verify with `command -v codebase-memory-mcp`; see https://github.com/DeusData/codebase-memory-mcp#quick-start.
- `shadcn`: runs as `npx -y shadcn@latest mcp` (Node.js, npm, and network required).
- `magic`: runs as `npx -y @21st-dev/magic@latest` (Node.js, npm, and network required); set `TWENTYFIRST_API_KEY`.
- `cupertino`: install `cupertino` and verify with `command -v cupertino`; see https://aleahim.com/blog/cupertino-09-release/.
- `axiom`: runs as `npx -y axiom-mcp` (Node.js, npm, and network required).
- `cwe-search`: runs as `npx -y cwe-search-mcp@latest` (Node.js, npm, and network required).

Verify the resulting connections from Codex before invoking MCP-dependent agents.

Primary agent: @orchestrator
