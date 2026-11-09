# Pipeline agent bundle

Multi\-agent pipeline for OpenCode: an orchestrator that routes work to specialized subagents \(explore, plan, execute, test, review, ops\), with guarded bash and pipeline state\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `src/AGENTS.md` → `AGENTS.md`
- `src/agents/pipeline-orchestrator.md` → `agents/pipeline-orchestrator.md`
- `src/agents/pipeline-chrome_devtools.md` → `agents/pipeline-chrome_devtools.md`
- `src/agents/pipeline-code_reviewer.md` → `agents/pipeline-code_reviewer.md`
- `src/agents/pipeline-critic.md` → `agents/pipeline-critic.md`
- `src/agents/pipeline-docs_grounding.md` → `agents/pipeline-docs_grounding.md`
- `src/agents/pipeline-executor.md` → `agents/pipeline-executor.md`
- `src/agents/pipeline-explorer.md` → `agents/pipeline-explorer.md`
- `src/agents/pipeline-fast_lane.md` → `agents/pipeline-fast_lane.md`
- `src/agents/pipeline-frontend_specialist.md` → `agents/pipeline-frontend_specialist.md`
- `src/agents/pipeline-hitl.md` → `agents/pipeline-hitl.md`
- `src/agents/pipeline-kotlin_specialist.md` → `agents/pipeline-kotlin_specialist.md`
- `src/agents/pipeline-multimodal.md` → `agents/pipeline-multimodal.md`
- `src/agents/pipeline-ops.md` → `agents/pipeline-ops.md`
- `src/agents/pipeline-planner.md` → `agents/pipeline-planner.md`
- `src/agents/pipeline-post_session.md` → `agents/pipeline-post_session.md`
- `src/agents/pipeline-reasoner.md` → `agents/pipeline-reasoner.md`
- `src/agents/pipeline-refactorer.md` → `agents/pipeline-refactorer.md`
- `src/agents/pipeline-researcher.md` → `agents/pipeline-researcher.md`
- `src/agents/pipeline-security_auditor.md` → `agents/pipeline-security_auditor.md`
- `src/agents/pipeline-swift_specialist.md` → `agents/pipeline-swift_specialist.md`
- `src/agents/pipeline-tester.md` → `agents/pipeline-tester.md`
- `src/commands/pipeline-bug.md` → `commands/pipeline-bug.md`
- `src/commands/pipeline-feature.md` → `commands/pipeline-feature.md`
- `src/commands/pipeline-init.md` → `commands/pipeline-init.md`
- `src/commands/pipeline-ops.md` → `commands/pipeline-ops.md`
- `src/commands/pipeline-refactor.md` → `commands/pipeline-refactor.md`
- `src/commands/pipeline-research.md` → `commands/pipeline-research.md`
- `src/skills/code-review-antipatterns` → `skills/code-review-antipatterns`
- `src/skills/italiano-decente` → `skills/italiano-decente`
- `src/skills/seo-copywriting` → `skills/seo-copywriting`
- `src/plugins/agent-router` → `plugins/agent-router`
- `src/plugins/dev-tools` → `plugins/dev-tools`
- `src/plugins/doc-tools` → `plugins/doc-tools`
- `src/plugins/pipeline-guard` → `plugins/pipeline-guard`
- `src/plugins/pipeline-tools` → `plugins/pipeline-tools`
- `src/plugins/slide-tools` → `plugins/slide-tools`
- `src/tools/_tool.ts` → `tools/_tool.ts`
- `src/tools/_agent_router.js` → `tools/_agent_router.js`
- `src/tools/_repo.js` → `tools/_repo.js`
- `src/tools/_sessions.js` → `tools/_sessions.js`
- `src/tools/_bash_guard.js` → `tools/_bash_guard.js`
- `src/tools/_run.js` → `tools/_run.js`
- `src/tools/_env.js` → `tools/_env.js`
- `src/tools/_serve.js` → `tools/_serve.js`
- `src/tools/_services.js` → `tools/_services.js`
- `src/tools/dev_env.ts` → `tools/dev_env.ts`
- `src/tools/dev_serve.ts` → `tools/dev_serve.ts`
- `src/tools/dev_smoke.ts` → `tools/dev_smoke.ts`
- `src/tools/dev_verify.ts` → `tools/dev_verify.ts`
- `src/tools/_pipeline_core.js` → `tools/_pipeline_core.js`
- `src/tools/pipeline_commit.ts` → `tools/pipeline_commit.ts`
- `src/tools/pipeline_state.ts` → `tools/pipeline_state.ts`
- `src/tools/docx` → `tools/docx`
- `src/tools/_safeName.js` → `tools/_safeName.js`
- `src/tools/_doc_theme.template.css` → `tools/_doc_theme.template.css`
- `src/tools/_paths.js` → `tools/_paths.js`
- `src/tools/_python.js` → `tools/_python.js`
- `src/tools/doc_compile_theme.ts` → `tools/doc_compile_theme.ts`
- `src/tools/doc_convert.ts` → `tools/doc_convert.ts`
- `src/tools/doc_create.ts` → `tools/doc_create.ts`
- `src/tools/doc_list.ts` → `tools/doc_list.ts`
- `src/tools/doc_modify.ts` → `tools/doc_modify.ts`
- `src/tools/doc_restore.ts` → `tools/doc_restore.ts`
- `src/tools/doc_view.ts` → `tools/doc_view.ts`
- `src/requirements.txt` → `requirements.txt`
- `src/tools/pptx` → `tools/pptx`
- `src/tools/_theme.template.css` → `tools/_theme.template.css`
- `src/tools/slide_analyze_template.ts` → `tools/slide_analyze_template.ts`
- `src/tools/slide_assemble_pptx.ts` → `tools/slide_assemble_pptx.ts`
- `src/tools/slide_build_pptx.ts` → `tools/slide_build_pptx.ts`
- `src/tools/slide_compile_composition.ts` → `tools/slide_compile_composition.ts`
- `src/tools/slide_compile_theme.ts` → `tools/slide_compile_theme.ts`
- `src/tools/slide_create_thumbnails.ts` → `tools/slide_create_thumbnails.ts`
- `src/tools/slide_download_image.ts` → `tools/slide_download_image.ts`
- `src/tools/slide_generate_image.ts` → `tools/slide_generate_image.ts`
- `src/tools/slide_screenshot.ts` → `tools/slide_screenshot.ts`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `src/` (or legacy `general/`). The category manifest is `agents/.agent-manager/categories/pipeline.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build pipeline
node manage-agents/manage-agents.mjs --no-auto-commit category check pipeline
```

Compatibility command: `node manage-agents/manage-agents.mjs category check --category pipeline`.

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
