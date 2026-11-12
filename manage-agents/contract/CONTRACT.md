# OpenCode pack contract 1.0

This document defines the format that `manage-agents` accepts as input. A **pack** is a directory laid out like an
OpenCode config directory (`~/.config/opencode/`), plus a small manifest. Authors and agents who write packs need
nothing else: no build step, no engine code inside the pack.

The contract is versioned as `MAJOR.MINOR`. A pack declares the version it targets in `opencode-pack.json`. The
engine rejects an unknown major version and only warns about a newer minor one, which may only add optional
features.

Grounding: OpenCode V2 documentation at <https://opencode.ai/v2/docs/> (`config`, `agents`, `commands`, `skills`,
`plugins`, `mcp-servers`).

## 1. Layout

```text
my-pack/
├── opencode-pack.json        required manifest (section 2), never installed
├── opencode.json             optional; or opencode.jsonc (section 4)
├── AGENTS.md                 optional; installed as instructions/<pack>.md and registered in `instructions`
├── README.md  LICENSE  CHANGELOG.md     optional, never installed
├── agents/<id>.md            agents; nested paths become IDs (agents/team/x.md -> team/x)
├── commands/<id>.md          slash commands; nested paths become IDs
├── skills/<id>/SKILL.md      skills; supporting files sit next to SKILL.md (scripts/, references/)
├── plugins/<name>/index.ts   V2 directory plugins (index|server .ts/.js/.mjs, or package.json)
├── themes/<name>.json        themes
├── tools/<pack>/**           helper modules imported by plugins (or flat tools/_<pack>_*)
└── <dir>/<pack>/**           any other content: resources/<pack>/, office/<pack>/, ...
```

Rules (all enforced by `manage-agents pack validate`):

- **Native directories** are `agents/`, `commands/`, `skills/`, `plugins/` and `themes/`, with the meaning OpenCode
  gives them. Legacy singular aliases (`agent/`, `command/`, `skill/`, `plugin/`, `tool/`, `mode(s)/`) are rejected.
- `agents/` and `commands/` hold only Markdown files. Agent frontmatter uses V2 keys (`description`, `mode`,
  `model`, `permissions`, `hidden`, `steps`, ...). The V1 keys `tools`, `permission` and `name` are reported.
- Every file under `skills/` belongs to the nearest directory that contains `SKILL.md`. That directory's path is the
  skill ID. Give `SKILL.md` a `description`: OpenCode accepts a skill without one, but the model cannot discover it,
  so validation warns.
- Plugins are directories with an `index` or `server` entry (`.ts`, `.js` or `.mjs`) or a `package.json`.
  Single-file plugins (`plugins/x.ts`) are rejected.
- Top-level directory names are case-sensitive: `Agents/` or `Instructions/` are rejected rather than treated as
  ordinary content.
- **Mandatory namespace for every non-native path**: `<dir>/<pack-name>/**`. For tools, the flat form
  `tools/_<pack-name>_*` is also accepted. Files shared by several packs belong in a dedicated pack that the others
  list in `requires`.
- **Root files**: only the ones shown above (`README`, `LICENSE`, `CHANGELOG` with no extension or `.md`, `.txt`,
  `.rst`). Entries named `.git*` and `.DS_Store` are ignored at any depth.
- **Tests**: files named `*.test.*` (tests and test helpers) live next to the code they test and are never installed.
  Their imports are not checked, because they run on the merged layout of all packs (the installed tree) rather than
  on a single pack. They follow the namespace rule like any other file.
- **Reserved paths**: `instructions/`, `.manage-agents/` and `plugins/manage-agents-router/` belong to the engine.
- **Ignored**: `node_modules/` is never installed. Plugins may import only `@opencode/plugin`, Node built-ins and
  their own files; vendor anything else as bundled files. OpenCode V2 does not document installing arbitrary
  dependencies for local plugins.
- **Symlinks**: a symlink must point to a file inside the pack. Symlinked directories, broken symlinks and links
  that leave the pack are rejected. The engine installs the content, not the link.
- **Case**: two paths that differ only by case or Unicode normalization (`Foo.md` / `foo.md`) are rejected, because
  macOS and Windows filesystems would merge them.

## 2. Manifest: `opencode-pack.json`

JSON Schema: [`opencode-pack.schema.json`](opencode-pack.schema.json).

```json
{
  "$schema": "https://github.com/lorecanc/manage-agents/contract/opencode-pack.schema.json",
  "contract": "1.0",
  "name": "flow",
  "version": "2.0.0",
  "description": "Claude Code style build agent with plan mode and read-only subagents",
  "requires": { "dev-tools": "^2.0.0" },
  "archetype": { "callers": ["flow-build", "flow-plan"], "reference": "flow-build" },
  "routingDefaults": {
    "mistral": { "flow-explore": "mistral/deepseek-v4-1-flash-1017#high", "flow-review": "inherit" }
  }
}
```

