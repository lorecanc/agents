---
title: "Workspace and Distribution Configuration"
description: "OpenCode, model configuration, companion-link, translation, bash permission, shared sync, and category bundle configuration"
category: "config"
source_files:
  - "src/opencode.json"
  - ".agent-manager/agent-routing.json"
  - ".agent-manager/companion-links.json"
  - ".agent-manager/translation-config.json"
  - ".agent-manager/bash-profiles.json"
  - ".agent-manager/shared-sync.json"
  - ".agent-manager/categories/docs.json"
  - ".agent-manager/categories/slides.json"
  - ".agent-manager/categories/wiki.json"
  - ".agent-manager/categories/pipeline.json"
  - "manage-agents/package.json"
  - "manage-agents/tsconfig.json"
  - "manage-agents/src/utils/bashProfiles.ts"
  - "manage-agents/src/utils/sharedSync.ts"
  - "manage-agents/src/utils/agentRouting.ts"
created: "2026-10-16"
last_updated: "2026-11-09"
---

# Workspace and Distribution Configuration

Workspace behavior is configured across OpenCode's local server definitions, archetype model configurations and bundle manifests, translation settings, bash permission profiles, the shared sync manifest, and the standalone `manage-agents` package.

## OpenCode workspace configuration

`src/opencode.json` declares MCP servers, plugin directories, and LSP processes. It sets `experimental.todo` to `true`. MCP entries live under `mcp.servers` with a `type` and a `command` array (remote entries use `url`); local servers carry `codemode: false`, and a server is turned off with `disabled: true` rather than an `enabled` flag. `magic` also maps `API_KEY` to `{env:TWENTYFIRST_API_KEY}`. The file enables Chrome DevTools, codebase-memory, shadcn, Magic, Axiom, and CWE search, and leaves XcodeBuildMCP, Cupertino, BigQuery, and the Cloud MCP endpoints disabled. The `plugins` key lists V2 plugin directories as config-relative paths: `./plugins/dev-tools`, `./plugins/pipeline-guard`, `./plugins/pipeline-tools`, `./plugins/doc-tools`, and `./plugins/slide-tools`. Each listed directory exports a default `Plugin.define(...)` object (see `src/plugins/README.md`); the guard is the module `src/plugins/pipeline-guard/index.ts`. LSP entries map server commands to file extensions for Python (`basedpyright`, `ruff`), HTML/Vue, CSS, SQL, and Markdown. The custom tools and plugin hooks are covered in the [OpenCode API reference](../api/opencode-tools-and-plugin.md).

## Archetype model configurations

The `flow` and `pipeline` families are archetypes: their canonical agents are installed once, and subagent models come from `.agent-manager/agent-routing.json` (TUI: `M` on the archetype folder; CLI: `manage-agents routing show|set|unset|build|check`). `ARCHETYPES` in `manage-agents/src/utils/agentRouting.ts` registers each archetype with its reference role: `flow-build` for `flow`, `pipeline-orchestrator` for `pipeline`. A configuration is keyed by a trigger, a provider or an exact `provider/model` (the exact model wins), and maps subagent roles to `provider/model#variant` or `inherit`; roles left out inherit the caller's model, and subagents with a frontmatter `model` are fixed and skipped. `routing build` (also run by `category build` and `export`) resolves the file into the generated `src/plugins/agent-router/routing.json`, which the `agent-router` plugin reads at runtime. `ARCHETIPI.md` is the full guide. These configurations replaced the per-provider pipeline profiles and their `*-pipeline` bundles.

The current `pipeline` configuration has one trigger, `mistral`: 17 subagents run on `mistral/deepseek-v4-1-flash-1017#high`, while `planner`, `reasoner`, and `security_auditor` inherit the orchestrator's model. Other providers have no configuration, so every subagent inherits. Only `pipeline-orchestrator` sets `model` in its frontmatter (its starting model); the 20 pipeline subagents have neither `model` nor `hidden`.

## Companion links and translation

`.agent-manager/companion-links.json` (version `1`) connects categories to related plugin, command, skill, and tool paths under `categories`.

