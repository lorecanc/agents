# Documentation category bundle

Portable documentation agents, commands, skills, and document tooling\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `general/AGENTS.md` → `AGENTS.md`
- `general/agents/docs-orchestrator.md` → `agents/docs-orchestrator.md`
- `general/agents/docs-planner.md` → `agents/docs-planner.md`
- `general/agents/docs-html_writer.md` → `agents/docs-html_writer.md`
- `general/commands/new-doc.md` → `commands/new-doc.md`
- `general/commands/edit-doc.md` → `commands/edit-doc.md`
- `general/commands/convert-doc.md` → `commands/convert-doc.md`
- `general/commands/web-audit.md` → `commands/web-audit.md`
- `general/skills/docx` → `skills/docx`
- `general/tools/docx` → `tools/docx`
- `general/requirements.txt` → `requirements.txt`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `agents/general/`. The category manifest is `agents/.agent-manager/categories/docs.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build docs
node manage-agents/manage-agents.mjs --no-auto-commit category check docs
```

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
