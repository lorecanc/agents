# OpenCode Agents Monorepo

## Auto-commit semantics

When enabled, repository auto-commit is best-effort: Git failures never block a valid mutation. Warnings include recovery guidance; unsafe plan validation and mutation errors still propagate.

A reusable OpenCode workspace containing agent prompts, commands, skills, tools, category distributions, Claude/Codex bridges, and the terminal **Agent Manager**. Project-owned content is available under the MIT License.

## Purpose and audience

Use this repository when you want a ready-made multi-agent workflow, a portable OpenCode configuration, or a manager for organizing, exporting, validating, and translating agents. The canonical catalog is aimed at developers and teams who prefer explicit prompts and reproducible generated outputs.

## What is here

The canonical catalog is `agents/general/`: shared instructions, 116 canonical agents, commands, skills, tools, and the OpenCode configuration blueprint. Nine categories organize the catalog: `general`, `docs`, `slides`, `wiki`, `storybook`, `go-pipeline`, `copilot-pipeline`, `web`, and `data`.

Five pipeline families—Go, Copilot, docs, slides, and wiki—cover planning, research/exploration, implementation, testing, review, security, documentation, orchestration, and post-session verification. Shared stock roles include orchestrator, planner, reasoner, researcher, explorer, executor, tester, critic, code reviewer, refactorer, security auditor, frontend specialist, Swift specialist, Kotlin specialist, multimodal, docs grounding, Chrome DevTools, HITL, fast lane, and post-session.

The general catalog includes the manager-facing orchestrator, shell executor, loop verifier, and reusable document/slide workflows. Docs and slides provide HTML/A4 and PowerPoint planning, authoring, composition, and validation. Wiki provides analyzer, indexer, orchestrator, updater, and writer agents plus its command and three supporting skills.

## Architecture and source of truth

```text
agents/
├── general/                 # canonical OpenCode catalog
│   ├── agents/ commands/ skills/ tools/
│   └── opencode.json
├── categories/              # generated category distributions; never edit directly
├── bridges/                 # generated Claude/Codex translation outputs
├── docs/                    # OpenCode and MCP reference material
└── .agent-manager/          # manager configuration and category manifests
manage-agents/               # TypeScript terminal manager and TUI
```

Edit canonical files under `general/`, manifests under `agents/.agent-manager/`, or translation settings when appropriate. Regenerate distributions and bridges with the manager; do not edit generated output. `agents/wiki-generator/` is deprecated compatibility output, not a source tree. Category distributions are deterministic and contain no nested Git repository.

## Quick start

```bash
cd manage-agents
npm ci # or: bun install
cd ..
./manage-agents.sh
```

The launcher starts the TUI. For a portable OpenCode setup, copy `agents/general/opencode.json` to your OpenCode configuration directory as described in [`agents/README.md`](agents/README.md).

## Install into OpenCode

Copy `agents/general/opencode.json` to your OpenCode configuration location, then copy or export the desired canonical agents to `~/.config/opencode/agents/`. The manager’s `export` command creates a recovery backup. Category distributions are generated locally under `agents/categories/` from manifests in `agents/.agent-manager/categories/`; deterministic packages can be shared manually as artifacts.

## Workflow and validation

Canonical agent content is organized into category manifests and can be projected with `category build`. Use `category check` to verify generated files without writing. The manager also supports linting, importing, exporting, model tuning, packaging, and Claude/Codex bridge generation. See [`manage-agents/README.md`](manage-agents/README.md) for the complete command reference and validation commands.

## Naming and categories

Automatic repository commits are opt-in: use `--auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=1`; the default is off and mutations go directly to the worktree without Git operations. `--no-auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=0` explicitly disables it, and CLI flags take precedence. Enabled commits require a clean repository, then use Git’s native real index/ref locks and a literal, NUL-safe, path-limited `git commit --only`; only genuinely new paths receive `git add --intent-to-add`. Hooks, signing, and the editor are disabled for this private commit. Auto-commit is best-effort: failures never block a valid mutation, never reset or restore user work, and return a warning while preserving any index residue for manual recovery. Concurrent unrelated staging remains staged and is excluded from the commit. An edit to the same declared path during synchronous mutation may be included as the latest worktree state; stop edits when that matters or leave auto-commit off.

Agent filenames follow `[{family}-]{category}-{role_with_underscores}.md`. Frontmatter category is authoritative for inference; the manager can lint and repair names. Keep source references pointed at canonical `general/` files.

## Generated distributions

Run `node manage-agents/manage-agents.mjs --no-auto-commit category build --all` (or use Bun) to produce all self-contained packages. `category check --all` is read-only; `category package --all --output artifacts/categories --dry-run` previews a safe artifact copy. The manifests at `agents/.agent-manager/categories/*.json` are exact v2 allowlists; `PROVENANCE.json` records stable SHA-256 hashes.

### Command compatibility

The deprecated `topic-export wiki` command remains only as a compatibility alias for the category commands; it does not define a path or architecture.

## License

Project-owned agents, prompts, skills, commands, tools, and documentation are MIT licensed. Third-party software and services retain their own licenses and terms; see the root `LICENSE`.
