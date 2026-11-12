# manage-agents

Install, edit and route OpenCode agents distributed as **packs**.

A pack is a directory laid out like an OpenCode config directory (`agents/`, `commands/`, `skills/`, `plugins/`,
`tools/<pack>/`, `opencode.json`) plus an `opencode-pack.json` manifest. Packs come from **sources**: local
directories or git repositories, any number of them. manage-agents resolves the packs you ask for and the packs they
require, copies them into an OpenCode config directory, merges their `opencode.json` entries into yours, and keeps
track of what it owns so it can update or remove it later. It also edits agents (models, permissions, skills,
delegations, parameters), generates the model routing of archetype packs, and translates packs into Claude Code
plugins and Codex layers.

The engine and the packs are independent: the engine knows nothing about a particular catalog, and a catalog needs
nothing from the engine beyond the contract.

- Pack contract (what a pack may contain, how it is installed): [`contract/CONTRACT.md`](contract/CONTRACT.md),
  JSON Schema [`contract/opencode-pack.schema.json`](contract/opencode-pack.schema.json), example
  [`contract/examples/minimal-pack`](contract/examples/minimal-pack).
- Skill for agents that write packs: [`contract/skills/opencode-pack-authoring`](contract/skills/opencode-pack-authoring/SKILL.md).
- [Guida pratica in italiano](GUIDA.md).

## Requirements and installation

Node.js `>=26.4.0` or Bun `>=1.3.0` (OpenTUI uses FFI; the launcher re-executes Node with `--experimental-ffi`).

```bash
git clone <engine-repo> manage-agents && cd manage-agents
npm ci            # or: bun install
npm link          # optional: puts `manage-agents` on PATH
```

Run it with `manage-agents`, `node manage-agents.mjs` or `bun manage-agents.mjs`. The launcher rebuilds `dist/` when
the sources are newer.

## Quick start

```bash
manage-agents source add catalog https://github.com/<you>/agents.git   # or a local directory
manage-agents source pull                                              # clone/fetch git sources
manage-agents install flow pipeline                                    # into $XDG_CONFIG_HOME/opencode
manage-agents status                                                   # "In sync." when nothing drifted
manage-agents update                                                   # pull and move to the new versions
```

To edit a catalog, open the TUI in it: `cd agents && manage-agents` (or `manage-agents --workspace <dir>`).

## Concepts

- **Source**: a directory or git repository holding packs (`packs/<name>/opencode-pack.json`, or packs at any depth).
  Registered in `$XDG_CONFIG_HOME/manage-agents/sources.json`; git checkouts live in
  `$XDG_CACHE_HOME/manage-agents/sources/<name>` and are never edited.
- **Target**: an OpenCode config directory, by default `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode`). Its
  state is in `<target>/.manage-agents/`: `desired.json` (what you asked for), `lock.json` (exact resolution:
  source, version, revision, hashes) and `installed.json` (files and config entries the engine owns).
- **Workspace**: the catalog (a directory with `packs/<name>/opencode-pack.json`) or the single pack that the TUI and
  the agent commands (`create`, `lint`, `fix-names`, `audit`, `tune`, `bridge`) edit. It is `--workspace <dir>`,
  `$MANAGE_AGENTS_WORKSPACE`, or the nearest catalog or pack above the current directory.
- **Archetype pack**: a pack whose primary agents (`archetype.callers`) delegate to its subagents, with
  `routingDefaults` that pick the subagents' models from the caller's model. The engine installs its own router
  plugin, `plugins/manage-agents-router`, and generates its `routing.json` at every reconcile.
- **User settings**: `$XDG_CONFIG_HOME/manage-agents/routing.json` (model routing) and `overrides.json` (frontmatter
  patches) apply at reconcile, globally or per target, and are never written into packs, so they also work with
  read-only git sources.

## CLI

Without a command the TUI opens on the workspace. Every command has `--help`.

Packs, sources and targets:

* `pack validate <pack-dir>... [--json] [--git]` — check directories against the contract: layout, manifest,
  namespaces, `opencode.json` keys, references between files and packs, archetype declarations. Reports the pack's
  IDs, its executable surface (plugins, tool modules, skill scripts, MCP servers, external commands) and what a
  required pack must provide; exit 1 on errors. `--git` applies the stricter rules for git sources. `pack list
  [--json]` shows the packs the registered sources offer.
* `source list|add|remove|pull|trust|untrust|prefer` — `add <name> <dir|git-url> [--ref <ref>] [--trust]` registers a
  directory or a git repository (`https:`, `ssh:`, `git@host:path`; other schemes and URLs with credentials are
  refused). `pull` clones or fetches git sources and checks them out detached at their ref (default: the remote
  HEAD). Installing executable content from an untrusted source, or a change to executable content from any source,
  needs confirmation. `prefer <pack> <source>`
  picks a source when several offer the same pack.
* `resolve <[source/]pack[@range]>... [--target <dir>] [--json]` — resolve packs and their `requires` without writing:
  exactly one candidate per pack name (the newest is never picked silently), cycles and missing packs are errors,
  every selected pack is validated. Prints the install order, the executable surface, the changes against the
  target's lock and what would need confirmation.
