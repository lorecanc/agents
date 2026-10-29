# Agent Manager

## OpenCode V2 Compatibility

This manager is compatible with both OpenCode V1 and V2. The following V2 changes are handled transparently:

- **Frontmatter fields**: V2 renames `max_steps` → `steps`, `disable` → `disabled`, `prompt` → `system`, and moves `temperature`/`top_p` under `request.body`. The manager auto-detects and normalizes both formats.
- **Permissions**: V2 uses a `permissions` array (`[{action, resource, effect}]`) instead of V1's `permission` object. Both formats are supported.
- **Model variants**: V2 joins `variant` to the model reference with `#` (e.g., `provider/model#variant`). The manager handles both separate and joined formats.
- **Agent directories**: V2 discovers agents in `agents/`, `agent/`, `mode/`, and `modes/` directories. Agents in `mode/` or `modes/` are treated as primary agents.
- **Config format**: V2 uses `agents` (plural) instead of `agent`, `commands` instead of `command`, and `subagent` instead of `subtask`. The manager translates between formats.
- **CLI commands**: The `opencode models --refresh` flag was removed in V2. The manager now uses `opencode models` without the flag.

All existing V1 agent files continue to work without modification. New V2 fields are also accepted.

## Auto-commit semantics

Enabled auto-commit is best-effort. Git preflight, staging, commit, or publish failures return the mutation value with a warning and recovery guidance; invalid plans and mutation failures remain blocking errors.

Standalone Node/Bun terminal manager and OpenTUI application for the repository's `/src`, `/export`, and `/.agent-manager` layout. It is the supported interface for category generation, bridge translation, catalog maintenance, and safe repository mutations.

[Guida pratica in italiano](GUIDA.md)

## Purpose and architecture

The repository has four root-level areas: `/src` contains canonical sources (`agents/` with the prefixless `pipeline-*` base pipeline and `docs-*`, `slides-*`, and `wiki-*` agents, plus `commands/`, `plugins/`, `skills/`, `tools/`, `bench/`, `bin/`, and `opencode.json`); `/export` contains generated category distributions (`categories/docs`, `slides`, and `wiki`), stamped `hybrid-pipeline`, `go-pipeline`, `mistral-pipeline`, `collector-pipeline`, `free-pipeline`, `copilot-pipeline`, and `cp_nightly-pipeline` provider pipelines, and `bridges/` for Claude Code and Codex; `/.agent-manager` contains `pipeline-profiles.json`, `companion-links.json`, `translation-config.json`, and `categories/*.json`; `/manage-agents` contains this CLI and interactive TUI.

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
* `bridge --category <name> [--target claude|codex] [--output path] [--name name] [--prefix prefix] [--source-dir dir] [--config path] [--model source=target]... [--map-all target] [--no-register] [--no-validate] [--marketplace-name name] [--wizard]` — generate translation layers and manifests.
* `export [--all|--category name]` — export agents and matching domain resources to OpenCode with disaster-recovery backups.
* `lint` — inspect naming convention compliance; `fix-names [--dry-run]` repairs names and references.
* `audit` — audit permission ordering and risk.
* `import [--dry-run]` — import agents and companion resources from the OpenCode configuration.
* `tune [--steps n] [--temp n] [--variant name|--effort name] [--clear-variant|--clear-effort] [--category name]` — update model parameters.
* `pipeline sync-bash [--dry-run]` — rewrite the `permission.bash` rule blocks of `src/agents/pipeline-*.md` from `.agent-manager/bash-profiles.json`, changing nothing else in the files (agents whose role has no profile, such as `bash: deny` roles, are skipped). Then run `category build --all` to refresh stamped pipelines.
* `sync status --target <repo> [--from <source-or-bundle>] [--component all|agent-manager|pipeline-core] [--check] [--json]` — compare shared component versions, compatibility, file drift, and dirty target files; `--check` exits non-zero for incompatibility, local changes, or drift.
* `sync release --out <dir> [--component all|agent-manager|pipeline-core] [--json]` — create a versioned release bundle with `release-index.json` and SHA-256 content digest.
* `sync apply --target <repo> [--from <source-or-bundle>] [--component all|agent-manager|pipeline-core] [--dry-run] [--force] [--no-refresh] [--json]` — preview or apply shared files, preserving local overlays and never creating an automatic Git commit. `shared-sync` aliases `sync`; `diff`, `export`, and `import` alias `status`, `release`, and `apply`.
* `category list` — list category manifests.
* `category build <id|--all>`, `category check <id|--all>`, `category status <id|--all>`, `category explain <id|--all>` — build, verify, or inspect v2 distributions. Stamped `*-pipeline` bundles have no manifest: `build --all` (or `build <name>-pipeline`) refreshes them from the canonical pipeline, and `check --all` (or `check <name>-pipeline`) fails when the canonical pipeline or a stamped bundle does not ship a `pipeline_*` tool an agent permits, a helper module a pipeline tool or the guard plugin imports, or a byte-identical copy of the canonical pipeline tools and plugin. Stamped directories with companions but no agents are reported as warnings (nothing installs them). `check` also reports, with a short diff, any canonical or stamped pipeline agent whose bash block differs from its profile expansion.
* `category package <id|--all> --output artifacts/categories [--dry-run]` — validate and copy current distributions into a repository-local artifact directory.
* `topic-export wiki [--check]` — deprecated alias forwarding to the category commands.

