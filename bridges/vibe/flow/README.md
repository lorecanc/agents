# flow

This directory is a generated **Vibe plugin** (Agent Plugins 1.0 with the `ai.mistral.vibe` extension) translated from the canonical OpenCode source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Install

Copy this directory (or let the manager install it) into one of the plugin roots:

- `~/.vibe/plugins/flow/` — user global: available in every session.
- `<project>/.vibe/plugins/flow/` — project scope: available when that trusted folder is open.

New sessions pick the plugin up automatically; a live session needs `/reload-plugins` (or `/reload`). `/plugins` lists it with its components.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

- `plugin.json` — Agent Plugins 1.0 manifest with the `ai.mistral.vibe` extension.
- `skills/` — pack skills plus the translated commands; each is a standard `SKILL.md` named `flow:<skill>` at runtime. User-invocable command skills appear in the slash menu.
- `ai.mistral.vibe/agents/` — one TOML per translated subagent, named `<plugin>:<agent>` at runtime.
- `agent-profiles/` — one TOML per translated primary agent, to install into `~/.vibe/agents/` (the manager does this by default).
- `mcp.json` — MCP servers declared by the plugin.

All agents are also spawnable subagents, named `<plugin>:<agent>` at runtime: ask the model to delegate, or spawn them directly by name. Spawned subagents run with a reduced toolset — file access, session utilities and background processes; no MCP or connector tools, no skill loading, no user questions and no nested delegation — so the main agent gathers MCP- or skill-derived facts itself and passes them in the delegation message.

## Main agent profiles

The plugin format ships spawnable subagents only, and a spawned subagent cannot delegate further. The translated primary agents therefore also ship as main agent profiles: install `agent-profiles/` into `~/.vibe/agents/` (the manager does this by default) and start Vibe with `vibe --agent <profile>` (or switch a live session with `/agent <profile>`).

- **flow-build** (`vibe --agent flow-build`, model: deepseek-v4-1-flash-1017): Main engineering agent of the flow family. Understands the request, explores (in parallel when useful), implements, verifies with tests and the browser, gets an independent review for non-trivial changes, and reports briefly. Does the work itself; uses subagents only for parallel exploration,
- **flow-plan** (`vibe --agent flow-plan`, model: zai-glm-5-3): Plan mode of the flow family, in the same conversation as flow-build (Shift+Tab, /flow-plan, or flow-build calls flow_plan_enter). Read-only. Explores the codebase (flow-explore in parallel), researches when needed, asks the decisive questions, writes a concise plan to .opencode/plans/<slug>.md and

If your `config.toml` sets `enabled_agents`, add the profile names there or they stay hidden. Subagent profiles are rejected as `--agent`, so these main profiles are also the only way to run a specialist at the session level (for example from external tooling).

### Model connection

Every agent follows the Vibe session's model by default: a tier model, a `modelMap` entry or an override pins `active_model` only when the translation config says so, and `inherit` restores the default. Vibe only accepts aliases defined in the `[[models]]` entries of its own configuration and refuses an agent file whose alias is unknown, so align any pinned tier model with the aliases of your Vibe installation. A `plugin.agent.invalid` diagnostic in the startup warnings names any refused agent file.