| Category | Plugins | Commands | Skills | Tools |
|---|---|---|---|---|
| `docs` | `plugins/doc-tools` | `convert-doc`, `edit-doc`, `new-doc` | `docs-design`, `docs-html`, `docx` | `doc_compile_theme`, `doc_convert`, `doc_create`, `doc_list`, `doc_modify`, `doc_restore`, `doc_view`, `tools/docx` |
| `flow` | `plugins/agent-router`, `plugins/flow-context`, `plugins/flow-guard`, `plugins/dev-tools`, `plugins/flow-mode` | `flow-bug`, `flow-commit`, `flow-design`, `flow-explain`, `flow-feature`, `flow-plan`, `flow-review`, `flow-simplify` | the five `chrome-devtools*` skills, `code-review-antipatterns`, and the eight `flow-*` skills | `dev_env`, `dev_serve`, `dev_smoke`, `dev_verify` |
| `ontology` | none | none | the four `ontology-ontogpt-*` skills | `tools/ontology` and the `ontology_*` wrappers |
| `pipeline` | `plugins/agent-router`, `plugins/dev-tools`, `plugins/doc-tools`, `plugins/pipeline-guard`, `plugins/pipeline-tools`, `plugins/slide-tools` | `pipeline-bug`, `pipeline-feature`, `pipeline-init`, `pipeline-ops`, `pipeline-refactor`, `pipeline-research` | `code-review-antipatterns` | `dev_env`, `dev_serve`, `dev_smoke`, `dev_verify`, `pipeline_commit`, `pipeline_state` |
| `slides` | `plugins/slide-tools` | `fix-slide`, `new-slides`, `polish-slides` | `pptx`, `slides-composition`, `slides-design`, `slides-html`, `slides-template-html`, `slides-theming` | `tools/pptx`, `slide_analyze_template`, `slide_assemble_pptx`, `slide_build_pptx`, `slide_compile_composition`, `slide_compile_theme`, `slide_create_thumbnails`, `slide_download_image`, `slide_generate_image`, `slide_screenshot` |
| `wiki` | none | `wiki` | `wiki-conventions`, `wiki-navigate`, `wiki-templates` | none |

`wiki` has empty `plugins` and `tools` lists, and `ontology` has no plugins or commands. The shared `dev_*` tools, `plugins/dev-tools`, and `plugins/agent-router` are linked to both `flow` and `pipeline`.

`.agent-manager/translation-config.json` is version `2`, targets `claude`, uses `pluginName` `decent-pipeline`, prefix `pipeline-`, source directory `src`, and enables inference. The default tier is `execution`. The tiers are:

| Tier | Claude model | Codex model | Codex `reasoningEffort` |
|---|---|---|---|
| `planning` | `opus` | `gpt-5.6-sol` | `high` |
| `execution` | `sonnet` | `gpt-5.6-luna` | `max` |
| `light` | `haiku` | `gpt-5.6-luna` | `max` (parity with `execution`) |

`roles` maps agent names to tiers:

- `orchestrator`, `planner`, and `reasoner` map to `planning`; `critic`, `code_reviewer`, `refactorer`, `tester`, and `fast_lane` map to `execution`; `executor` and `explorer` map to `light`. Other roles fall back to the default tier (`execution`).

Bridges do not read the archetype model configurations: they map models only through this file.

Target-specific blocks set `overrides` and `modelMap`. The `claude` block sets `emitMarketplace`, `emitCommands`, `emitSkills`, `autoValidate`, and `autoRegister` to `true`. The `codex` block sets `emitSkills` and `emitReadme` to `true`.

## Bash permission profiles

`.agent-manager/bash-profiles.json` (version `1`) is the single source of truth for pipeline agents' `permission.bash` blocks. It has two maps:

- `profiles`: named blocks, each with an optional `description` and an ordered `rules` array of `[pattern, action]` pairs. Actions are `allow`, `ask`, or `deny`.
- `roles`: maps a role name to an ordered list of profile names.

A role expands to the concatenation of its profiles, in order. OpenCode evaluates bash rules with last-match-wins, so order is semantic and preserved exactly. A later profile overrides an earlier one: `ops-trusted-shell` starts with a catch-all `["*", "allow"]` and places `ask` and `deny` gates after it.

`validateBashProfiles` in `manage-agents/src/utils/bashProfiles.ts` enforces:

- `version` must be `1`.
- Every profile needs a non-empty `rules` array with valid actions.
- Every role needs a non-empty list of existing profile names.
- A pattern may not appear twice in one role's expansion.

