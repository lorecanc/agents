<!-- codebase-memory-mcp:start -->
# Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

## Priority Order
1. `search_graph` — find functions, classes, routes, variables by pattern
2. `trace_path` — trace who calls a function or what it calls
3. `get_code_snippet` — read specific function/class source code
4. `query_graph` — run Cypher queries for complex patterns
5. `get_architecture` — high-level project summary

## When to fall back to grep/glob
- Searching for string literals, error messages, config values
- Searching non-code files (Dockerfiles, shell scripts, configs)
- When MCP tools return insufficient results
<!-- codebase-memory-mcp:end -->

# Agent maintenance handoff (`manage-agents`)

`manage-agents` is the catalog-agnostic engine and TUI that validates, resolves, edits, routes and installs OpenCode
**packs** from local or git sources. Packs live in external repositories (such as `lorecanc/agents`) and interact with
this engine solely through the versioned pack contract in `contract/`.

## 1. Repository layout

- `manage-agents.mjs`: launcher (`bin`). Ensures Node runs with `--experimental-ffi` (required by OpenTUI) and rebuilds
  `dist/` through `src/build.mjs` whenever sources are newer.
- `src/index.tsx`, `src/App.tsx`: CLI entry point and OpenTUI terminal interface.
- `src/utils/`: core TypeScript modules and colocated `*.test.ts` suites:
  - Pack contract and paths: `packs.ts`, `pathValidation.ts`, `v2Compat.ts`, `opencodeMcp.ts`.
  - Sources, resolution and target state: `sources.ts`, `resolver.ts`, `lock.ts`, `installer.ts`, `changeReport.ts`,
    `repositoryTransaction.ts`.
  - Archetypes, user routing and frontmatter overrides: `archetypes.ts`, `userSettings.ts`, `agents.ts`, `models.ts`,
    `catalog.ts`.
  - Claude Code and Codex bridges: `bridge.ts`, `bridgeWorkspace.ts`, `bridgeCheck.ts`, `bridgeToolReferences.ts`,
    `codexBridge.ts`, `translationConfig.ts`, `claudePluginCli.ts`, `claudeNextSteps.ts`.
  - Terminal UI helpers: `uiConfig.ts`, `layout.ts`, `terminalText.ts`, `values.ts`.
- `runtime/plugins/manage-agents-router/`: V2 OpenCode router plugin installed into managed targets during `reconcile`,
  with its runtime unit tests (`*.test.mjs`).
- `contract/`: `CONTRACT.md`, `opencode-pack.schema.json`, `examples/minimal-pack/`, and the
  `skills/opencode-pack-authoring/SKILL.md` authoring skill.
- `test/helpers.ts`: shared helpers for building temporary packs and repositories in tests.

## 2. Non-negotiable invariants

- **Catalog independence:** never hardcode catalog-specific pack names, companion rules, shell profiles or categories in
  the engine. All pack metadata (`requires`, `archetype`, `routingDefaults`) comes from `opencode-pack.json`.
- **Target safety:** `install`, `uninstall`, `update` and `reconcile` must preserve unmanaged keys, JSONC comments and
  user-edited files in `<target>/opencode.json`, stage changes atomically on the target filesystem, and never follow
  symlinks inside managed scopes.
- **Untrusted pack content:** escape control characters in terminal output, reject credentials in git URLs, and require
  explicit confirmation (`--yes` non-interactively) before installing executable content from untrusted sources or when
  a pack's executable surface changes.
- **Published surface:** keep `files` in `package.json` aligned with runtime assets (`manage-agents.mjs`, `dist`,
  `assets`, `contract`, `runtime`, `README.md`, `GUIDA.md`, `LICENSE`).

## 3. Verification

Run before finishing any change:

```bash
npm run validate   # tsc --noEmit + node:test (src/utils/*.test.ts, runtime/**/*.test.mjs) + esbuild + minimal-pack validation
```
