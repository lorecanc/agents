# artcraft

This directory is a generated translation layer from the canonical source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

## Run in Codex

From this directory, run `codex` and trust the project to load its local configuration, or open this directory in the Codex app.

- `.codex/config.toml` configures MCP for the project. Run `codex mcp list` here to inspect it.
- `.agents/skills/` contains the pack skills, their supporting files and any translated agent prompts.

## Install the plugin separately

To use the plugin's packaged skills or MCP servers in other projects, run these commands from this directory:

```sh
codex plugin marketplace add .
codex plugin add artcraft@artcraft-local
```

OpenCode tool names in prompts are translated where Codex has an equivalent (`todowrite` → `update_plan`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply.

## MCP setup

`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.

- `anicraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `anicraft-cli` available on `PATH`.
- `cadcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `cadcraft-cli` available on `PATH`.
- `craft-anything` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `craft-anything-cli` available on `PATH`.
- `deckcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `deckcraft-cli` available on `PATH`.
- `designcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `designcraft-cli` available on `PATH`.
- `effectcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `effectcraft-cli` available on `PATH`.
- `figcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `figcraft-cli` available on `PATH`.
- `filmcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `filmcraft-cli` available on `PATH`.
- `gridcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `gridcraft-cli` available on `PATH`.
- `lightcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `lightcraft-cli` available on `PATH`.
- `mailcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `mailcraft-cli` available on `PATH`.
- `materialcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `materialcraft-cli` available on `PATH`.
- `pdfcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `pdfcraft-cli` available on `PATH`.
- `photocraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `photocraft-cli` available on `PATH`.
- `solidcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `solidcraft-cli` available on `PATH`.
- `soundcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `soundcraft-cli` available on `PATH`.
- `texturecraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `texturecraft-cli` available on `PATH`.
- `vectorcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `vectorcraft-cli` available on `PATH`.
- `wordcraft` needs this setup. Disabled by default. To connect, enable this server in the project configuration and make `wordcraft-cli` available on `PATH`.

Verify the resulting connections from Codex before invoking MCP-dependent agents.