### Defined profiles

The file defines 29 profiles:

| Group | Profiles |
|---|---|
| Baseline | `deny-all` (`*` deny), `cd` |
| Tooling | `build-tools`, `test-runners-read`, `shell-read`, `shell-read-guard`, `shell-build-utils`, `fs-basic`, `fs-move`, `security-scanners` |
| Git | `git-read`, `git-blame`, `git-branch-name`, `git-rev-parse`, `git-merge-base`, `git-sync`, `git-conflict`, `git-resolve-checkout`, `git-resolve-restore`, `git-unstage`, `git-stage` |
| Guards | `publish-guard`, `rm-guard`, `ops-rm-guard`, `ops-trusted-shell`, `secrets-guard`, `secrets-copy` |
| Post-session | `post-session-stage`, `post-session-commit` |

`git-rev-parse`, `git-merge-base`, `git-resolve-checkout`, and `git-resolve-restore` are defined but not referenced by any role.

Examples from the file:

```json
"post-session-commit": {
  "rules": [
    ["git commit -m \"*\"", "allow"],
    ["git commit -a*", "deny"],
    ["git push*", "ask"]
  ]
}
```

### Roles

Each role maps to the profiles listed below, in this order.

| Role | Profiles |
|---|---|
| `explorer`, `hitl` | `deny-all`, `cd`, `shell-read`, `shell-read-guard`, `git-read`, `git-blame`, `git-branch-name`, `secrets-guard` |
| `code_reviewer`, `critic` | As `explorer`, plus `test-runners-read` before `secrets-guard` |
| `security_auditor` | As `explorer`, plus `security-scanners` before `secrets-guard` |
| `executor`, `fast_lane`, `refactorer` | `deny-all`, `cd`, `build-tools`, `shell-read`, `shell-build-utils`, `fs-basic`, `fs-move`, `git-read`, `git-blame`, `git-branch-name`, `git-sync`, `git-conflict`, `git-unstage`, `git-stage`, `publish-guard`, `rm-guard`, `secrets-guard`, `secrets-copy` |
| `tester` | As `executor`, without `git-sync`, `git-conflict`, `git-unstage`, and `git-stage` |
| `ops` | `ops-trusted-shell`, `publish-guard`, `rm-guard`, `ops-rm-guard` (no `deny-all`) |
| `post_session` | `deny-all`, `cd`, `git-read`, `git-branch-name`, `git-unstage`, `post-session-stage`, `post-session-commit`, `secrets-guard` |

### Applying and checking

```bash
node manage-agents/manage-agents.mjs pipeline sync-bash [--dry-run]
```

`pipeline sync-bash` rewrites the bash block of canonical `src/agents/pipeline-*.md` files only. Agents whose role has no profile (for example, `bash: deny` roles) are skipped. The rewrite changes only the permission block; the body bytes must stay identical. After syncing, run `category build --all` to rebuild `export/categories/pipeline`.

`checkBashProfiles` compares the canonical agents against their role expansion; `category check` runs it whenever `pipeline` is in scope. The role comes from the filename `pipeline-<role>.md`.

`matchBashRule` returns the action of the last matching rule, or `deny` when none matches. `evaluateBashCommand` splits compound commands on `&&`, `||`, `;`, and `|`; any denied part denies the command, then any `ask` part asks. This matcher is OpenCode-like and is used by tests and diagnostics.

## Shared sync manifest

`.agent-manager/shared-sync.json` (schema version `1`) defines two components that can be distributed to other repositories.

**`agentManager`** (version `1.3.0`): "Shared Agent Manager CLI/TUI, validators, bridge translators, and bash permission profiles".

- Include: `manage-agents.sh`, `manage-agents/manage-agents.mjs`, `manage-agents/README.md`, `manage-agents/GUIDA.md`, `manage-agents/assets/**`, `manage-agents/src/**`, `.agent-manager/bash-profiles.json`, `.agent-manager/translation-config.json`.
- Exclude: `manage-agents/node_modules/**`, `manage-agents/dist/**`, `manage-agents/package.json`, `manage-agents/package-lock.json`, `manage-agents/tsconfig.json`, `manage-agents/bun.lock`, `manage-agents/bunfig.toml`, `manage-agents/.npmrc`, `manage-agents/integration/**`.

