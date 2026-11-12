---
name: opencode-pack-authoring
description: How to create or change an OpenCode pack (agents, commands, skills, plugins, tools, resources) in the format manage-agents installs - layout, opencode-pack.json manifest, namespacing, references between files and packs, archetype routing, and how to validate. Load before adding, moving or renaming any file in a pack.
---

# Authoring OpenCode packs

A pack is a directory laid out like `~/.config/opencode/`, with an `opencode-pack.json` manifest at its root. The
full rules are in `CONTRACT.md` of manage-agents (contract 1.0). This skill is the working checklist.

## Before you edit

1. Find the pack: the nearest ancestor directory with `opencode-pack.json`. Read the manifest: `name`, `requires`,
   `archetype`.
2. Run `manage-agents pack validate <pack-dir>` and note the existing warnings, so you do not mistake them for
   yours.

## Where files go

| You are adding | Path |
|---|---|
| agent | `agents/<id>.md` (V2 frontmatter: `description`, `mode`, `model`, `permissions`, ...) |
| slash command | `commands/<id>.md` |
| skill | `skills/<id>/SKILL.md`, with a `description`; supporting files next to it (`scripts/`, `references/`) |
| plugin | `plugins/<name>/index.ts` using `Plugin.define` from `@opencode/plugin`; register it in `opencode.json` `plugins` as `./plugins/<name>` |
| plugin helper module | `tools/<pack-name>/<file>` (or flat `tools/_<pack-name>_<file>`) |
| any other content | `<dir>/<pack-name>/...`, e.g. `resources/<pack-name>/...` |
| pack-wide guidance | `AGENTS.md` at the pack root |

Never create: other root files, `instructions/`, `.manage-agents/`, the legacy singular directories (`agent/`,
`plugin/`, ...), single-file plugins, or `node_modules/`.

## References

- Use paths **relative to the pack root** in `opencode.json` (`skills`, `instructions`, `{file:...}`), and paths
  relative to the importing file in code imports.
- Never write absolute config paths such as `~/.config/opencode/...`. The install target can differ.
- To use a file from another pack, add that pack to `requires` with a semver range (`"dev-tools": "^2.0.0"`) and
  reference the file at the path it has inside that pack. Every pack is installed into the same tree.
- Plugins may import only `@opencode/plugin`, Node built-ins and pack files. Vendor anything else.

## opencode.json(c)

Only `plugins`, `mcp` (as `mcp.servers.<name>`), `skills`, `instructions`, `agents`, `commands`, `formatter`, `lsp`
and `experimental` flags. Never set the user's keys (`model`, `default_agent`, `providers`, `permissions`, ...).

## Archetypes and models

- To make subagent models follow the model the caller runs on, declare
  `"archetype": {"callers": [...primary agents], "reference": "<one of them>"}` and optional `routingDefaults`.
- Give a subagent a fixed `model` in its frontmatter only when it truly needs one, for example a model with image
  input: that pins it and routing skips it.

## Versioning

- Bump `version` (semver) for every change you ship: patch for fixes, minor for additions, major for removals or
  renames of agents, commands, skills, plugins or paths that other packs reference.
- Adding or changing plugins, tool modules, skill scripts or MCP servers changes the pack's **executable surface**,
  and users are asked to confirm it. Mention it in the change description.

## Done means

`manage-agents pack validate <pack-dir>` exits 0. Your change adds no new warnings, or you justify each one. Every
`unresolved` reference is provided by a pack listed in `requires`.