OpenCode tool names in prompts are rewritten where Vibe has an equivalent (`todowrite` → `todo`, `question` → `ask_user_question`, Task tool → `agents.spawn`, `read` → `read_file`, `write` → `write_file`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply. Commands were translated into user-invocable skills: their `$ARGUMENTS` placeholder became `$request`, and `!`substitutions`` became inline bash blocks.

## MCP setup

`mcp.json` declares the translated servers. `npx` commands are fetched on first use; binaries must already be available on `PATH`.

- `codebase-memory-mcp` — runs `codebase-memory-mcp` (Node.js, npm and network access required for npx).
- `chrome-devtools` — runs `npx -y chrome-devtools-mcp@latest --executable-path={browser} --headless --no-usage-statistics` (Node.js, npm and network access required for npx).
- `XcodeBuildMCP` — runs `npx -y xcodebuildmcp@latest mcp` (Node.js, npm and network access required for npx).
- `shadcn` — runs `npx -y shadcn@latest mcp` (Node.js, npm and network access required for npx).
- `cupertino` — runs `cupertino serve` (Node.js, npm and network access required for npx).
- `axiom` — runs `npx -y axiom-mcp` (Node.js, npm and network access required for npx).
- `cwe-search` — runs `npx -y @cyanheads/mitre-cwe-mcp-server@0.3.0` (Node.js, npm and network access required for npx).
- `bigquery` — remote endpoint `https://bigquery.googleapis.com/mcp`; check network and authentication access.
- `cloud-logging` — remote endpoint `https://logging.googleapis.com/mcp`; check network and authentication access.
- `cloud-monitoring` — remote endpoint `https://monitoring.googleapis.com/mcp`; check network and authentication access.

The plugin carries these servers as-is. Authenticated remote servers (and `{env:VAR}` headers) cannot be expressed in a plugin's static mcp.json: install them at the Vibe config level instead, for example `vibe mcp add <name> --url <url> --api-key-env <VAR>`, or via OAuth.

Commands may carry the `{browser}` placeholder: the manager's installer resolves it to this machine's browser (Chromium preferred over Chrome) and drops the argument when none is installed.

Platform-gated servers (`XcodeBuildMCP`: darwin, `cupertino`: darwin) are recorded in `mcp-platforms.json`: the manager's installer keeps them only on matching machines, because a plugin's mcp.json cannot express conditions.

In a session, run `/mcp` (or `/mcp status`) to verify every server is connected.

## OpenCode plugins and tools

These OpenCode companions ship with the bridged packs but have no Vibe equivalent (Vibe loads skills, agents, hooks and MCP servers only). Replace custom tools with a skill when the agents need that behavior:

- Plugin: `plugins/dev-tools`
- Plugin: `plugins/flow-context`
- Plugin: `plugins/flow-guard`
- Plugin: `plugins/flow-mode`
- Tool: `tools/dev-tools/dev_env.ts`
- Tool: `tools/dev-tools/dev_serve.ts`
- Tool: `tools/dev-tools/dev_smoke.ts`
- Tool: `tools/dev-tools/dev_verify.ts`

## Per-agent bash allowlists (not enforced)

Vibe agent files narrow tool use with `[tools.<name>] permission = "ask" | "never"` only; there is no per-command allowlist. The bridge emits `permission = "never"` for the tools an OpenCode agent denies and lets everything else follow the session's approval policy. The source rules are listed here so they can be reviewed or copied into the Vibe config `[tools.bash]` allowlist/denylist entries.

<details><summary>build (9 rules)</summary>

- ask: `git push*`, `* publish*`, `docker push*`, `kubectl *`, `terraform *`, `gcloud *`, `aws *`, `rm -r*`
- deny: `sudo *`

</details>

<details><summary>explore (3 rules)</summary>

- deny: `git push*`, `rm *`, `sudo *`

</details>

<details><summary>ops (14 rules)</summary>

- ask: `* deploy*`, `* apply*`, `* delete*`, `* destroy*`, `* rollout*`, `* scale*`, `git push*`, `docker push*`, `ssh *`, `psql *`, `mysql *`, `rm *`
- deny: `printenv*`, `sudo *`

</details>

<details><summary>plan (3 rules)</summary>

- deny: `git push*`, `rm *`, `sudo *`

</details>

<details><summary>review (3 rules)</summary>

- deny: `git push*`, `rm *`, `sudo *`

</details>

## Agents

- **build** (spawn as `flow:build`, safety `neutral`, model: deepseek-v4-1-flash-1017): Main engineering agent of the flow family. Understands the request, explores (in parallel when useful), implements, verifies with tests and the browser, gets an independent review for non-trivial changes, and reports briefly. Does the work itself; uses subagents only for parallel exploration,
- **explore** (spawn as `flow:explore`, safety `neutral`, model: deepseek-v4-1-flash-1017): Fast read-only codebase explorer for the flow family. Answers one narrow question (where is X, how does Y work, who calls Z, which tests cover W) with file:line conclusions, not file dumps. Designed to run several instances in parallel.
- **eye** (spawn as `flow:eye`, safety `safe`, model: deepseek-v4-1-flash-1017): Visual reviewer for the flow family. Captures a small batch of screenshots at the requested viewports or reads existing captures. Judges them against the brief and returns concrete fixes in text only. Needs an image-capable model. Does not edit files.
- **ops** (spawn as `flow:ops`, safety `neutral`, model: deepseek-v4-1-flash-1017): Operational agent for the flow family. Inspects logs, services, containers and cloud resources, verifies a change at runtime (start the service, hit endpoints, read logs), and performs deploys only when the user explicitly asked. Does not edit repository files.
- **plan** (spawn as `flow:plan`, safety `neutral`, model: zai-glm-5-3): Plan mode of the flow family, in the same conversation as flow-build (Shift+Tab, /flow-plan, or flow-build calls flow_plan_enter). Read-only. Explores the codebase (flow-explore in parallel), researches when needed, asks the decisive questions, writes a concise plan to .opencode/plans/<slug>.md and
- **research** (spawn as `flow:research`, safety `safe`, model: deepseek-v4-1-flash-1017): External research agent for the flow family. Looks up library documentation, API signatures, versions, migration guides, known issues, advisories and best practices on the web and returns sourced, version-aware findings. Does not edit files.
- **review** (spawn as `flow:review`, safety `neutral`, model: zai-glm-5-3): Read-only code reviewer for the flow family. Reviews the current change set with a given focus (correctness+security, or quality - reuse, duplication, complexity, consistency) and returns verified, ranked findings with file:line, a concrete failure scenario and a fix. Does not edit files.

## Translation warnings

- [model-map] entry "opencode-go/deepseek-v4.1-flash" matches no source agent model
- [mcp] disabled server 'XcodeBuildMCP' was emitted because translated agents require it
- [mcp] disabled server 'cupertino' was emitted because translated agents require it
- [mcp] disabled server 'bigquery' was emitted because translated agents require it
- [mcp] omitted disabled server 'cloud-run'; add it to mcp.json if the translated agents need it
- [mcp] disabled server 'cloud-logging' was emitted because translated agents require it
- [mcp] disabled server 'cloud-monitoring' was emitted because translated agents require it
- [mcp] omitted disabled server 'cloud-sql'; add it to mcp.json if the translated agents need it
- [mcp] omitted disabled server 'cloud-storage'; add it to mcp.json if the translated agents need it
- [mcp] omitted disabled server 'cloud-cli'; add it to mcp.json if the translated agents need it
- flow-build.md: unresolved delegated agent 'general'
- flow-build.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- flow-build.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-build.md: permission 'question' has no per-agent Vibe equivalent; dropped
- flow-build.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- flow-build.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-build.md: description is 349 characters; truncated to fit the Vibe agent profile (max 300)
- flow-build.md: OpenCode mode 'primary' emitted as spawnable subagent 'flow:build' and as main agent profile 'flow-build' (run it with 'vibe --agent flow-build'; a spawned subagent cannot delegate further)
- flow-build.md: 'steps' has no per-agent Vibe equivalent; ignored
- flow-explore.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- flow-explore.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-explore.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-explore.md: 'steps' has no per-agent Vibe equivalent; ignored
- flow-eye.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- flow-eye.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-eye.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-eye.md: 'steps' has no per-agent Vibe equivalent; ignored
- flow-ops.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-ops.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- flow-ops.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-ops.md: 'steps' has no per-agent Vibe equivalent; ignored
- flow-plan.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- flow-plan.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-plan.md: permission 'question' has no per-agent Vibe equivalent; dropped
- flow-plan.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- flow-plan.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-plan.md: description is 383 characters; truncated to fit the Vibe agent profile (max 300)
- flow-plan.md: OpenCode mode 'primary' emitted as spawnable subagent 'flow:plan' and as main agent profile 'flow-plan' (run it with 'vibe --agent flow-plan'; a spawned subagent cannot delegate further)
- flow-plan.md: 'steps' has no per-agent Vibe equivalent; ignored
- flow-research.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-research.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- flow-research.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-research.md: references MCP server(s) cupertino, axiom, shadcn; spawned Vibe subagents have no MCP or connector tools, so the main agent must gather those facts and pass them in the delegation message
- flow-research.md: 'steps' has no per-agent Vibe equivalent; ignored
- flow-review.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- flow-review.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- flow-review.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- flow-review.md: 'steps' has no per-agent Vibe equivalent; ignored
- OpenCode plugin 'plugins/dev-tools' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/flow-context' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/flow-guard' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/flow-mode' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_env.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_serve.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_smoke.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_verify.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- [commands] 'flow-bug': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-commit': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-design': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-explain': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-feature': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-plan': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-review': converted 0 !-substitution(s) to inline instructions
- [commands] 'flow-simplify': converted 0 !-substitution(s) to inline instructions
- Skill 'skills/flow-commit' collides with an already exported skill 'flow-commit'; the command skill wins
- Skill 'skills/flow-simplify' collides with an already exported skill 'flow-simplify'; the command skill wins
