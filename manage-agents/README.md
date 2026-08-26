# Agent Manager

## Auto-commit semantics

Enabled auto-commit is best-effort. Git preflight, staging, commit, or publish failures return the mutation value with a warning and recovery guidance; invalid plans and mutation failures remain blocking errors.

Standalone Node/Bun terminal manager and OpenTUI application for the canonical `agents/general/` catalog. It is the supported interface for category generation, bridge translation, catalog maintenance, and safe repository mutations.

## Purpose and architecture

The CLI/TUI reads the workspace, canonical agent files, category manifests, and translation configuration. Category renderers create deterministic distributions from manifest allowlists. Bridge renderers translate selected agents to Claude Code or Codex without modifying source prompts. Generated outputs include metadata or warnings where the target format cannot represent an OpenCode feature.

## Requirements and installation

Use Node.js `>=26.4.0` or Bun `>=1.3.0`; Bun is recommended. From the repository root:

```bash
cd manage-agents && npm ci
```

macOS/Linux: `./manage-agents.sh`, `bun manage-agents/manage-agents.mjs`, `node manage-agents/manage-agents.mjs`, or `npm start --prefix manage-agents`. Windows PowerShell: `bun .\manage-agents\manage-agents.mjs`, `node .\manage-agents\manage-agents.mjs`, or `npm start --prefix manage-agents`. Windows cmd uses the same `node`/`bun` commands with backslashes; the shell launcher requires WSL or Git Bash. The manager discovers the workspace from the repository root, `agents/`, or `manage-agents/`.

## Quick start

```bash
cd manage-agents
npm ci # or: bun install
npm start
```

The launcher also accepts direct Node/Bun invocation from the repository root; see the command examples below.

## CLI

Without a subcommand, the TUI starts. Available commands:

* `create [name]` — interactively create an agent.
* `bridge --category <name> [--target claude|codex] [--output path] [--name name] [--prefix prefix] [--source-dir dir] [--config path] [--wizard]` — generate translation layers and manifests.
* `export [--all|--category name]` — export to OpenCode with a disaster-recovery backup.
* `lint` — inspect naming convention compliance; `fix-names [--dry-run]` repairs names and references.
* `audit` — audit permission ordering and risk.
* `import [--dry-run]` — import from the OpenCode agent directory.
* `tune [--steps n] [--temp n] [--category name]` — update model parameters.
* `category list` — list category manifests.
* `category build <id|--all>`, `category check <id|--all>`, `category status <id|--all>`, `category explain <id|--all>` — build, verify, or inspect v2 distributions.
* `category package <id|--all> --output artifacts/categories [--dry-run]` — validate and copy current distributions into a repository-local artifact directory.
* `topic-export wiki [--check]` — deprecated alias forwarding to the category commands.

All commands support focused `--help` where implemented. Category output is under `agents/categories/`; it includes README, exact MIT `LICENSE`, AGENTS, CATEGORY lock, five Wiki agents, one command, three skills, minimal local `codebase-memory-mcp` configuration, and provenance hashes. `general/` is the source of truth; resources are selected through manifests and dependencies, not merely by filename.

## TUI keymap

Use arrows or `j/k`, `Tab` for list/tree, `/` search, `Space` select, `a` all/category, `s` same model, `m` model, `Shift-T` tier, `t` parameters, `c` color, `p` permission preset, `g` delegations, `r` rename, `o` organize, `f` fork, `b` Claude bridge, `Shift-B` Codex bridge, `e` export, `i` import diff, `1–4` inspector tabs, `F` fix permission order, `PageUp/PageDown` scroll, and `Esc` close modals. Modals support prompts, model/provider trees, tier assignment, color palettes, delegation toggles, import diffs, bridge configuration, confirmation dialogs, and action-result scrolling.

The TUI list/inspector split can be adjusted without writing to the repository. Create `.agent-manager/ui-config.json` with `{ "version": 1, "listShare": 0.6667 }`; values from `0.60` through `0.75` are accepted. Set `AGENT_MANAGER_UI_CONFIG` to use an external read-only config instead. Missing or invalid configuration uses the default two-thirds list share.

## Workflows and generated output

Edit canonical files under `agents/general/` and configuration under `agents/.agent-manager/`, then use `category build` or `bridge` to regenerate outputs. `category check` is read-only. Generated directories must not be edited directly; their README, category metadata, provenance hashes, and bridge warnings are produced by the manager.

## Backups, bridges, and safety

OpenCode exports back up to `~/.config/opencode/agents_backup/`; organize/fork operations use `agents/backups/` (ignored). Bridges are written to `agents/bridges/claude-code/` or `agents/bridges/codex/`, unless an external output is explicitly supplied. Repository mutations auto-commit only after a clean-worktree, identity, branch, lock, symlink, and scope check. Commits are local, unsigned, hook-free, and scoped. Normal Git worktree races remain possible, but selected paths are fingerprinted after mutation and verified immediately before commit; committed blobs and modes are verified afterward. Use `--no-auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=0`; failures leave changes for manual recovery and do not reset user work. Topic `--check` always bypasses transactions. Temporary staging/backup siblings are never staged.

## Development and validation

```bash
cd manage-agents
npm ci
npm test
npm run typecheck
npm run build
npm run validate
```

`validate` runs typecheck, tests, build, and the read-only `category check --all` freshness check. Build-all stages every category and leaves a recovery journal if interrupted. Bun equivalents are `bun install`, `bun test`, and `bun run build`. CI runs Node and Bun on macOS, Linux, and Windows.

Troubleshooting: configure `git config user.name` and `user.email` for auto-commit; clean unrelated work before mutations; remove a stale `agent-manager.lock` only after confirming no manager is running; never use symlinks in managed scopes; ensure `git` is on PATH; on Windows invoke quoted paths with PowerShell’s `&` operator and use Node/Bun rather than the Unix launcher.

## License

MIT. Third-party dependencies and services retain their own terms; see the repository root `LICENSE`.
