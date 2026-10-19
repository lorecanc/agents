---
title: "Workspace and Distribution Configuration"
description: "OpenCode, agent profile, companion-link, translation, and category bundle configuration"
category: "config"
source_files:
  - "src/opencode.json"
  - ".agent-manager/pipeline-profiles.json"
  - ".agent-manager/companion-links.json"
  - ".agent-manager/translation-config.json"
  - ".agent-manager/categories/docs.json"
  - ".agent-manager/categories/slides.json"
  - ".agent-manager/categories/wiki.json"
  - "manage-agents/package.json"
  - "manage-agents/tsconfig.json"
created: "2026-10-16"
last_updated: "2026-10-16"
---

# Workspace and Distribution Configuration

Workspace behavior is configured across OpenCode's local server definitions, agent-manager profile and bundle manifests, translation settings, and the standalone `manage-agents` package.

## OpenCode workspace configuration

`src/opencode.json` declares local MCP servers and LSP processes. MCP entries use a `command` array and an `enabled` flag; `magic` also maps `API_KEY` to `{env:TWENTYFIRST_API_KEY}`. The file enables Chrome DevTools, codebase-memory, shadcn, Magic, Axiom, and CWE search, and leaves XcodeBuildMCP and Cupertino disabled. LSP entries map server commands to file extensions for Python, HTML/Vue, CSS, SQL, and Markdown. The custom tools and plugin hooks are covered in the [OpenCode API reference](../api/opencode-tools-and-plugin.md).

## Pipeline model profiles

`.agent-manager/pipeline-profiles.json` uses version `1`, sets `pipeline` as the base category, and defines profile descriptions and role defaults. Profiles include `hybrid`, `go`, `mistral`, `collector`, `free`, `copilot`, and `cp_nightly`. Defaults may target `all` roles or specify `orchestration`, `planning`, `execution`, `fast`, and `specialist`; some profiles also assign model variants such as `high`, `medium`, and `low`.

## Companion links and translation

`.agent-manager/companion-links.json` connects categories to related plugin, command, skill, and tool paths. Its `docs`, `pipeline`, and `slides` entries list category-specific companions; pipeline links the `plugins/pipeline-guard.js` plugin and pipeline tools, while docs and slides have empty plugin lists.

`.agent-manager/translation-config.json` is version `2`, targets `claude`, uses plugin name `decent-pipeline`, prefix `pipeline-`, source directory `src`, and enables inference. The default tier is `execution`; `planning` and `execution` tiers hold target-specific model settings, while `roles` maps agent names to tiers. Target-specific options include the Codex `reasoningEffort` setting and `emitSkills`/`emitReadme` flags.

## Category distribution manifests

The category manifests define portable resource bundles and generated configuration:

| Manifest | Bundle output | Included resources |
|---|---|---|
| `.agent-manager/categories/docs.json` | `export/categories/docs` | Shared `AGENTS.md`, documentation agents and commands, selected skills, document tooling, and requirements. |
| `.agent-manager/categories/slides.json` | `export/categories/slides` | Shared `AGENTS.md`, slide agents and commands, selected skills, presentation tooling, notices, and requirements. |
| `.agent-manager/categories/wiki.json` | `export/categories/wiki` | Shared `AGENTS.md`, wiki agents, the wiki command, and wiki skills. |

Each manifest declares schema version `2`, distribution version `2.0.0`, a category ID, output path, resource list, and a generated `opencode.json` configuration entry. Resource entries specify a kind, source, target, and policy; the docs and slides manifests allow requirements.

## Agent manager package

`manage-agents/package.json` defines an ES module package with a `manage-agents` executable, requiring Node.js `>=26.4.0` or Bun `>=1.3.0`. Its scripts provide start, esbuild bundle, TypeScript typecheck, test, and validation workflows. Runtime dependencies include OpenTUI, React, React Reconciler, and YAML. `manage-agents/tsconfig.json` targets ES2022 with NodeNext modules/resolution, uses React JSX, enables `skipLibCheck`, disables strict checking, and typechecks TS/TSX under `src/` without emitting output.
