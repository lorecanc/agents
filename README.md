# Agents

Public monorepo for OpenCode agent catalogs and the companion `manage-agents` terminal UI.

## Projects

```text
.
├── agents/                  # Agent definitions, configuration, bridges, and docs
│   ├── general/             # Canonical OpenCode workspace
│   │   ├── agents/          # Source agent definitions
│   │   ├── commands/        # Slash commands
│   │   ├── skills/          # Skills
│   │   ├── tools/           # Document and slide tools
│   │   └── opencode.json    # MCP and LSP blueprint
│   ├── categories/          # Category-organized agent mirrors
│   ├── bridges/             # Claude Code and Codex translation layers
│   ├── docs/                # OpenCode and MCP documentation
│   └── .agent-manager/      # Translation and tier configuration
├── manage-agents/           # Standalone Bun/Node terminal manager
├── manage-agents.sh         # macOS/Linux launcher
└── .github/                 # Monorepo CI
```

`agents/general/` is intentionally preserved. `manage-agents` treats `agents/` as its workspace and discovers source files under `agents/general/agents/`. Imports, forks, category organization, and bridge generation use the same workspace layout.

## Quick Start

### Bun

From the monorepo root:

```bash
cd manage-agents
bun install
cd ..
./manage-agents.sh
```

Bun `>= 1.2.0` is recommended because OpenTUI uses FFI. The manager can also be invoked directly:

```bash
bun manage-agents/manage-agents.mjs bridge --help
```

### Node.js fallback

Node.js `>= 26.1.0` is supported. Install dependencies with npm, then launch from the monorepo root:

```bash
cd manage-agents
npm ci
cd ..
node manage-agents/manage-agents.mjs
```

On Node.js `>= 26.1.0`, `manage-agents.mjs` re-executes Node with `--experimental-ffi` automatically.

### Windows

Use Windows Terminal with PowerShell 7. The Unix `manage-agents.sh` launcher is Bash-only:

```powershell
Set-Location .\manage-agents
bun install
Set-Location ..
bun .\manage-agents\manage-agents.mjs
```

For the Node.js fallback:

```powershell
Set-Location .\manage-agents
npm ci
Set-Location ..
node .\manage-agents\manage-agents.mjs
```

The manager resolves the sibling `agents/` workspace automatically when launched from the monorepo root, `agents/`, or `manage-agents/`.

## Using The Agent Catalog

The effective source catalog is `agents/general/agents/`. The OpenCode blueprint is `agents/general/opencode.json`.

From the monorepo root, copy the blueprint to the OpenCode configuration directory:

```bash
cp agents/general/opencode.json ~/.config/opencode/opencode.json
```

On Windows PowerShell:

```powershell
Copy-Item agents\general\opencode.json "$env:USERPROFILE\.config\opencode\opencode.json"
```

The manager configuration is stored in `agents/.agent-manager/translation-config.json`. Generated bridges are written under `agents/bridges/`.

## Development

The manager is an independent TypeScript project:

```bash
cd manage-agents
npm ci
npm test
npm run build
```

Equivalent Bun commands are `bun install`, `bun test`, and `bun run build`.

See [`agents/README.md`](agents/README.md) for the catalog and [`manage-agents/README.md`](manage-agents/README.md) for the manager reference.
