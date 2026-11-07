# Flow agent bundle

Claude Code style agent family for OpenCode: one working agent, parallel explore/review subagents, on\-demand skills, minimal safety guard\.

> **Generated distribution.** Do not edit this directory directly; changes are overwritten by the next build.

## Purpose and contents

This portable package is an inventory-driven projection of the canonical OpenCode workspace. The manifest, rather than a filename convention, defines what is included:

- `src/AGENTS.md` → `AGENTS.md`
- `src/agents/flow-build.md` → `agents/flow-build.md`
- `src/agents/flow-plan.md` → `agents/flow-plan.md`
- `src/agents/flow-explore.md` → `agents/flow-explore.md`
- `src/agents/flow-review.md` → `agents/flow-review.md`
- `src/agents/flow-research.md` → `agents/flow-research.md`
- `src/agents/flow-eye.md` → `agents/flow-eye.md`
- `src/agents/flow-ops.md` → `agents/flow-ops.md`
- `src/commands/flow-feature.md` → `commands/flow-feature.md`
- `src/commands/flow-bug.md` → `commands/flow-bug.md`
- `src/commands/flow-design.md` → `commands/flow-design.md`
- `src/commands/flow-review.md` → `commands/flow-review.md`
- `src/commands/flow-simplify.md` → `commands/flow-simplify.md`
- `src/commands/flow-commit.md` → `commands/flow-commit.md`
- `src/commands/flow-explain.md` → `commands/flow-explain.md`
- `src/skills/flow-frontend-design/SKILL.md` → `skills/flow-frontend-design/SKILL.md`
- `src/skills/flow-visual-loop/SKILL.md` → `skills/flow-visual-loop/SKILL.md`
- `src/skills/flow-security/SKILL.md` → `skills/flow-security/SKILL.md`
- `src/skills/flow-simplify/SKILL.md` → `skills/flow-simplify/SKILL.md`
- `src/skills/flow-testing/SKILL.md` → `skills/flow-testing/SKILL.md`
- `src/skills/flow-commit/SKILL.md` → `skills/flow-commit/SKILL.md`
- `src/skills/flow-swift/SKILL.md` → `skills/flow-swift/SKILL.md`
- `src/skills/flow-kotlin/SKILL.md` → `skills/flow-kotlin/SKILL.md`
- `src/skills/code-review-antipatterns` → `skills/code-review-antipatterns`
- `src/skills/chrome-devtools` → `skills/chrome-devtools`
- `src/skills/chrome-devtools-a11y-debugging` → `skills/chrome-devtools-a11y-debugging`
- `src/skills/chrome-devtools-debug-optimize-lcp` → `skills/chrome-devtools-debug-optimize-lcp`
- `src/skills/chrome-devtools-memory-leak-debugging` → `skills/chrome-devtools-memory-leak-debugging`
- `src/skills/chrome-devtools-troubleshooting` → `skills/chrome-devtools-troubleshooting`
- `src/plugins/flow-guard` → `plugins/flow-guard`
- `src/plugins/pipeline-tools` → `plugins/pipeline-tools`
- `src/tools/_tool.ts` → `tools/_tool.ts`
- `src/tools/_flow_guard.js` → `tools/_flow_guard.js`
- `src/tools/_pipeline_core.js` → `tools/_pipeline_core.js`
- `src/tools/_pipeline_run.js` → `tools/_pipeline_run.js`
- `src/tools/_pipeline_env.js` → `tools/_pipeline_env.js`
- `src/tools/_pipeline_serve.js` → `tools/_pipeline_serve.js`
- `src/tools/_pipeline_services.js` → `tools/_pipeline_services.js`
- `src/tools/pipeline_commit.ts` → `tools/pipeline_commit.ts`
- `src/tools/pipeline_env.ts` → `tools/pipeline_env.ts`
- `src/tools/pipeline_serve.ts` → `tools/pipeline_serve.ts`
- `src/tools/pipeline_smoke.ts` → `tools/pipeline_smoke.ts`
- `src/tools/pipeline_state.ts` → `tools/pipeline_state.ts`
- `src/tools/pipeline_verify.ts` → `tools/pipeline_verify.ts`
- `opencode.json` (generated configuration)

## Source of truth and workflow

Canonical sources live under `src/` (or legacy `general/`). The category manifest is `agents/.agent-manager/categories/flow.json`; it records the allowlist, targets, and distribution version. Edit those canonical inputs, then regenerate this package from the repository root:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category build flow
node manage-agents/manage-agents.mjs --no-auto-commit category check flow
```

Compatibility command: `node manage-agents/manage-agents.mjs category check --category flow`.

`category check` is read-only and reports missing, changed, or extra files. `CATEGORY.json` records the manifest and entry hashes; `PROVENANCE.json` records the generated bundle digest. Use those files to verify provenance rather than editing generated metadata.

## License

Project-owned content is distributed under the MIT License in `LICENSE`. Third-party tools and services retain their own terms.
