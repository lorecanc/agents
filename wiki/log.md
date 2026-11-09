# Wiki Log

## [2026-10-16] initial-generation | Generated the initial wiki index, log, and glossary

- Pages created: 9 — `wiki/overview.md`, `wiki/architecture.md`, `wiki/getting-started.md`, `wiki/modules/agent-catalog.md`, `wiki/modules/agent-manager.md`, `wiki/modules/tools-and-plugins.md`, `wiki/modules/workflow-resources.md`, `wiki/api/opencode-tools-and-plugin.md`, `wiki/config/workspace-and-distribution.md`
- Pages updated: 0
- Pages deprecated: 0
- Depth: Initial generation
- Commit: Not committed

## [2026-11-02] incremental-update | Refreshed wiki for commits c6cdad8..3169aab

- Pages created: 1 — `wiki/modules/bridges.md`
- Pages updated: 9 — `wiki/overview.md`, `wiki/architecture.md`, `wiki/getting-started.md`, `wiki/modules/agent-catalog.md`, `wiki/modules/agent-manager.md`, `wiki/modules/tools-and-plugins.md`, `wiki/modules/workflow-resources.md`, `wiki/api/opencode-tools-and-plugin.md`, `wiki/config/workspace-and-distribution.md`
- Pages deprecated: 0
- Depth: Incremental update (range c6cdad8..3169aab)
- Commit: 3169aab

Summary:
- `pipeline-tools` now registers six tools, including the read-only `pipeline_env` probe (`verification_outlook`). `pipeline-guard` is hook-only and adds the doom-loop guard, the per-root JSONL activity log, and service cleanup on idle; the legacy single-file `plugins/pipeline-guard.js` was removed.
- Bash profiles (`.agent-manager/bash-profiles.json`, `pipeline sync-bash`) and shared sync (`.agent-manager/shared-sync.json`, neverOverwrite overlays) are documented; the new Bridges page covers the Claude Code and Codex `decent-pipeline` bridges, translation tiers, and `bridge check`.
- `export/categories` now ships `docs`, `slides`, and `wiki`, plus the `free-pipeline`, `go-pipeline`, `hybrid-pipeline`, and `mistral-pipeline` bundles; the collector, copilot, cp_nightly, and kimi bundles are gone. The agent catalog adds `wiki-analyzer`, `wiki-updater`, orchestrator, and `storybook-docs_format`.

## [2026-11-09] incremental-update | Pipeline moved from stamped per-provider bundles to the archetype model

- Pages created: 0
- Pages updated: 10 — `wiki/overview.md`, `wiki/architecture.md`, `wiki/glossary.md`, `wiki/getting-started.md`, `wiki/config/workspace-and-distribution.md`, `wiki/modules/bridges.md`, `wiki/modules/agent-manager.md`, `wiki/modules/agent-catalog.md`, `wiki/modules/tools-and-plugins.md`, `wiki/api/opencode-tools-and-plugin.md`
- Pages deprecated: 0
- Depth: Incremental update (pipeline archetype migration, uncommitted)
- Commit: Not committed

Summary:
- `pipeline` is now an archetype like `flow`: the 21 canonical `src/agents/pipeline-*.md` agents are a manifest-V2 category (`.agent-manager/categories/pipeline.json` → `export/categories/pipeline`) and subagent models come from `.agent-manager/agent-routing.json` through the `agent-router` plugin, which now ships with the pipeline.
- Removed: the `free-`, `go-`, `hybrid-`, and `mistral-pipeline` bundles, `.agent-manager/pipeline-profiles.json`, `pipelineProfiles.ts`, `pipeline list|show|apply|sync|refresh|delete`, `export --profile`, and the TUI pipeline fork and `D` delete. `pipeline` keeps only `sync-bash`; `sync apply` reports `refreshed: { bashProfiles }`.
- `export` removes the retired installed `{free,go,hybrid,mistral}-pipeline-<role>.md` files; bridges still start from the canonical agents and map models through `translation-config.json`; the shared-sync overlay protects `agent-routing.json` and the generated `routing.json`.