| Field | Rule |
|---|---|
| `contract` | `"MAJOR.MINOR"`. This engine implements `1.0`. |
| `name` | Global pack identity: lowercase letters, digits and hyphens, at most 64 characters. It is also the namespace directory name. |
| `version` | Full semver (`1.2.0`, `2.0.0-beta.1`). |
| `description` | Non-empty. |
| `requires` | Map `name -> semver range`, and nothing else (no arrays). `"*"` is accepted only in local sources. A pack cannot require itself. |
| `archetype` | Optional. `callers` are the primary agents of this pack that delegate to subagents; `reference` is one of them. |
| `routingDefaults` | Optional, only together with `archetype`. Trigger (`provider` or `provider/model`) -> subagent ID -> `provider/model[#variant]` or `inherit`. Subagents with a fixed `model` are pinned and never routed. |

Unknown keys are errors.

## 3. Identity

- **Pack**: `name` is global. When several sources offer the same name, the resolver fails unless the user picks
  one with `source/name` or a stored preference. The engine never picks the newest version on its own. `requires`
  always uses the logical name.
- **Resources**, compared across all installed packs:

  | Kind | Canonical ID |
  |---|---|
  | agent, command | path under `agents/` or `commands/` without `.md`, plus keys of `agents` / `commands` in `opencode.json` |
  | skill | directory of `SKILL.md` under `skills/` |
  | plugin | `plugins/<name>`, whether it is discovered from the filesystem or listed in `plugins` |
  | theme | file name under `themes/` without `.json` |
  | MCP server | key under `mcp.servers` |
  | file | pack-relative path, NFC-normalized and case-folded |

  The same ID or the same path coming from two packs is always an install conflict. Packs share files only through
  `requires`: the file lives in one pack, and the others reference it.

## 4. `opencode.json(c)`

A pack may set only these keys: `$schema`, `plugins`, `mcp`, `skills`, `instructions`, `agents`, `commands`,
`formatter`, `lsp` and `experimental`. Everything else (`model`, `default_agent`, `providers`, `permissions`, ...)
belongs to the user and is an error. JSONC (comments, trailing commas) is accepted.

`experimental` flags (for example `{"todo": true}` for agents that use `todowrite`) are owned per flag, like the
other config entries: two packs setting the same flag to different values conflict.

- `plugins`: `"./plugins/<name>"` or `{ "package": "./plugins/<name>", "options": { ... } }`. Local entries must
  point to `./plugins/<name>`. Other specs (npm or git packages) are reported as executable surface. Absolute paths
  are rejected.
- `skills`, `instructions`: paths relative to the **pack root**, or `http(s)` URLs. Absolute and `~` paths are
  rejected. Glob patterns are allowed but are not checked.
- `mcp`: only `mcp.servers.<name>` with `"type": "local"` (non-empty `command` array) or `"type": "remote"`.
- `{file:path}` inside any string: relative to the pack root.

## 5. References

The engine separates references it can check from content it cannot.

**Validated references.** The engine resolves each of these. A reference that leaves the pack is an error. A
reference missing from the pack is an error, unless the pack has `requires`: then it is recorded as *unresolved*,
and the resolver must find it in a required pack.

- `opencode.json` `plugins`, `skills`, `instructions` and `{file:}`;
- static relative imports (`import ... from "./x"`, `import("./x")`, `require("./x")`) in `plugins/**` and
  `tools/**`. A `.js` specifier also matches a `.ts` file. Comments are skipped, but template literals are not
  parsed;
- symlinks.

References use forward slashes; a backslash is an error. Files larger than 2 MiB are not read: their content is not
checked, and validation warns.

**Opaque content.** Markdown prompts, shell, dynamic imports and permission patterns are checked only by
best-effort heuristics. The heuristics report warnings, never guarantees. Today they detect absolute OpenCode config
paths (`~/.config/opencode/...`), which break under `XDG_CONFIG_HOME` or a custom target. Write paths relative to
the installed tree instead, or describe them.

## 6. Installed layout and path rewriting

Every pack is copied into **one shared target tree** (by default `$XDG_CONFIG_HOME/opencode`) with its relative
layout preserved. That is why `../../tools/<pack>/x.js` between packs keeps working, as long as the target pack is
listed in `requires`.

The engine rewrites only what OpenCode resolves against the working directory:

- `skills` and `instructions` entries become absolute target paths;
- `AGENTS.md` is installed as `instructions/<pack>.md` and added to `instructions`;
- `plugins` and `{file:}` stay relative to the config file, which matches the installed layout.

The engine never rewrites Markdown, code or scripts.

## 7. Executable surface

A pack can carry code. `pack validate` and every install report list it:

- plugins (local directories and package specs);
- tool modules (`tools/**` code files);
- skill scripts (code files or executable files inside skills);
- MCP servers, with their command or URL;
- external commands: the first word of MCP, formatter and LSP commands.

Installing a pack from an untrusted source, or an update that changes this surface, needs explicit confirmation.

## 8. Installation semantics (engine side)

The engine records three files per target in `<target>/.manage-agents/`:

