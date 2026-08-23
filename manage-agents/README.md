# manage-agents

Standalone terminal manager for the OpenCode agent catalog in the sibling `agents/` project.

## Runtime

- Bun `>= 1.2.0` is recommended because OpenTUI uses FFI.
- Node.js `>= 26.1.0` is supported with automatic `--experimental-ffi` re-execution.
- Windows: Bun >= 1.2.0 (Windows 10 1809+) or Node >= 26.1.0 both work — invoke manage-agents.mjs directly; use WSL or Git Bash for ./manage-agents.sh.

The manager does not contain a copy of the agent definitions. It resolves the workspace containing `general/agents/` from the current directory, so it can be launched from the monorepo root, `agents/`, or `manage-agents/`.

## Install And Run

Install dependencies once:

```bash
cd manage-agents
npm ci   # or: bun install
```

macOS and Linux — from the monorepo root, launch with the bundled script (prefers Bun, falls back to Node) or invoke directly:

```bash
./manage-agents.sh
bun manage-agents/manage-agents.mjs   # or: node manage-agents/manage-agents.mjs
npm start --prefix manage-agents      # cross-platform npm script
```

Windows — invoke the entry point directly from any shell:

```powershell
bun .\manage-agents\manage-agents.mjs   # or: node .\manage-agents\manage-agents.mjs
npm start --prefix manage-agents
```

Use WSL or Git Bash for `./manage-agents.sh`.

Useful commands:

```bash
./manage-agents.sh lint
./manage-agents.sh create example-agent
bun manage-agents/manage-agents.mjs bridge --help
```

## Workspace Contract

The manager keeps the agent workspace layout unchanged:

| Responsibility | Path |
|---|---|
| Source agents | `agents/general/agents/` |
| OpenCode blueprint | `agents/general/opencode.json` |
| Translation config | `agents/.agent-manager/translation-config.json` |
| Category mirrors | `agents/categories/` |
| Generated bridges | `agents/bridges/` |
| Export destination | `~/.config/opencode/agents/` or `XDG_CONFIG_HOME/opencode/agents/` |

The default translation `sourceDir` remains `general`. Do not move `general/` into `manage-agents/` or rename it: discovery, import, fork, category organization, and bridge generation depend on this workspace contract.

## Development

```bash
npm ci
npm test
npm run build
```

The package exposes `manage-agents.mjs` as its executable entry point and keeps generated `dist/` output out of version control.
