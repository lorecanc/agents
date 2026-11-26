# flow

This directory is a generated translation layer from the canonical source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

## Run in Codex

From this directory, run `codex` and trust the project to load its local configuration, or open this directory in the Codex app.
Ask Codex to delegate the task to the `build` subagent.

- `.codex/agents/` contains project-scoped subagent definitions.
- `.codex/config.toml` configures MCP for the project. Run `codex mcp list` here to inspect it.
- `.agents/skills/` contains the pack skills, their supporting files and any translated agent prompts.

## Install the plugin separately

To use the plugin's packaged skills or MCP servers in other projects, run these commands from this directory:

```sh
codex plugin marketplace add .
codex plugin add flow@flow-local
```

Custom subagents are project-scoped. To use them in another project, copy the relevant TOML files from `.codex/agents/` into that project's `.codex/agents/`.

OpenCode tool names in prompts are translated where Codex has an equivalent (`todowrite` → `update_plan`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply.

## MCP setup

`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.

- `codebase-memory-mcp` needs this setup. Make `codebase-memory-mcp` available on `PATH`.
- `chrome-devtools` needs this setup. Runs as `npx -y chrome-devtools-mcp@latest --headless --no-usage-statistics` (Node.js, npm, and network required).
- `XcodeBuildMCP` needs this setup. Runs as `npx -y xcodebuildmcp@latest mcp` (Node.js, npm, and network required).
- `shadcn` needs this setup. Runs as `npx -y shadcn@latest mcp` (Node.js, npm, and network required).
- `cupertino` needs this setup. Make `cupertino` available on `PATH`.
- `axiom` needs this setup. Runs as `npx -y axiom-mcp` (Node.js, npm, and network required).
- `cwe-search` needs this setup. Runs as `npx -y @cyanheads/mitre-cwe-mcp-server@0.3.0` (Node.js, npm, and network required).
- `bigquery` needs this setup. Verify connectivity and authentication for `https://bigquery.googleapis.com/mcp`.
- `cloud-run` needs this setup. Disabled by default. To connect, enable this server in the project configuration and verify connectivity and authentication for `https://run.googleapis.com/mcp`.
- `cloud-logging` needs this setup. Verify connectivity and authentication for `https://logging.googleapis.com/mcp`.
- `cloud-monitoring` needs this setup. Verify connectivity and authentication for `https://monitoring.googleapis.com/mcp`.
- `cloud-sql` needs this setup. Disabled by default. To connect, enable this server in the project configuration and verify connectivity and authentication for `https://sqladmin.googleapis.com/mcp`.
- `cloud-storage` needs this setup. Disabled by default. To connect, enable this server in the project configuration and verify connectivity and authentication for `https://storage.googleapis.com/storage/mcp`.
- `cloud-cli` needs this setup. Disabled by default. To connect, enable this server in the project configuration and verify connectivity and authentication for `https://cloudcli.googleapis.com/mcp`.

Verify the resulting connections from Codex before invoking MCP-dependent agents.

## Per-agent bash allowlists (not enforced)

Codex agent files set only `sandbox_mode`: agents whose OpenCode `bash` or `edit` permission allows anything get `workspace-write`, the others `read-only`. Codex has no per-agent command allowlist; command rules are global. The source rules are listed here for review.

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

## Translation warnings

- [mcp] tool denies for 'codebase-memory-mcp' apply to the entire Codex session
- [mcp] 'chrome-devtools': dropped the {browser} argument; the Codex project runs the server with its own browser detection
- [mcp] tool denies for 'chrome-devtools' apply to the entire Codex session
- [mcp] disabled server 'XcodeBuildMCP' was emitted because translated agents require it
- [mcp] disabled server 'cupertino' was emitted because translated agents require it
- [mcp] disabled server 'bigquery' was emitted because translated agents require it
- [mcp] disabled server 'cloud-logging' was emitted because translated agents require it
- [mcp] disabled server 'cloud-monitoring' was emitted because translated agents require it
- flow-build.md: unresolved delegated agent 'general'
- [flow-eye.md] model assignment source: default
- [flow-ops.md] model assignment source: default
