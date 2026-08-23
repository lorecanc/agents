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

### Prerequisites

You need one runtime: Node.js `>= 26.1.0` or Bun `>= 1.2.0`. Bun is recommended because OpenTUI uses FFI.

Download either runtime per https://docs.npmjs.com/downloading-and-installing-node-js-and-npm, which also covers version managers (`nvm` or `n` on macOS and Linux, `nvm-windows` or `nodist` on Windows). The `engines` field in `manage-agents/package.json` declares these minimums; npm treats them as an advisory warning unless you enable `engine-strict`.

Install dependencies once from the monorepo root:

```bash
cd manage-agents
npm ci
```

Bun users can substitute `bun install`.

On Node.js `>= 26.1.0`, `manage-agents.mjs` re-executes Node with `--experimental-ffi` automatically.

### macOS

Launch with the bundled script from the monorepo root (it prefers Bun and falls back to Node):

```bash
./manage-agents.sh
```

Or invoke the entry point directly:

```bash
bun manage-agents/manage-agents.mjs
node manage-agents/manage-agents.mjs
```

Or use the cross-platform npm script:

```bash
npm start --prefix manage-agents
```

### Linux

Linux follows the same launcher flow as macOS:

```bash
./manage-agents.sh
```

Direct invocation and the npm script behave identically:

```bash
bun manage-agents/manage-agents.mjs
node manage-agents/manage-agents.mjs
npm start --prefix manage-agents
```

For distro packages or a version manager such as `nvm` or `n`, follow the npm install guide linked under Prerequisites.

### Windows

Run the entry point directly from any shell — no Unix launcher required:

```powershell
bun .\manage-agents\manage-agents.mjs
node .\manage-agents\manage-agents.mjs
```

Bun supports Windows natively since v1.1 (Windows 10 1809+): see bun.sh/docs/installation and bun.sh/blog/bun-v1.1.

In PowerShell, the call operator (`&`) is needed whenever you invoke a quoted command string — most commonly a path containing spaces, e.g. `& "C:\my tools\agents\manage-agents\manage-agents.mjs"` — see learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_operators.

To run the Bash launcher instead, use WSL (recommended): see learn.microsoft.com/windows/wsl/about — or Git Bash from gitforwindows.org:

```bash
./manage-agents.sh
```

The npm script works from any shell:

```powershell
npm start --prefix manage-agents
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
