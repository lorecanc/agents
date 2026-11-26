# wiki

This directory is a generated **Vibe plugin** (Agent Plugins 1.0 with the `ai.mistral.vibe` extension) translated from the canonical OpenCode source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Install

Copy this directory (or let the manager install it) into one of the plugin roots:

- `~/.vibe/plugins/wiki/` — user global: available in every session.
- `<project>/.vibe/plugins/wiki/` — project scope: available when that trusted folder is open.

New sessions pick the plugin up automatically; a live session needs `/reload-plugins` (or `/reload`). `/plugins` lists it with its components.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

- `plugin.json` — Agent Plugins 1.0 manifest with the `ai.mistral.vibe` extension.
- `skills/` — pack skills plus the translated commands; each is a standard `SKILL.md` named `wiki:<skill>` at runtime. User-invocable command skills appear in the slash menu.
- `ai.mistral.vibe/agents/` — one TOML per translated subagent, named `<plugin>:<agent>` at runtime.
- `agent-profiles/` — one TOML per translated primary agent, to install into `~/.vibe/agents/` (the manager does this by default).
- `mcp.json` — MCP servers declared by the plugin.

All agents are also spawnable subagents, named `<plugin>:<agent>` at runtime: ask the model to delegate, or spawn them directly by name. Spawned subagents run with a reduced toolset — file access, session utilities and background processes; no MCP or connector tools, no skill loading, no user questions and no nested delegation — so the main agent gathers MCP- or skill-derived facts itself and passes them in the delegation message.

## Main agent profiles

The plugin format ships spawnable subagents only, and a spawned subagent cannot delegate further. The translated primary agents therefore also ship as main agent profiles: install `agent-profiles/` into `~/.vibe/agents/` (the manager does this by default) and start Vibe with `vibe --agent <profile>` (or switch a live session with `/agent <profile>`).

- **wiki-orchestrator** (`vibe --agent wiki-orchestrator`, model: zai-glm-5-3): Orchestrates wiki generation and updates. Decides flow and delegates to specialized subagents.

If your `config.toml` sets `enabled_agents`, add the profile names there or they stay hidden. Subagent profiles are rejected as `--agent`, so these main profiles are also the only way to run a specialist at the session level (for example from external tooling).

### Model connection

Every agent follows the Vibe session's model by default: a tier model, a `modelMap` entry or an override pins `active_model` only when the translation config says so, and `inherit` restores the default. Vibe only accepts aliases defined in the `[[models]]` entries of its own configuration and refuses an agent file whose alias is unknown, so align any pinned tier model with the aliases of your Vibe installation. A `plugin.agent.invalid` diagnostic in the startup warnings names any refused agent file.

OpenCode tool names in prompts are rewritten where Vibe has an equivalent (`todowrite` → `todo`, `question` → `ask_user_question`, Task tool → `agents.spawn`, `read` → `read_file`, `write` → `write_file`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply. Commands were translated into user-invocable skills: their `$ARGUMENTS` placeholder became `$request`, and `!`substitutions`` became inline bash blocks.

## MCP setup

`mcp.json` declares the translated servers. `npx` commands are fetched on first use; binaries must already be available on `PATH`.

- `codebase-memory-mcp` — runs `codebase-memory-mcp` (Node.js, npm and network access required for npx).

The plugin carries these servers as-is. Authenticated remote servers (and `{env:VAR}` headers) cannot be expressed in a plugin's static mcp.json: install them at the Vibe config level instead, for example `vibe mcp add <name> --url <url> --api-key-env <VAR>`, or via OAuth.

Commands may carry the `{browser}` placeholder: the manager's installer resolves it to this machine's browser (Chromium preferred over Chrome) and drops the argument when none is installed.

In a session, run `/mcp` (or `/mcp status`) to verify every server is connected.

## Per-agent bash allowlists (not enforced)

Vibe agent files narrow tool use with `[tools.<name>] permission = "ask" | "never"` only; there is no per-command allowlist. The bridge emits `permission = "never"` for the tools an OpenCode agent denies and lets everything else follow the session's approval policy. The source rules are listed here so they can be reviewed or copied into the Vibe config `[tools.bash]` allowlist/denylist entries.

<details><summary>analyzer (6 rules)</summary>

- allow: `find *`, `wc *`, `head *`, `cat *`, `ls *`, `tree *`

</details>

<details><summary>indexer (4 rules)</summary>

- allow: `find wiki/ *`, `cat wiki/*`, `ls wiki/*`, `date *`

</details>

<details><summary>orchestrator (1 rule)</summary>

- allow: `git *`

</details>

<details><summary>updater (4 rules)</summary>

- allow: `git diff *`, `git log *`, `git show *`, `cat *`

</details>

## Agents

- **analyzer** (spawn as `wiki:analyzer`, safety `neutral`, model: deepseek-v4-1-flash-1017): Analyzes a codebase structure for wiki generation. Read-only — never modifies files.
- **indexer** (spawn as `wiki:indexer`, safety `neutral`, model: deepseek-v4-1-flash-1017): Maintains wiki/index.md, wiki/log.md, and wiki/glossary.md. Sole owner of these files.
- **orchestrator** (spawn as `wiki:orchestrator`, safety `neutral`, model: zai-glm-5-3): Orchestrates wiki generation and updates. Decides flow and delegates to specialized subagents.
- **updater** (spawn as `wiki:updater`, safety `neutral`, model: deepseek-v4-1-flash-1017): Analyzes git diff to determine which wiki pages need updating. Maps source file changes to wiki page impact.
- **writer** (spawn as `wiki:writer`, safety `neutral`, model: deepseek-v4-1-flash-1017): Writes and updates individual wiki pages. Reads source code and produces structured markdown documentation.

## Translation warnings

- [model-map] entry "opencode-go/deepseek-v4.1-flash" matches no source agent model
- wiki-analyzer.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- wiki-analyzer.md: 'steps' has no per-agent Vibe equivalent; ignored
- wiki-indexer.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- wiki-indexer.md: 'steps' has no per-agent Vibe equivalent; ignored
- wiki-orchestrator.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- wiki-orchestrator.md: OpenCode mode 'primary' emitted as spawnable subagent 'wiki:orchestrator' and as main agent profile 'wiki-orchestrator' (run it with 'vibe --agent wiki-orchestrator'; a spawned subagent cannot delegate further)
- wiki-orchestrator.md: 'steps' has no per-agent Vibe equivalent; ignored
- wiki-orchestrator.md: 'hidden: true' has no Vibe equivalent; ignored
- wiki-updater.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- wiki-updater.md: 'steps' has no per-agent Vibe equivalent; ignored
- wiki-writer.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- wiki-writer.md: 'steps' has no per-agent Vibe equivalent; ignored
- [commands] 'wiki': converted 9 !-substitution(s) to inline instructions
