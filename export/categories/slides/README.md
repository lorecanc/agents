# Slides category bundle

Portable presentation agents, commands, skills, and OOXML tooling\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `src/AGENTS.md` → `AGENTS.md`
- `src/agents/slides-orchestrator.md` → `agents/slides-orchestrator.md`
- `src/agents/slides-planner.md` → `agents/slides-planner.md`
- `src/agents/slides-html_writer.md` → `agents/slides-html_writer.md`
- `src/agents/slides-template_planner.md` → `agents/slides-template_planner.md`
- `src/agents/slides-template_writer.md` → `agents/slides-template_writer.md`
- `src/agents/slides-composition_resolver.md` → `agents/slides-composition_resolver.md`
- `src/commands/new-slides.md` → `commands/new-slides.md`
- `src/commands/polish-slides.md` → `commands/polish-slides.md`
- `src/commands/fix-slide.md` → `commands/fix-slide.md`
- `src/skills/slides-composition` → `skills/slides-composition`
- `src/skills/slides-template-html` → `skills/slides-template-html`
- `src/tools/pptx` → `tools/pptx`
- `src/skills/slides-composition/THIRD_PARTY_NOTICES.md` → `THIRD_PARTY_NOTICES.md`
- `src/requirements.txt` → `requirements.txt`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `src/` (or legacy `general/`). The category manifest is `agents/.agent-manager/categories/slides.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build slides
node manage-agents/manage-agents.mjs --no-auto-commit category check slides
```

Compatibility command: `node manage-agents/manage-agents.mjs category check --category slides`.

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
