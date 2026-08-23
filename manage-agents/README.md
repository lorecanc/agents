# manage-agents

Standalone terminal manager for the OpenCode agent catalog in the sibling `agents/` project.

## Runtime

- Bun `>= 1.2.0` is recommended because OpenTUI uses FFI.
- Node.js `>= 26.1.0` is supported with automatic `--experimental-ffi` re-execution.
- Windows requires Windows Terminal with PowerShell 7; the Unix launcher is Bash-only.

The manager does not contain a copy of the agent definitions. It resolves the workspace containing `general/agents/` from the current directory, so it can be launched from the monorepo root, `agents/`, or `manage-agents/`.

## Install And Run

From the monorepo root:

```bash
cd manage-agents
bun install
cd ..
./manage-agents.sh
```

Useful commands:

```bash
./manage-agents.sh lint
./manage-agents.sh create example-agent
bun manage-agents/manage-agents.mjs bridge --help
```

With Node.js instead of Bun:

```bash
cd manage-agents
npm ci
cd ..
node manage-agents/manage-agents.mjs
```

On Windows PowerShell 7, run the equivalent paths with backslashes:

```powershell
Set-Location .\manage-agents
bun install
Set-Location ..
bun .\manage-agents\manage-agents.mjs
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
