# Wiki topic bundle

A portable projection of the Wiki agents, command, and skills\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `src/AGENTS.md` → `AGENTS.md`
- `src/agents/wiki-analyzer.md` → `agents/wiki-analyzer.md`
- `src/agents/wiki-indexer.md` → `agents/wiki-indexer.md`
- `src/agents/wiki-orchestrator.md` → `agents/wiki-orchestrator.md`
- `src/agents/wiki-updater.md` → `agents/wiki-updater.md`
- `src/agents/wiki-writer.md` → `agents/wiki-writer.md`
- `src/commands/wiki.md` → `commands/wiki.md`
- `src/skills/wiki-conventions/SKILL.md` → `skills/wiki-conventions/SKILL.md`
- `src/skills/wiki-navigate/SKILL.md` → `skills/wiki-navigate/SKILL.md`
- `src/skills/wiki-templates/SKILL.md` → `skills/wiki-templates/SKILL.md`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `src/` (or legacy `general/`). The category manifest is `agents/.agent-manager/categories/wiki.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build wiki
node manage-agents/manage-agents.mjs --no-auto-commit category check wiki
```

Compatibility command: `node manage-agents/manage-agents.mjs category check --category wiki`.

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
