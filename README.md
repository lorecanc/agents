# OpenCode Agents Monorepo

A practical, free collection of OpenCode agents, commands, skills, tools, bridges, and the terminal **Agent Manager**. Use it personally or commercially under the MIT License.

## What is here

The canonical catalog is `agents/general/`: shared instructions, 116 canonical agents, commands, skills, tools, and the OpenCode configuration blueprint. Nine categories organize the catalog: `general`, `docs`, `slides`, `wiki`, `storybook`, `go-pipeline`, `copilot-pipeline`, `web`, and `data`.

Five pipeline families—Go, Copilot, docs, slides, and wiki—cover planning, research/exploration, implementation, testing, review, security, documentation, orchestration, and post-session verification. Shared stock roles include orchestrator, planner, reasoner, researcher, explorer, executor, tester, critic, code reviewer, refactorer, security auditor, frontend specialist, Swift specialist, Kotlin specialist, multimodal, docs grounding, Chrome DevTools, HITL, fast lane, and post-session.

The general catalog includes the manager-facing orchestrator, shell executor, loop verifier, and reusable document/slide workflows. Docs and slides provide HTML/A4 and PowerPoint planning, authoring, composition, and validation. Wiki provides analyzer, indexer, orchestrator, updater, and writer agents plus its command and three supporting skills.

## Layout and source of truth

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

Edit canonical files under `general/`, then regenerate distributions or bridges with the manager. `agents/wiki-generator/` is deprecated compatibility output, not a source tree. Category distributions contain no nested Git repository and are intentionally deterministic.

## Install into OpenCode

Copy `general/opencode.json` to your OpenCode configuration location, then copy or export the desired canonical agents to `~/.config/opencode/agents/`. The manager’s `export` command creates a recovery backup. The Wiki distribution is published at `agents/categories/wiki/` and is generated from `agents/.agent-manager/categories/wiki.json`.

## Naming and categories

Agent filenames follow `[{family}-]{category}-{role_with_underscores}.md`. Frontmatter category is authoritative for inference; the manager can lint and repair names. Keep source references pointed at canonical `general/` files.

## Wiki category distribution

Run `node manage-agents/manage-agents.mjs --no-auto-commit category build wiki` (or use Bun) to produce the self-contained Wiki package. `category check wiki` is read-only and reports missing, changed, or extra files. The manifest at `agents/.agent-manager/categories/wiki.json` is the exact allowlist; `PROVENANCE.json` records stable SHA-256 hashes.

### Command compatibility

The deprecated `topic-export wiki` command remains only as a compatibility alias for the category commands; it does not define a path or architecture.

## License

Project-owned agents, prompts, skills, commands, tools, and documentation are MIT licensed. Third-party software and services retain their own licenses and terms; see the root `LICENSE`.