All commands support focused `--help` where implemented. Manifest-backed category output is under `export/categories/`; it includes a README, exact MIT `LICENSE`, AGENTS, category metadata, and provenance hashes. `src/` is the source of truth; resources are selected through manifests and dependencies, not merely by filename.

`import --dry-run` previews agent and companion-resource changes without modifying files or creating backups. The effective import applies only changed/new agents and modified resources from `tools/`, `commands/`, `skills/`, and `plugins/`; identical files are skipped and no backup is created when there are no differences.

Shared releases are defined by `.agent-manager/shared-sync.json`: it versions the `agentManager` and `pipelineCore` components, declares pipeline-to-manager compatibility, and protects repository-local overlays. Check the target with `sync status` before applying; incompatible versions and locally modified shared target files block an apply unless the changes are deliberately overridden with `--force`.

`bridge` maps source models per target. `--model <source>=<target>` is repeatable and accepts comma-separated lists; `--map-all <target>` is shorthand for `--model "*=<target>"`. As `bridge --help` states: `Map a source model to a target model; repeatable and accepts comma lists` and `Shorthand for --model "*=<target>": use one model for every source`. Keys match an agent's source model as a full lowercase ID (`zai-glm-5-3`) or as the bare ID after the last `/` (`glm-5-3`), with `"*"` as the catch-all. Resolution order is per-agent overrides, then `modelMap` (full ID, bare ID, `"*"`), then the role tier, then inference, then `defaultTier`; an empty map keeps the previous tier behavior. Keys that match no agent in the bridge are reported with a target-specific message: `[model-map] entry "<key>" matches no source agent model in this bridge` for Claude and `[model-map] entry "<key>" matches no source agent model` for Codex.

Mappings passed on the command line are persisted to the translation config for the selected target and replayed by later runs without flags, so they win over keys already in the file. No CLI flag removes a persisted catch-all: clear it with the TUI bridge field or by editing `.agent-manager/translation-config.json`. Claude targets must be `fable`, `sonnet`, `opus`, `haiku`, `inherit`, or a full `claude-*` ID (for example `claude-opus-5-5`); any other value is rejected on save with `Invalid Claude model "<value>". Use an alias (fable, sonnet, opus, haiku, inherit) or a full claude-* model ID.`, prefixed by `claude.modelMap["<source>"]:`. Codex targets only need to be non-empty strings, and a Codex model-map entry emits the target model without a reasoning effort.

A Claude bridge is self-hosting. Alongside `.claude-plugin/plugin.json` it emits `.claude-plugin/marketplace.json` (`{name, description, owner, plugins: [{name, source: "."}]}`), a local marketplace that publishes the plugin from the output directory itself. Each linked pipeline command (`src/commands/pipeline-*.md`) becomes `skills/<name>/SKILL.md`: the source `description` is kept, `disable-model-invocation: true` and `arguments: request` are set, `$ARGUMENTS` becomes `$request`, `` !`cmd` `` lines become fenced bash blocks, and the body delegates to the plugin orchestrator. Companion skills such as `code-review-antipatterns` are copied under `skills/`.

Each run prunes generated artifacts that are not in its expected set (agents and skills, plus `marketplace.json` when marketplace emission is off) and warns per removed file. It also warns when a disabled MCP server is still emitted because translated agents require its tools. `.lsp.json` documents the project LSP setup and is not read by `claude plugin validate`. When `manage-agents/assets/plugin-icon.png` exists, the bridge copies it to `.claude-plugin/icon.png`; replace that file to change the plugin icon.

