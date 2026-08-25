# Slides category bundle

Portable presentation agents, commands, skills, and OOXML tooling\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `general/AGENTS.md` → `AGENTS.md`
- `general/agents/slides-orchestrator.md` → `agents/slides-orchestrator.md`
- `general/agents/slides-planner.md` → `agents/slides-planner.md`
- `general/agents/slides-html_writer.md` → `agents/slides-html_writer.md`
- `general/agents/slides-template_planner.md` → `agents/slides-template_planner.md`
- `general/agents/slides-template_writer.md` → `agents/slides-template_writer.md`
- `general/agents/slides-composition_resolver.md` → `agents/slides-composition_resolver.md`
- `general/commands/new-slides.md` → `commands/new-slides.md`
- `general/commands/polish-slides.md` → `commands/polish-slides.md`
- `general/commands/fix-slide.md` → `commands/fix-slide.md`
- `general/skills/slides-composition` → `skills/slides-composition`
- `general/skills/slides-template-html` → `skills/slides-template-html`
- `general/tools/pptx` → `tools/pptx`
- `general/skills/slides-composition/THIRD_PARTY_NOTICES.md` → `THIRD_PARTY_NOTICES.md`
- `general/requirements.txt` → `requirements.txt`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `agents/general/`. The category manifest is `agents/.agent-manager/categories/slides.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build slides
node manage-agents/manage-agents.mjs --no-auto-commit category check slides
```

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
