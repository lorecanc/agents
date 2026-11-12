# OpenCode agent packs

Ready-made OpenCode agents, commands, skills, plugins and tools, distributed as **packs** and installed with
[manage-agents](manage-agents/README.md). Project-owned content is MIT licensed.

## Packs

| Pack | What it gives you | Requires |
|---|---|---|
| `flow` | Claude Code style workflow: `flow-build`, the in-conversation plan mode `flow-plan`, and read-only subagents for exploration, review, research, visual review and operations. Archetype. | `code-review`, `common`, `dev-tools`, `integrations`, `toolkit` |
| `pipeline` | Multi-agent pipeline: `pipeline-orchestrator` routes work to planner, executor, tester, reviewers, security auditor and platform specialists. Archetype. | `code-review`, `common`, `dev-tools`, `integrations`, `office-tools`, `toolkit` |
| `docs` | A4 HTML documents with DOCX export: planning, layout, writing. | `common`, `office-tools`, `toolkit` |
| `slides` | PowerPoint decks: templates, composition, writing, validation. | `common`, `office-tools`, `toolkit` |
| `wiki` | Project wiki generation and upkeep. | `common` |
| `general` | Standalone agents, commands and skills. | `integrations` |
| `common`, `code-review`, `dev-tools`, `office-tools`, `toolkit`, `integrations` | Shared pieces the packs above require: skills, the `dev_*` and `doc_*`/`slide_*` tools with their plugins, MCP servers, LSP settings. | |

`manage-agents resolve <pack>` prints the exact closure, files and executable content of a pack before you install it.

**Archetypes.** In `flow` and `pipeline` the primary agents delegate to subagents. The subagents' models follow the
caller's model: `routingDefaults` in the pack's `opencode-pack.json` say, for each provider or exact model the caller
runs on, which model each subagent uses (or `inherit`). Change them for yourself with `manage-agents models`, or for
everyone by editing the pack (`m` on the pack folder in the manage-agents TUI).

## Install

```bash
manage-agents source add catalog https://github.com/lorecanc/agents.git
manage-agents source pull
manage-agents install flow pipeline        # into ~/.config/opencode (or --target <dir>)
manage-agents status
```

`manage-agents update` moves to the latest commit of the catalog; `manage-agents uninstall <pack>` removes a pack and
the dependencies nothing else needs. Your own keys in `opencode.json` are never touched.

Claude Code and Codex users can use the pipeline without OpenCode: [`bridges/claude-code/decent-pipeline`](bridges/claude-code/decent-pipeline)
and [`bridges/codex/decent-pipeline`](bridges/codex/decent-pipeline), each with its own README.

## Layout

```text
packs/<name>/        one pack per directory: opencode-pack.json + OpenCode-native content
scripts/             catalog tooling: merge-packs.mjs (builds .tree/), sync-bash.mjs + bash-profiles.json
bridges/             generated Claude Code and Codex translations of the pipeline, translation-config.json
bench/ bin/ docs/    agent benchmark, opencode-wt, documentation
.tree/               generated: every pack merged as OpenCode sees them installed (tests and bench run here)
```

Packs follow the contract in [`manage-agents/contract/CONTRACT.md`](manage-agents/contract/CONTRACT.md): native
OpenCode paths, every other file under the pack's namespace (`tools/<pack>/`, `resources/<pack>/`), shared code in a
pack the others require, tests (`*.test.*`) next to the code and never installed.

## Development

```bash
npm ci
npm test                 # builds .tree/, runs the pack, bench and script tests
npm run check            # pipeline shell rules match scripts/bash-profiles.json (npm run sync-bash rewrites them)
manage-agents pack validate packs/*/
manage-agents bridge check
```

Edit packs with the manage-agents TUI from the repository root (`manage-agents`): models, permissions, skills,
delegations, parameters, routing defaults, and `e` to install the focused pack into your OpenCode config. Agent
filenames follow `[family-]<pack>-<role>.md`. [`AGENTS.md`](AGENTS.md) is the maintenance handoff for agents working
on this repository.

## License

Project-owned agents, prompts, skills, commands, tools and documentation are MIT licensed. Third-party software and
services keep their own licenses and terms; see `LICENSE`.