`--no-register`, `--no-validate`, and `--marketplace-name <name>` control the post-generation steps and the marketplace name only; marketplace emission itself is controlled solely by `claude.emitMarketplace` in the JSON, which no CLI flag changes. These flags persist to `claude` in the translation config exactly like `--model`/`--map-all`, so later runs reuse them without flags. The same settings live in `claude.emitMarketplace`, `claude.emitCommands`, `claude.emitSkills`, `claude.autoValidate`, `claude.autoRegister` (these five fields are optional and default to `true`) and `claude.marketplaceName` (optional; default `<pluginName>-local`; charset `[A-Za-z0-9][A-Za-z0-9._-]*`; names equal to `claude` or `claude-code` and the `claude-`, `anthropic-`, and `anthropics-` prefixes are rejected). No flag turns a disabled step back on: edit the JSON.

After the repository transaction closes, `autoValidate` runs `claude plugin validate <outputDir> --strict` (exit 0 pass, 1 fail, 2 CLI error); a failure or an undecided CLI error skips registration. `autoRegister` then runs `claude plugin marketplace add <outputDir>` followed by `claude plugin install <pluginName>@<marketplaceName>`; both are user-scope, idempotent, and prompt-free for local sources. Registration is also skipped when `claude.emitMarketplace` is off, because there is no marketplace manifest to add. When `claude` is not on PATH both steps are skipped with warnings and generation still succeeds. Registration is once-ever: local marketplaces load in place, so no update command is needed after regeneration, and the refreshed plugin is available in the next session or after `/reload-plugins`. Invoke agents as `claude --plugin-dir <dir> --agent <plugin>:<name>` or `@agent-<plugin>:<name>`, and skills as `/<plugin>:<skill>`.

## TUI keymap

Use arrows or `j/k`, `Tab` for list/tree, `/` search, `Space` select, `a` all/category, `s` same model, `m` model, `Shift-T` tier, `t` parameters, `c` color, `p` permission preset, `g` delegations, `u` Skills, Tools & MCP Manager, `r` rename, `o` organize, `f` fork, `b` Claude bridge, `Shift-B` Codex bridge, `e` export, `i` import diff, `1–5` inspector tabs, `Shift-L` layout, `F` fix permission order, `PageUp/PageDown` scroll, and `Esc` close modals. In the layout modal, arrows/`h/l` adjust the split, `Home`/`End` select bounds, `R` resets, `Enter` saves, and `Esc` cancels. Modals support prompts, model/provider trees, tier assignment, color palettes, delegation toggles, resource permissions, import diffs, bridge configuration, confirmation dialogs, and action-result scrolling.

The Claude and Codex bridge modals (`b`/`Shift-B`) have four fields: plugin name, prefix, source directory, and `Map all models to`; `Tab` cycles through them in that order. The model field sets the `"*"` catch-all for the selected target: empty keeps tier mapping, and emptying a value that was persisted deletes the catch-all. For the Claude target the value must pass the alias validation above; for Codex it is saved as a non-empty model ID. Per-model editing happens in `.agent-manager/translation-config.json`.

Inspector tabs `1–5` are Info (Overview), Name, Sec, Graph, and `Res` (Skills & Tools). Tab `1` displays the focused agent’s configured Thinking / Effort (`variant`) and any provider pass-through `reasoningEffort` option. OpenCode maps an agent’s `variant` to the selected model’s provider variant configuration. Tab `5` shows the focused agent’s authorized Skills (`permission.skill`, including `*` wildcard and dead-reference detection), custom tools from `src/tools/*.ts` (including families such as `slide_*` and `doc_*`), MCP servers/namespaces and their enabled status from `src/opencode.json` alongside agent permissions (`<server>_*`), and domain companion files under `tools/`, `commands/`, `skills/`, and `plugins/`. The inspector scrolls with `Up/Down` (`j/k`) and `PageUp/PageDown`.

