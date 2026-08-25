# Agent Catalog

This directory contains the effective OpenCode workspace used by the monorepo. It is intentionally separate from the sibling [`manage-agents`](../manage-agents/README.md) TypeScript/Bun project.

## Purpose and audience

This is the place to browse and maintain reusable agent instructions, commands, skills, tools, and the OpenCode configuration blueprint. Developers normally consume the generated or canonical content; contributors edit only the canonical inputs described below.

## Workspace Layout

```text
agents/
├── general/
│   ├── agents/       # Canonical source agent definitions
│   ├── commands/     # OpenCode slash commands
│   ├── skills/       # Installed skills
│   ├── tools/        # Document and slide tools
│   └── opencode.json # MCP and LSP blueprint
├── categories/       # Generated category distributions; categories are local generated distributions
├── bridges/          # Claude Code and Codex translation layers
├── docs/             # OpenCode and MCP documentation
├── wiki-generator/  # Wiki generation and update agents
└── .agent-manager/   # Translation tiers, roles, and overrides
```

`general/` is the only canonical content tree. Category output is generated from explicit manifests and is never a source. Categories are local generated distributions for browsing and category-specific workflows; they are not remote repositories. Bridges are also generated and should be regenerated rather than patched.

## Quick start and OpenCode setup

From the monorepo root, copy the blueprint into the OpenCode configuration directory:

```bash
cp agents/general/opencode.json ~/.config/opencode/opencode.json
```

On Windows PowerShell 7:

```powershell
Copy-Item agents\general\opencode.json "$env:USERPROFILE\.config\opencode\opencode.json"
```

The blueprint is portable across macOS, Linux, Windows/WSL, and selectively disables platform-specific services such as Xcode by default. See [`docs/mcp-configuration.md`](docs/mcp-configuration.md) for MCP and LSP setup details.

## Catalogs and bridges

- `general/agents/` contains canonical definitions for the available agent families and roles.
- `categories/` contains organized copies used for browsing and category-specific workflows.
- `bridges/claude-code/` and `bridges/codex/` contain generated translation layers.
- `.agent-manager/translation-config.json` defines target models, tiers, roles, overrides, and bridge output settings.

## Contribution and validation

Keep source references pointed at `general/`, update manifests only when the intended inventory changes, and run the relevant manager checks before submitting a change. Generated README files, category metadata, and bridge files are outputs of their renderers.

## Manager

Install and run the manager from the monorepo root:

```bash
cd manage-agents
bun install
cd ..
./manage-agents.sh
```

The standalone manager documentation is in [`../manage-agents/README.md`](../manage-agents/README.md). The root [`README.md`](../README.md) contains the complete cross-platform startup guide.
