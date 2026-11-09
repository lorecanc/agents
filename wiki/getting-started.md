---
title: "Getting Started"
description: "Install and run the Agent Manager, validate and build catalog distributions, generate Claude Code and Codex bridges, and install agents into OpenCode."
category: "root"
source_files:
  - "README.md"
  - "manage-agents/README.md"
  - "manage-agents/package.json"
  - "manage-agents/manage-agents.mjs"
  - "manage-agents/src/index.tsx"
  - "manage-agents/src/utils/agents.ts"
  - "manage-agents/src/utils/repositoryTransaction.ts"
created: "2026-10-16"
last_updated: "2026-11-09"
---

# Getting Started

## Prerequisites

- Node.js `>=26.4.0` or Bun `>=1.3.0` (the manager documentation recommends Bun).
- npm or Bun to install the manager's dependencies.
- OpenCode is needed only if you intend to install and use the catalog in an OpenCode workspace.
- The `claude` CLI is optional. When it is on `PATH`, `bridge --target claude` also runs plugin validation and registration; when it is absent, those steps are skipped with warnings and generation still succeeds.

## Installation

From the repository root, install the manager dependencies:

```bash
cd manage-agents
npm ci
```

Alternatively, use `bun install` in `manage-agents/`.

## Running Locally

Start the interactive terminal UI, described in the [Agent Manager](./modules/agent-manager.md) reference, from `manage-agents/`:

```bash
npm start
```

The equivalent direct invocations are `node manage-agents/manage-agents.mjs` or `bun manage-agents/manage-agents.mjs` from the repository root. Running the manager with a command, for example `node manage-agents/manage-agents.mjs category check --all`, invokes its CLI instead of starting the TUI.

### Build and Check Category Distributions

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build --all
node manage-agents/manage-agents.mjs --no-auto-commit category check --all
```

`category build --all` rewrites the generated distributions under `export/categories/`. `category check` is read-only and reports whether generated files are current.

### Generate Claude Code and Codex Bridges

```bash
node manage-agents/manage-agents.mjs --no-auto-commit bridge --category pipeline --target claude
node manage-agents/manage-agents.mjs --no-auto-commit bridge --category pipeline --target codex
```

Without `--name`, the plugin is named `decent-pipeline` and written to `export/bridges/claude-code/decent-pipeline/` or `export/bridges/codex/decent-pipeline/`. For the Claude target, `--no-validate` and `--no-register` skip the `claude` CLI steps. `bridge check` compares committed bridges with a fresh regeneration and exits with code 1 on drift. The bridge options and translation rules are described in [Bridges](./modules/bridges.md) and in the [Agent Manager](./modules/agent-manager.md) reference.

### Install Agents into OpenCode

```bash
node manage-agents/manage-agents.mjs export --all --yes
```

`export` writes to the OpenCode configuration directory: `$XDG_CONFIG_HOME/opencode/` when `XDG_CONFIG_HOME` is set, otherwise `~/.config/opencode/`.

- `--all` (`-a`) exports every agent; `--category <name>` (`-c`) limits the export to one category. `--yes` (`-y`) skips the confirmation prompt.
- Agent files go to `agents/`. Companion resources from `tools/`, `commands/`, `skills/`, and `plugins/` are installed under the same relative paths.
- The export is idempotent: agent files whose content and mode already match are not rewritten, and identical resource files are skipped. A backup is created only when an existing file would be replaced (`agents_backup/` for agents, `resource_export_backup_*` for resources).
- The export reconciles `experimental.todo` in the configuration's `opencode.json`, backing up the previous file to `opencode.json.bak`.
- Before exporting, the command rebuilds `src/plugins/agent-router/routing.json` from `.agent-manager/agent-routing.json`, so it can modify that file in the repository.
- The pipeline is installed once. When a pipeline agent is exported, the retired installed files `{free,go,hybrid,mistral}-pipeline-<role>.md` (exact names only) are removed from `agents/`.

`src/opencode.json` remains the configuration blueprint, see [Workspace and Distribution Configuration](./config/workspace-and-distribution.md). The export command does not copy it; the keys it reconciles are listed above.

## Project Conventions

- Treat `src/` as the canonical location for source agents and companion resources. Treat `.agent-manager/` as the location for category manifests and manager settings.
- Regenerate output under `export/` with manager commands instead of editing generated files directly.
- Agent filenames use the pattern `[{family}-]{category}-{role_with_underscores}.md`; the frontmatter category is authoritative for category inference.
- Automatic repository commits are opt-in. Use `--auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=1` to enable them; the default is off. `--no-auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=0` disables them explicitly, and CLI flags take precedence over the environment variable. The repository-writing examples on this page pass `--no-auto-commit`.

## Development and Validation

```bash
cd manage-agents
npm ci
npm test
npm run typecheck
npm run build
npm run validate
```

`npm test` runs `npm run typecheck` before the Node test runner. `npm run validate` runs, in order:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `node manage-agents.mjs --no-auto-commit category build --all`
5. `node manage-agents.mjs category check --all`
6. `node manage-agents.mjs bridge check`

`validate` is not purely read-only, despite the README's description of it as a freshness check. Step 4 rewrites `export/categories/`, so run `git status` afterward to review the regenerated files. Step 6 fails when committed bridges under `export/bridges/` differ from a fresh regeneration. Bun equivalents are `bun install`, `bun test`, and `bun run build`. CI runs Node and Bun on macOS, Linux, and Windows.

Troubleshooting: configure `git config user.name` and `user.email` for auto-commit; clean unrelated work before mutations; remove a stale `agent-manager.lock` only after confirming no manager is running; never use symlinks in managed scopes; ensure `git` is on PATH; ensure the `claude` CLI is on PATH for automatic Claude bridge validation and registration (generation still succeeds without it); on Windows invoke quoted paths with PowerShell’s `&` operator and use Node/Bun rather than the Unix launcher.

For the system layout and data flow behind these commands, see [Architecture](./architecture.md).