Press `t` to open Parameter Tuning. Along with `steps`, `temperature`, `mode`, and `hidden`, it lets you set Thinking / Effort (`variant`). In that field, `Space` or `←`/`→` cycles through OpenCode’s standard variants (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and unset/default; you can also type a custom variant name (for example, `thinking`) and press `Backspace` to clear it. The available variants depend on the provider/model; OpenCode documents Anthropic `high`/`max`, OpenAI `none`/`minimal`/`low`/`medium`/`high`/`xhigh`, and Google `low`/`high`. Custom variants can be configured for a model. See the official [agent configuration](https://opencode.ai/docs/agents/#additional) and [model variants](https://opencode.ai/docs/models/#variants) documentation.

The CLI `tune` command accepts `--variant <name>` (alias `--effort <name>`) to set the variant, or `--clear-variant` (alias `--clear-effort`) to unset it. For example: `./manage-agents.sh tune --effort high --category copilot`.

Press `u` on a focused agent to open the **Skills, Tools & MCP Manager** checklist. `Space` toggles the agent’s `allow`/`deny` permission for a skill (or `* (All Skills)`), tool family (such as `slide_*` or `doc_*`), individual tool, or MCP server (`<server>_*`). On a configured MCP server, `x` toggles its workspace-wide `enabled` flag in `src/opencode.json`, independently of agent permissions; restart OpenCode for changes to that file to take effect at runtime. `Enter` atomically saves all draft changes, rolling back if any write fails, and creates a repository checkpoint when auto-commit is enabled. `Esc` discards the draft without modifying files.

The TUI list/inspector split can be adjusted without writing to the repository. Create `.agent-manager/ui-config.json` with `{ "version": 1, "listShare": 0.6667 }`; values from `0.60` through `0.75` are accepted. Set `AGENT_MANAGER_UI_CONFIG` to use an external read-only config instead. Missing or invalid configuration uses the default two-thirds list share.

Workspace saves use a SHA-256 revision and an exclusive `.agent-manager/ui-config.lock` to protect cooperating manager instances. Malformed files retain a revision, while missing files use the `missing` sentinel. This is practical cooperating-writer safety: portable Node cannot fully protect against an active same-user attacker swapping paths during the operation. Environment overrides remain read-only.

The TUI fork prompt accepts comma-separated replacements, such as `go-, kimi-, hybrid-, free-`; bracketed batch syntax, such as `[go-, kimi-, hybrid-, free-]`, remains compatible. An empty whole replacement removes the find string. List members must be non-empty and unique; empty or duplicate entries are invalid. A batch performs one complete preflight and creates at most one backup.

## Workflows and generated output

Edit canonical files under `src/` and configuration under `.agent-manager/`, then use `category build` or `bridge` to regenerate outputs. `category check` is read-only. Generated directories must not be edited directly; their README, category metadata, provenance hashes, and bridge warnings are produced by the manager.

## Backups, bridges, and safety

OpenCode agent exports back up to `$XDG_CONFIG_HOME/opencode/agents_backup/` (or `~/.config/opencode/agents_backup/` when XDG is unset); organize/fork operations use `backups/` (ignored). Bridges are written to `export/bridges/claude-code/` or `export/bridges/codex/`, or to an explicit output directory that stays inside the workspace. Repository mutations auto-commit only after a clean-worktree, identity, branch, lock, symlink, and scope check. Commits are local, unsigned, hook-free, and scoped. Normal Git worktree races remain possible, but selected paths are fingerprinted after mutation and verified immediately before commit; committed blobs and modes are verified afterward. Use `--no-auto-commit` or `AGENT_MANAGER_AUTO_COMMIT=0`; failures leave changes for manual recovery and do not reset user work. Topic `--check` always bypasses transactions. Temporary staging/backup siblings are never staged. Claude bridge validation and registration run after the transaction closes, so a missing `claude` CLI or a failed validation does not affect the generated output.

Global export uses `$XDG_CONFIG_HOME/opencode` when set, otherwise `~/.config/opencode`. For each successfully exported agent, companion resources from `tools/`, `commands/`, `skills/`, and `plugins/` of the agent's bundle (`src/`, or `export/categories/<name>-pipeline/` for stamped pipelines) are installed under the same relative path in that directory, so `plugins/` and `tools/` stay siblings. Resources are selected from the matching `.agent-manager/categories/<domain>.json` manifest when present, domain-prefixed directories and top-level files (`<domain>` or `<domain>-*`), tool families named `<domain>_*.ts` (every `tools/pipeline_*.ts` for pipeline agents, including tools no agent permits yet), the tools and skills each agent's permissions name, and companion links; relative imports of the selected tools and plugins (`_pipeline_*.js`, `_paths.js`, `_safeName.js`, `_python.js`, ...) are traced and added. Tests (`*.test.*`), `_pipeline_testutil.mjs`, `.d.ts`, and README files under `tools/`/`plugins/` are never installed. Pipeline agents therefore install `plugins/pipeline-guard.js` and all pipeline tools with their helpers. Identical resource files (content and permissions) are skipped without writes or backups. Before replacing changed files, only the resource files being overwritten are saved in a separate `resource_export_backup_<timestamp>_<suffix>/` directory under the OpenCode configuration root; the 5 most recent such directories are retained automatically. If resource installation fails, both companion resources and agents exported in that operation are rolled back.

Pipeline bash allowlists have one source of truth: `.agent-manager/bash-profiles.json` defines named, ordered rule blocks (`profiles`) and, per role, the ordered list of blocks that expands to that agent's `permission.bash` (`roles`). OpenCode applies the last matching rule, so expansion keeps the exact order. Edit the profiles, run `pipeline sync-bash`, then `category build --all`; refreshing a stamped pipeline replaces its `bash`/`shell` block with the canonical one instead of merging stale rules. `src/utils/bashProfiles.test.ts` checks that the canonical agents equal their expansion, evaluates per-role fixtures with an OpenCode-like matcher, and scans prompt bodies for backticked commands the agent's own allowlist would deny.

`import --dry-run` previews agent and companion-resource changes without modifying files or creating backups. `import` from the CLI or TUI imports only changed/new agents and modified companion resources (`tools/`, `commands/`, `skills/`, and `plugins/`) back into `src/`; identical files are skipped, and no backup is created when there are no differences. For `hybrid`, the companion-resource set includes `pipeline_*.ts`, `_pipeline_*.js`, `skills/code-review-antipatterns`, and `plugins/pipeline-guard.js`.

Bridge permission translation is tool-level. OpenCode keys map to Claude tool names (`bash`/`shell` → `Bash`, `edit` → `Write` and `Edit`, `read`/`grep`/`glob` → `Read`/`Grep`/`Glob`, `task` → `Agent`, `webfetch` → `WebFetch`, `websearch` → `WebSearch`, `skill` → `Skill`, `lsp` → `LSP`, `question` → `AskUserQuestion`, `todowrite` → `TodoWrite`, MCP keys → `mcp__<server>__*` plus the plugin-scoped form). Granular OpenCode patterns (bash pattern lists, edit globs, webfetch URL globs, ask states) cannot be enforced per agent in a Claude Code plugin: plugin agents ignore `permissionMode` and hooks, and granular allow/ask/deny rules exist only in settings the plugin cannot carry. The bridge emits the tool-level decision, warns about each granular pattern rule, dropped built-in or custom key, and promoted ask state it cannot represent, and generates no `hooks/hooks.json`.

The generated README documents what the bridge does not translate. Companion links for the category (for pipeline, `plugins/pipeline-guard.js` and the pipeline tools) are listed under `OpenCode plugins and tools` with their nearest Claude equivalents: `tool.execute.before` → `PreToolUse`, `tool.execute.after` → `PostToolUse`, `session.idle` → `Stop`, `permission.asked` → `PermissionRequest`, and custom tools point to an MCP server. Each untranspiled plugin or tool also produces a warning.

Prompt bodies are adapted from a data table in `src/utils/bridgeToolReferences.ts`. For Claude, OpenCode tool names are rewritten (`todowrite` → `TodoWrite`, `` `question` `` → `` `AskUserQuestion` ``, `` `task` `` and "Task tool/call" → `Agent`, backticked `read`/`grep`/`glob`/`lsp`/`skill`/`webfetch`/`websearch`/`bash`/`edit`/`write` → their Claude names); for Codex, `todowrite` → `update_plan`, with guidance for `question`, the Task tool, file tools, and edits. OpenCode-only tools (`pipeline_state`, `pipeline_commit`, `pipeline_verify`, `pipeline_smoke`, `pipeline_serve`, `pipeline_env`, and any other `pipeline_*` key or mention) are never deleted from the text: one `Runtime note (OpenCode bridge)` blockquote is inserted after the leading H1 saying they are unavailable and that the prompt's documented fallbacks apply. `pipeline_*` permission keys are never mistaken for MCP servers. Per-agent bash/shell pattern rules cannot be expressed by Claude plugin agents (`tools:` only) or Codex agents (`sandbox_mode` only); each generated README lists them under `Per-agent bash allowlists (not enforced)`.

Its `Model connection` section explains that the bridge emits family aliases (`sonnet`, `opus`, `haiku`, `fable`, `inherit`) unless a full `claude-*` ID is pinned in `claude.modelMap`, a tier's `claude.model`, or a per-agent `claude.overrides` entry. Aliases resolve per connection mode: subscription OAuth via `/login` needs no extra configuration, while API key, Bedrock, and Vertex connections resolve according to the provider configuration. `fable` requires Claude Code CLI v2.1.257 or newer.

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

Troubleshooting: configure `git config user.name` and `user.email` for auto-commit; clean unrelated work before mutations; remove a stale `agent-manager.lock` only after confirming no manager is running; never use symlinks in managed scopes; ensure `git` is on PATH; ensure the `claude` CLI is on PATH for automatic Claude bridge validation and registration (generation still succeeds without it); on Windows invoke quoted paths with PowerShell’s `&` operator and use Node/Bun rather than the Unix launcher.

## License

MIT. Third-party dependencies and services retain their own terms; see the repository root `LICENSE`.