* `install <[source/]pack[@range]>...`, `uninstall <pack>...`, `update [<pack>...]`, `reconcile`, `status`,
  `restore <backup-id>` — all with `[--target <dir>]`; `install`/`uninstall`/`update`/`reconcile` with `--dry-run`
  and `--json`; `install`/`update`/`reconcile` with `--adopt`; `install`/`update` with `--yes`. The managed part of
  `opencode.json` is regenerated from the packs while your keys stay; config sections the engine empties are
  removed. Every conflict (the same ID in two packs, files or entries you own, managed files you changed) is
  reported before anything is written; `--adopt` backs up and replaces, `restore` undoes it. Writes are journaled
  and rolled back on failure or after a crash; one command at a time per target. Semantics:
  [`contract/CONTRACT.md` §8](contract/CONTRACT.md#8-installation-semantics-engine-side).
* `models show|set|unset|pin|unpin` and `override show|set|unset` (with `[--target <dir>] [--global]
  [--no-reconcile] [--yes]`) — user settings. `models set <pack> <trigger> <agent>=<provider/model[#variant]|inherit>`
  routes the subagents of an archetype pack when a caller runs on `<trigger>` (a provider, or `provider/model`);
  `models pin <pack>/<agent> <model>` fixes a subagent's model, `unpin` removes any fixed model, the pack's included.
  `override set <pack>/<id> steps=30 hidden=true` patches frontmatter (YAML values, `null` removes a field;
  `--command` for commands). Each edit reconciles the target.

Workspace (catalog or pack you are editing):

* `create` — create an agent in a pack of the workspace (`[family-]<pack>-<role>.md`, V2 frontmatter).
* `lint` — naming convention report; `fix-names [--dry-run]` renames and updates references.
* `audit` — permission ordering and risk report.
* `tune [--steps n] [--temp n] [--variant name|--effort name] [--clear-variant|--clear-effort] [--category <pack>|--all]`
  — update model parameters. Agent-level `temperature` is inert in OpenCode 2.2.5; use model variants.
* `bridge [--pack <name>] [--target claude|codex] [--output path] [--name name] [--prefix prefix] [--config path]
  [--model source=target]... [--map-all target] [--no-register] [--no-validate] [--marketplace-name name] [--wizard]`
  — translate a pack (default: the configured `prefix` without its trailing `-`), with the packs it requires, into a
  Claude Code plugin or a Codex layer (default output
  `bridges/<claude-code|codex>/<name>` in the workspace). `bridge check [--pack <name>] [--target claude|codex]`
  regenerates the committed bridges and compares them byte for byte. See [Bridges](#bridges).

Auto-commit is off by default; `--auto-commit`/`--no-auto-commit` (or `AGENT_MANAGER_AUTO_COMMIT=1|0`) turn on or off local, scoped commits of
workspace edits; see [Safety](#safety).

## TUI keymap

The agent list is a tree with one folder per pack, all closed at startup; `→`/`l` opens the focused folder and `←`/`h`
closes it. The search (`/`) hides folders without matches and shows the others expanded; clearing it restores each
folder's state. The model selector opens with the provider of the current model expanded.

Main view: arrows or `j/k` move (on inspector tabs 3–5 with an agent focused they scroll the tab), `/` searches file
names (`Enter` keeps the filter, `Esc` clears it), `Space` selects the focused agent, `a` toggles every agent of the
focused pack, `s` the agents of the same pack with the focused agent's model, `m` model (on an archetype pack folder
with no selection: its routing defaults), `v` repair invalid models, `Shift-T` tier, `t` parameters (selection,
focused folder or focused agent), `c` color, `p` permission preset, `g` delegations, `u` skills, tools and MCP
permissions of the focused agent, `r` rename, `b` Claude bridge, `Shift-B` Codex bridge (of the focused pack), `e`
install the focused pack into OpenCode, `1–5` inspector tabs, `Shift-L` layout, `F` fix permission order (inspector
tab 3), `PageUp/PageDown` scroll, `Esc` close modals, `Ctrl-C` quit.

- **Model selector**: only the arrows navigate; printable keys type into the search (every word must appear in
  `provider/model`), `Backspace` edits it, `Esc` clears it and then closes, `Enter` toggles a provider or assigns a
  model, `Ctrl-R` reloads the catalog.
- **Routing defaults** (`m` on an archetype pack): one row per trigger. Editing a configuration writes the pack's
  `routingDefaults` in `opencode-pack.json` and validates the pack, restoring the file if it no longer satisfies the
  contract. They are what the pack ships; a user changes them per target with `manage-agents models`.
- **Install** (`e`): previews the change with a dry run (packs, files, confirmations needed for executable content)
  and installs on `Y`. The workspace becomes a local source the first time (named after its directory).
- **Skills, Tools & MCP** (`u` on an agent): `Space` toggles the agent's `allow`/`deny` for a skill (or `* (All
  Skills)`), a tool family (`slide_*`), a tool, or an MCP server (`<server>_*`). The list contains what the agent's
  pack and the packs it requires provide. `Enter` saves the agent file; nothing else is written.
- **Bridge** (`b`/`Shift-B`): plugin name, prefix and `Map all models to`; `Tab` cycles. The model field sets the
  `"*"` catch-all for the target (empty keeps the tier mapping).
- **Layout** (`Shift-L`): arrows/`h/l` adjust the split, `Home`/`End` select bounds, `R` resets, `Enter` saves to
  `$XDG_CONFIG_HOME/manage-agents/ui.json` (`{ "version": 1, "listShare": 0.6667 }`, 0.60–0.75).
  `AGENT_MANAGER_UI_CONFIG=<file>` reads another file and makes the layout read-only.

Inspector tabs: Info, Name, Sec(urity), Graph (delegations), Res(ources). Tab 1 shows the Thinking/Effort
(`variant`). Tab 5 shows the agent's skills (with dead references), the custom tools of its packs grouped by family,
and the MCP servers it may use, with their state in the target's `opencode.json`.

Parameter tuning (`t`) sets `steps`, `temperature`, `mode`, `hidden` and Thinking/Effort (`variant`; `Space` or
`←`/`→` cycles `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or type a custom name). Variants are
defined on the model: see OpenCode's [agent](https://opencode.ai/docs/agents/#additional) and
[model variants](https://opencode.ai/docs/models/#variants) documentation.

## OpenCode V2 compatibility

Agents are read in both V1 and V2 form and written back in their own form: `max_steps`/`steps`,
`disable`/`disabled`, `prompt`/`system`, `temperature`/`top_p` under `request.body`, `permission` objects and
`permissions` arrays (`[{action, resource, effect}]`), and `provider/model#variant`. Agents in `mode/` or `modes/`
are primary. The model catalog comes from `opencode models`.

## Bridges

A bridge translates one pack of the workspace, with the packs it requires, into a Claude Code plugin or a Codex
layer: agents, commands as skills, skills, MCP and LSP servers merged from the packs' `opencode.json`. Options live
in `bridges/translation-config.json` of the workspace (`pluginName`, `prefix`, model tiers and maps, Claude
settings).

- **Models.** `--model <source>=<target>` is repeatable and accepts comma lists; `--map-all <target>` is
  `--model "*=<target>"`. Keys match an agent's model as a full lowercase ID or as the bare ID after the last `/`.
  Resolution: per-agent overrides, then `modelMap` (full ID, bare ID, `"*"`), then the role tier, then inference,
  then `defaultTier`. Mappings and the Claude flags given on the command line are saved in the translation config and
  replayed by later runs. Claude targets must be `fable`, `sonnet`, `opus`, `haiku`, `inherit` or a full `claude-*`
  ID; Codex targets any non-empty model ID.
- **Claude plugin.** Emits `.claude-plugin/plugin.json` and a local `marketplace.json`, agents, skills (commands
  become `skills/<name>/SKILL.md` with `$ARGUMENTS` → `$request`), `.mcp.json`, `.lsp.json` and the engine's plugin
  icon. Unless disabled (`claude.autoValidate`, `claude.autoRegister`, `--no-validate`, `--no-register`) it then
  runs `claude plugin validate --strict` and registers the plugin in Claude Code (user scope, once). Each run removes
  generated files that are no longer produced.
- **Permissions.** Tool-level only: OpenCode keys map to Claude tools (`shell` → `Bash`, `edit` → `Write`/`Edit`,
  `task` → `Agent`, MCP keys → `mcp__<server>__*`, ...). Granular patterns (shell allowlists, edit globs, ask states)
  cannot be carried by plugin agents; each is reported as a warning and listed in the generated README.
- **What is not translated.** OpenCode plugins and custom tools of the packs are listed in the generated README with
  their nearest Claude equivalents; prompts that mention OpenCode-only tools get a runtime note saying the documented
  fallbacks apply. Tool names in prompt bodies are adapted (`todowrite` → `TodoWrite`/`update_plan`, Task tool →
  `Agent`, ...).

## Safety

- Install, uninstall and update are transactions on the target: planned, checked for conflicts, journaled, applied,
  and rolled back on failure. Replaced user content goes to `<target>/.manage-agents/backups/<id>/`.
- Workspace edits are atomic per file and refuse files changed on disk since they were read. With auto-commit on,
  each edit becomes a local, unsigned, hook-free commit of exactly the paths it touched, after a clean-worktree,
  identity, branch, lock, symlink and scope check; failures leave the change for manual recovery and never reset your
  work.
- Pack content is untrusted: terminal output escapes control characters, git URLs with credentials are refused,
  symlinks are never followed in managed scopes.

## Development

```bash
npm ci
npm test          # typecheck + node:test (src/utils, runtime)
npm run build
npm run validate  # test + build + validation of the example pack
```

Troubleshooting: set `git config user.name`/`user.email` for auto-commit; a stale `<target>/.manage-agents/install.lock`
is reclaimed automatically when its process is gone; keep `git` (sources) and `claude` (Claude bridge validation and
registration) on PATH; on Windows use Node or Bun directly.

## License

MIT. Third-party dependencies and services keep their own terms.