**`pipelineCore`** (version `1.3.0`): "Shared canonical catalog: every agent and command with the plugins, tools, skills, resources and documents they link, plus the benchmark". It requires agent manager `>=1.3.0 <2.0.0`.

- Include: `src/AGENTS.md`, `src/requirements.txt`, every `src/agents/*.md` (with `pipeline-*` and `flow-*` as explicit patterns), and the `src/commands/**`, `src/plugins/**`, `src/tools/**` (tests included), `src/skills/**`, `src/resources/**`, `src/docs/**`, `src/office/**`, `src/bench/**` and `src/bin/**` trees. Trees ship whole; ontology material is excluded by the overlay.
- Exclude: none.

`validateSharedSyncManifest` in `manage-agents/src/utils/sharedSync.ts` enforces path prefixes. `agentManager` paths must be `manage-agents.sh`, under `manage-agents/`, or under `.agent-manager/`. `pipelineCore` paths must be `src/AGENTS.md`, `src/requirements.txt`, or start with `src/agents/`, `src/commands/`, `src/plugins/`, `src/tools/`, `src/skills/`, `src/resources/`, `src/docs/`, `src/office/`, `src/bench/`, or `src/bin/`. Every glob must be relative and must not contain `..`, a backslash, or a NUL byte.

### Local overlay

`localOverlay.neverOverwrite` lists paths that a sync never overwrites in the target:

- Ontology material: `src/agents/ontology-*.md`, `src/tools/ontology/**`, `src/skills/ontology-*/**`, `src/resources/ontology/**`, `src/ontology-pipeline.md`.
- Local configuration and outputs: `.agent-manager/agent-routing.json`, `src/plugins/agent-router/routing.json`, `.agent-manager/companion-links.json`, `.agent-manager/categories/**`, `src/opencode.json`, `export/categories/**`, `export/bridges/**`.
- Package and tooling files: `manage-agents/package.json`, `package-lock.json`, `tsconfig.json`, `bun.lock`, `bunfig.toml`, `.npmrc`, and `integration/**`.

`bash-profiles.json` and `translation-config.json` are not in the overlay; they ship with `agentManager`.

### Sync behavior

`applySharedSync` in `manage-agents/src/utils/sharedSync.ts` works as follows:

- The source is either a repository root or a release bundle (`release-index.json` plus `files/`), created by `releaseSharedSync`. Bundles are verified by hash before they are applied.
- Files matching `include` and not matching `exclude` or the overlay are collected. `.git`, `node_modules`, `.DS_Store`, and `manage-agents/dist` are always skipped, and symlinks are refused.
- `pipelineCore` applies only when the effective `agentManager` version satisfies `requiresAgentManager`. The effective version is the one being applied or the one already installed in the target.
- Overlay-matching files are preserved. Target files that were changed since the last sync, as recorded by hash in `.agent-manager/shared-sync-state.json`, or that are dirty in git, block the apply unless `--force` is passed.
- Component files the source no longer ships are deleted: files recorded by an earlier sync, files deleted in the source's git history (`git log --diff-filter=D`, carried by release bundles as `retired`), and target files matching an explicit include pattern (one with a literal file-name prefix, such as `src/agents/pipeline-*.md`; `src/agents/*.md` is a tree pattern and claims nothing). Files the source never had, the target's excludes and its overlay are left alone.
- Repository alignment (`planAlignment`): every category manifest and every `companion-links.json` entry the source has follows the source, except categories whose agents are overlay material (ontology); a missing `agent-routing.json` is seeded; `manage-agents/package.json` gets the source's `scripts`; `src/opencode.json` gains missing plugin directories; `.agent-manager/pipeline-profiles.json` and `export/categories/*-pipeline/` are removed. Release bundles carry these source files as `alignment` entries with hashes. `status` reports all of it as `obsoleteInTarget` and `alignment`.
- Deletions and alignment writes are refused for locally modified files, like ordinary writes, unless `--force` is passed.
- The apply is transactional: backups are taken first and restored if a step fails.
- For `pipelineCore`, if the target has `.agent-manager/bash-profiles.json`, the apply runs `pipeline sync-bash` on the target unless `--no-refresh` is passed. The report field is `refreshed: { bashProfiles }`.

