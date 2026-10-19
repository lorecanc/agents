---
title: "Getting Started"
description: "Install and run the Agent Manager, then build or validate catalog distributions."
category: "root"
source_files:
  - "README.md"
  - "manage-agents/README.md"
  - "manage-agents/package.json"
created: "2026-10-16"
last_updated: "2026-10-16"
---

# Getting Started

## Prerequisites

- Node.js `>=26.4.0` or Bun `>=1.3.0` (the manager documentation recommends Bun).
- npm or Bun to install the manager's dependencies.
- OpenCode is needed only if you intend to install and use the catalog in an OpenCode workspace.

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

To build and validate all configured category distributions:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build --all
node manage-agents/manage-agents.mjs --no-auto-commit category check --all
```

`category check` is read-only and reports whether generated files are current. For an OpenCode setup, `src/opencode.json` is the configuration blueprint; see [Workspace and Distribution Configuration](./config/workspace-and-distribution.md), then copy the blueprint to the OpenCode configuration location and copy or export the desired agents to its agents directory.

## Project Conventions

- Treat `src/` as the canonical location for source agents and companion resources. Treat `.agent-manager/` as the location for category manifests and manager settings.
- Regenerate output under `export/` with manager commands instead of editing generated files directly.
- Agent filenames use the pattern `[{family}-]{category}-{role_with_underscores}.md`; the frontmatter category is authoritative for category inference.
- Automatic repository commits are opt-in. Use `--auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=1` to enable them; the default is off.

The package provides `npm test`, `npm run typecheck`, `npm run build`, and `npm run validate`; `validate` runs typecheck, tests, build, and the read-only all-category freshness check.
