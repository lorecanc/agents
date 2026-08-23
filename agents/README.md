# Agent Catalog

This project contains the effective OpenCode agent workspace used by the public monorepo. It is intentionally separate from the sibling [`manage-agents`](../manage-agents/README.md) TypeScript/Bun project.

## Workspace Layout

```text
agents/
├── general/
│   ├── agents/       # Canonical source agent definitions
│   ├── commands/     # OpenCode slash commands
│   ├── skills/       # Installed skills
│   ├── tools/        # Document and slide tools
│   └── opencode.json # MCP and LSP blueprint
├── categories/       # Category-organized agent mirrors
├── bridges/          # Claude Code and Codex translation layers
├── docs/             # OpenCode and MCP documentation
├── wiki-generator/  # Wiki generation and update agents
└── .agent-manager/   # Translation tiers, roles, and overrides
```

`general/agents/` is the source catalog. The manager uses `agents/` as its workspace root and keeps the default `sourceDir` set to `general`. Do not move `general/` into the manager project: discovery, import, fork, category organization, and bridge generation depend on this layout.

## OpenCode Setup

From the monorepo root, copy the blueprint into the OpenCode configuration directory:

```bash
cp agents/general/opencode.json ~/.config/opencode/opencode.json
```

On Windows PowerShell 7:

```powershell
Copy-Item agents\general\opencode.json "$env:USERPROFILE\.config\opencode\opencode.json"
```

The blueprint is portable across macOS, Linux, Windows/WSL, and selectively disables platform-specific services such as Xcode by default. See [`docs/mcp-configuration.md`](docs/mcp-configuration.md) for MCP and LSP setup details.

## Catalogs And Bridges

- `general/agents/` contains canonical definitions for the available agent families and roles.
- `categories/` contains organized copies used for browsing and category-specific workflows.
- `bridges/claude-code/` and `bridges/codex/` contain generated translation layers.
- `.agent-manager/translation-config.json` defines target models, tiers, roles, overrides, and bridge output settings.

## Manager

Install and run the manager from the monorepo root:

```bash
cd manage-agents
bun install
cd ..
./manage-agents.sh
```

The standalone manager documentation is in [`../manage-agents/README.md`](../manage-agents/README.md). The root [`README.md`](../README.md) contains the complete cross-platform startup guide.