- `desired.json`: the root packs the user asked for;
- `lock.json`: the exact resolution (source, version, git revision, manifest hash);
- `installed.json`: the owned files and config contributions, each with its hash and its owning pack.

Rules:

- The same desired state and lock always produce the same tree and the same `opencode.json`.
- The managed part of `opencode.json` is regenerated from the pack contributions; the user's own keys are
  preserved. A section (`mcp.servers`, `lsp`, `experimental`, ...) left empty by removing managed entries is
  removed too; an empty section the user wrote stays.
- Conflicts, including collisions with files the user created, are detected before anything is written. If the
  target changes between that check and the write (for example while a confirmation prompt is open), nothing is
  written.
- A file changed by the user is never deleted silently. A file or config entry the user already had with exactly
  the pack's content stays the user's: uninstalling the pack leaves it in place.
- A symlinked `opencode.json` is never replaced. It is reported, so that the file it points to can be edited or
  used as `--target`.

Commands:

| Command | Effect |
|---|---|
| `resolve <pack>...` | Prints the resolution, the changes against the lock and what needs confirmation. Writes nothing. |
| `install <pack>...` | Adds root requests; packs already locked keep their source and version. |
| `uninstall <pack>...` | Removes root requests; dependencies still required stay at their locked version. |
| `update [<pack>...]` | Pulls the git sources of the named packs (all when none is named) and re-resolves within the ranges. A git source moves as a whole: every pack from it follows the new revision. |
| `reconcile` | Rebuilds the target from `desired.json` and `lock.json`; git packs come from a snapshot of the locked revision. |
| `status` | Read-only drift report; exit 1 when something differs. |
| `restore <backup-id>` | Puts back what `--adopt` replaced; the restored content becomes unmanaged. |

Details:

- **Conflicts**: two packs providing the same ID or the same path with different content, a file or config entry
  the user owns, or a managed file changed locally. Each is reported before anything is written. `--adopt` backs
  up the user's version to `.manage-agents/backups/<id>/` and replaces it. Files installed by the
  `export` command of earlier manage-agents versions (listed in `.resource-export-manifest.json`) are replaced
  without `--adopt`, and still backed up, so a target set up that way moves to packs with a plain `install`.
- **Plugin options**: a pack's plugins are registered as `./plugins/<name>`. A pack that requires another may
  register one of its plugins explicitly, with `options`, and that entry replaces the implicit registration.
- **Transactions**: changes are staged inside the target and recorded in `.manage-agents/journal.json`. A failure
  or a crash is rolled back by the next command, and `.manage-agents/install.lock` lets one command at a time work
  on a target.
- **JSONC**: an `opencode.jsonc` with comments is rewritten as plain JSON, and the original is kept in the backup.
- **Confirmation**: a pack from an untrusted source with executable content, and any change to executable content,
  need confirmation: `--yes`, or an answer at the terminal.

### Model routing and overrides

These are user settings, kept in `$XDG_CONFIG_HOME/manage-agents/`. They are applied at reconcile and never
written into packs, so they also work on read-only git sources. Each setting has a default scope, valid for
every target, and a per-target scope (`--target`) that wins over it.

- **Router**: when an installed pack declares `archetype`, the engine installs its own router plugin into
  `plugins/manage-agents-router/` and generates its `routing.json`. When a caller runs on a trigger (a provider,
  or a `provider/model`, where the exact model wins), each subagent of the pack runs on the configured model;
  `inherit` keeps the caller's model.
- **Routing layers**: the pack's `routingDefaults`, then the default settings, then the target settings, merged
  agent by agent. Edit them with `manage-agents models set|unset <pack> <trigger> <agent>=<model|inherit>`.
- **Overrides** (`overrides.json`): they patch frontmatter fields of installed agents and commands. Allowed agent
  fields: `description`, `mode`, `model`, `permissions`, `hidden`, `color`, `steps`, `disabled`, `request`,
  `temperature`, `top_p`. Allowed command fields: `description`, `agent`, `model`, `subagent`. `null` removes a
  field. Agents and commands defined in `opencode.json` are patched the same way. Edit them with
  `manage-agents override set|unset <pack>/<id>`.
- **Pinning**: a subagent with a fixed model, from its frontmatter or from an override, is pinned and routing
  skips it. Editing a routed model (`models set`) never writes the frontmatter. `models pin` writes the model
  override; `models unpin` sets it to `null`, so the subagent follows routing even if the pack pins it.
- **Edit loop**: `models` and `override` reconcile the target right away, unless `--no-reconcile` is given. With
  `--global`, other targets pick up the change at their next `reconcile`, and `status` reports it as pending.

## 9. Checking a pack

```sh
manage-agents pack validate path/to/my-pack           # human-readable report, exit 1 on errors
manage-agents pack validate path/to/my-pack --json    # machine-readable: ids, executable surface, unresolved refs
```

A minimal valid pack is in [`examples/minimal-pack/`](examples/minimal-pack/). Agents that write packs should load
the skill [`skills/opencode-pack-authoring/SKILL.md`](skills/opencode-pack-authoring/SKILL.md).
