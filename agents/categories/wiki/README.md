# Wiki topic bundle

A portable projection of the Wiki agents, command, and skills\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `general/AGENTS.md` → `AGENTS.md`
- `general/agents/wiki-analyzer.md` → `agents/wiki-analyzer.md`
- `general/agents/wiki-indexer.md` → `agents/wiki-indexer.md`
- `general/agents/wiki-orchestrator.md` → `agents/wiki-orchestrator.md`
- `general/agents/wiki-updater.md` → `agents/wiki-updater.md`
- `general/agents/wiki-writer.md` → `agents/wiki-writer.md`
- `general/commands/wiki.md` → `commands/wiki.md`
- `general/skills/wiki-conventions/SKILL.md` → `skills/wiki-conventions/SKILL.md`
- `general/skills/wiki-navigate/SKILL.md` → `skills/wiki-navigate/SKILL.md`
- `general/skills/wiki-templates/SKILL.md` → `skills/wiki-templates/SKILL.md`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `agents/general/`. The category manifest is `agents/.agent-manager/categories/wiki.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build wiki
node manage-agents/manage-agents.mjs --no-auto-commit category check wiki
```

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