`parseSharedSyncArgs` accepts the commands `status`, `diff`, `release`, `export`, `apply`, and `import`, with the options `--target`, `--from`, `--out`/`--output`, `--component`, `--dry-run`, `--force`, `--no-refresh`, `--check`, and `--json`.

## Category distribution manifests

The category manifests define portable resource bundles and generated configuration:

| Manifest | Bundle output | Included resources |
|---|---|---|
| `.agent-manager/categories/docs.json` | `export/categories/docs` | Root `AGENTS.md`; agents `docs-orchestrator`, `docs-planner`, and `docs-html_writer`; commands `new-doc`, `edit-doc`, `convert-doc`, and `web-audit`; the `docx` skill directory; the `plugins/doc-tools` directory; the mixed `tools/docx` directory (`.py`, `.md`, `.js`); shared helpers `tools/_tool.ts` and `tools/_safeName.js`; the `doc_*` tools; and `requirements.txt`. |
| `.agent-manager/categories/slides.json` | `export/categories/slides` | Root `AGENTS.md`; agents `slides-orchestrator`, `slides-planner`, `slides-html_writer`, `slides-template_planner`, `slides-template_writer`, and `slides-composition_resolver`; commands `new-slides`, `polish-slides`, and `fix-slide`; the `slides-composition` and `slides-template-html` skill directories; the `plugins/slide-tools` directory; the mixed `tools/pptx` directory (`.py`, `.js`, `.ts`, `.md`, `.xsd`, `.xml`); shared helpers `tools/_tool.ts` and `tools/_safeName.js`; the nine `slide_*` tools; `THIRD_PARTY_NOTICES.md`; and `requirements.txt`. |
| `.agent-manager/categories/pipeline.json` | `export/categories/pipeline` | Root `AGENTS.md`; the 21 canonical `pipeline-*` agents (`pipeline-orchestrator` is `mode: primary`, the other 20 are subagents); the pipeline commands, skills, plugins, and tools from the companion links, including `plugins/agent-router` and `tools/_agent_router.js`. `category check` also fails when the bundle does not ship a tool its agents permit or a helper a pipeline tool or plugin imports, and reports bash-profile drift. |
| `.agent-manager/categories/wiki.json` | `export/categories/wiki` | Root `AGENTS.md`; wiki agents (`wiki-analyzer`, `wiki-indexer`, `wiki-orchestrator`, `wiki-updater`, `wiki-writer`); the wiki command; and the `wiki-conventions`, `wiki-navigate`, and `wiki-templates` skills. |

Each manifest declares schema version `2`, a distribution version (`2.0.0`; `1.0.0` for `pipeline`), a category `id`, `title`, `description`, `output` path, and `allowRequirements: true`. The `generated` list writes `opencode.json` from the config entry `opencode-local-codebase-memory-v1`. Resource entries have a `kind` (`file` or `directory`), a `source`, a `target`, and a `policy` (`text` or `mixed`). Mixed directories also list `extensions`. Core entries carry `primary: true`.

## Agent manager package

`manage-agents/package.json` (version `1.0.0`) is an ES module package with a `manage-agents` executable. It declares `engines` for Node.js `>=26.4.0` and Bun `>=1.3.0`. Its scripts are:

- `start`: `node manage-agents.mjs`.
- `build`: bundles `src/index.tsx` with esbuild into `dist/index.js` (ESM, Node platform), externalizing `@opentui/core` and `yaml`.
- `typecheck`: `tsc --noEmit`.
- `test`: runs `typecheck`, then the Node test runner with `tsx` over `src/utils/*.test.ts`, several `../src/tools/_*.test.mjs` files, and `src/bench/bench.test.mjs`.
- `validate`: `typecheck`, `test`, `build`, `category build --all`, `category check --all`, and `bridge check`.

Runtime dependencies are `@opentui/core` and `@opentui/react` (0.5.7), `react` and `react-dom` (`^19.0.0`), `react-reconciler` (`^0.33.0`), and `yaml` (`^2.4.5`). Development dependencies are `esbuild`, `@types/node`, `typescript`, and `tsx`.

`manage-agents/tsconfig.json` targets ES2022 with NodeNext modules and resolution, uses React JSX (`react-jsx`), enables `skipLibCheck`, and disables strict checking. It sets `noEmit` and includes only `src/**/*.ts` and `src/**/*.tsx`.
