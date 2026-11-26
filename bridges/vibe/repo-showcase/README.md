# repo-showcase

This directory is a generated **Vibe plugin** (Agent Plugins 1.0 with the `ai.mistral.vibe` extension) translated from the canonical OpenCode source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Install

Copy this directory (or let the manager install it) into one of the plugin roots:

- `~/.vibe/plugins/repo-showcase/` — user global: available in every session.
- `<project>/.vibe/plugins/repo-showcase/` — project scope: available when that trusted folder is open.

New sessions pick the plugin up automatically; a live session needs `/reload-plugins` (or `/reload`). `/plugins` lists it with its components.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

- `plugin.json` — Agent Plugins 1.0 manifest with the `ai.mistral.vibe` extension.
- `skills/` — pack skills plus the translated commands; each is a standard `SKILL.md` named `repo-showcase:<skill>` at runtime. User-invocable command skills appear in the slash menu.
- `ai.mistral.vibe/agents/` — one TOML per translated subagent, named `<plugin>:<agent>` at runtime.

All agents are also spawnable subagents, named `<plugin>:<agent>` at runtime: ask the model to delegate, or spawn them directly by name. Spawned subagents run with a reduced toolset — file access, session utilities and background processes; no MCP or connector tools, no skill loading, no user questions and no nested delegation — so the main agent gathers MCP- or skill-derived facts itself and passes them in the delegation message.

### Model connection

Each agent profile pins `active_model` to a Mistral model alias (`mistral-large-4`, `mistral-medium-3.5`, ...). Vibe only accepts aliases defined in the `[[models]]` entries of its own configuration and refuses an agent file whose alias is unknown, so align the translation config `vibe` tier models with the aliases of your Vibe installation, or set a tier model to `inherit` to leave the agent on the session's model. A `plugin.agent.invalid` diagnostic in the startup warnings names any refused agent file.

OpenCode tool names in prompts are rewritten where Vibe has an equivalent (`todowrite` → `todo`, `question` → `ask_user_question`, Task tool → `agents.spawn`, `read` → `read_file`, `write` → `write_file`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply.

## Agents

