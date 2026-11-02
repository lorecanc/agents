---
title: "Workflow Resources"
description: "Slash commands, skills, and supporting documentation that guide agent workflows."
category: "modules"
source_files:
  - "src/commands/convert-doc.md"
  - "src/commands/edit-doc.md"
  - "src/commands/fix-slide.md"
  - "src/commands/new-doc.md"
  - "src/commands/new-slides.md"
  - "src/commands/pipeline-bug.md"
  - "src/commands/pipeline-feature.md"
  - "src/commands/pipeline-init.md"
  - "src/commands/pipeline-ops.md"
  - "src/commands/pipeline-refactor.md"
  - "src/commands/pipeline-research.md"
  - "src/commands/polish-slides.md"
  - "src/commands/ports-plan.md"
  - "src/commands/web-audit.md"
  - "src/commands/wiki.md"
  - "src/skills/chrome-devtools/SKILL.md"
  - "src/skills/chrome-devtools-a11y-debugging/SKILL.md"
  - "src/skills/chrome-devtools-debug-optimize-lcp/SKILL.md"
  - "src/skills/chrome-devtools-memory-leak-debugging/SKILL.md"
  - "src/skills/chrome-devtools-troubleshooting/SKILL.md"
  - "src/skills/code-review-antipatterns/SKILL.md"
  - "src/skills/docs-design/SKILL.md"
  - "src/skills/docs-html/SKILL.md"
  - "src/skills/docx/SKILL.md"
  - "src/skills/pptx/SKILL.md"
  - "src/skills/slides-composition/SKILL.md"
  - "src/skills/slides-design/SKILL.md"
  - "src/skills/slides-html/SKILL.md"
  - "src/skills/slides-template-html/SKILL.md"
  - "src/skills/slides-theming/SKILL.md"
  - "src/skills/wiki-conventions/SKILL.md"
  - "src/skills/wiki-navigate/SKILL.md"
  - "src/skills/wiki-templates/SKILL.md"
  - "src/docs/mcp-configuration.md"
created: "2026-10-16"
last_updated: "2026-11-02"
---

# Workflow Resources

## Purpose

This module contains reusable workflow instructions that shape how agents handle common requests. Slash commands provide task-specific entry points, skills provide focused procedures and constraints, and supporting documentation explains configuration and setup.

## Key Files

| File or group | Role |
|---------------|------|
| `src/commands/*.md` | Slash-command prompt templates, generally routing a task to an agent and laying out its steps or constraints. |
| `src/skills/*/SKILL.md` | Reusable task guidance for document, slide, browser-debugging, code-review, and wiki work. |
| `src/docs/mcp-configuration.md` | Reference for MCP/LSP server configuration, portability, environment variables, and enabling optional servers. |

## Resource Catalog

### Commands

| Workflow area | Commands | Focus |
|---------------|----------|-------|
| Documents | `/new-doc`, `/edit-doc`, `/convert-doc` | Clarify, create, edit, and export documents. |
| Slides | `/new-slides`, `/fix-slide`, `/polish-slides` | Plan a deck, diagnose slide layout, and refine presentation visuals. |
| Pipeline | `/pipeline-bug`, `/pipeline-feature`, `/pipeline-init`, `/pipeline-ops`, `/pipeline-refactor`, `/pipeline-research` | Route bug fixes, features, verification-contract setup, diagnostics, behavior-preserving refactors, and research under lane-specific requirements. |
| Other | `/web-audit`, `/ports-plan`, `/wiki` | Browser audits, local-service port inventory/planning, and wiki generation or updates. |

Command files use frontmatter such as `description` and `agent`; their bodies include `$ARGUMENTS` and workflow instructions. For example, `/edit-doc` instructs the document agent to view current content, apply changes with `doc_modify` (prefer batch search/replace), and optionally re-export.

Pipeline commands set `agent: pipeline-orchestrator` and begin with a repository-state block (branch, HEAD, uncommitted files) used as the session baseline. Three of them have specific presets:

- `/pipeline-bug` (`src/commands/pipeline-bug.md`): trivial, small, clear, low-risk bugs with an identified root cause may use Fast Lane, which must run targeted regression verification before returning. Non-trivial, multi-module, ambiguous, or medium/high-risk bugs use at least Standard Lane with the TDD Bug-Fix Modifier, and Hard Reasoning Lane when the cause is unclear, concurrent, or spans modules. Non-trivial or risky bugs run the full `@pipeline-tester (Red) → @pipeline-executor → @pipeline-tester (Green)` protocol; a small, clear, low-risk bug in Standard Lane may have the executor add the regression test alongside the fix.
- `/pipeline-ops` (`src/commands/pipeline-ops.md`): uses the Ops Lane with `@pipeline-ops` in diagnostic mode (logs, infrastructure state, running services, runtime behavior). Ops never deploys or deletes, and reports `UNVERIFIED` with a cause when a check cannot be completed. If it finds a code defect, it reports it and proposes `/pipeline-bug` instead of fixing it.
- `/pipeline-init` (`src/commands/pipeline-init.md`): drafts the repository's verification contract `.opencode/pipeline.json`, which gives `pipeline_verify`, `pipeline_smoke` and `pipeline_serve` explicit commands. The orchestrator gathers evidence through `@pipeline-explorer` (README, `AGENTS.md`, package manifests, `Makefile`, CI workflows, `.env.example` variable names only), drafts only evidenced commands, and shows the draft to the user with `question` before `@pipeline-fast_lane` writes the file. Validation then runs through `@pipeline-ops` (empirical-validation mode). The command skips HITL and offers a checkpoint commit of the contract only.

### Skills

| Domain | Skills | Main coverage |
|--------|--------|---------------|
| Documents | `docx`, `docs-html`, `docs-design` | Document creation/conversion capabilities, HTML constraints for DOCX, and professional document design. |
| Slides | `pptx`, `slides-design`, `slides-html`, `slides-template-html`, `slides-composition`, `slides-theming` | PPTX workflows, visual design, HTML authoring, template-constrained authoring, composition, and theme resolution. |
| Browser diagnostics | `chrome-devtools`, `chrome-devtools-a11y-debugging`, `chrome-devtools-debug-optimize-lcp`, `chrome-devtools-memory-leak-debugging`, `chrome-devtools-troubleshooting` | Browser interaction, accessibility audits, LCP, memory leaks, and MCP connectivity issues. |
| Wiki and review | `wiki-conventions`, `wiki-navigate`, `wiki-templates`, `code-review-antipatterns` | Wiki structure and page templates, wiki-first navigation, and detailed code-review anti-pattern criteria. |

Skills are stored as `SKILL.md` files with name/description metadata and domain-specific procedures. Some also point to supporting references in their own skill directories.

## Supporting Documentation

`src/docs/mcp-configuration.md` (written in Italian) describes `src/opencode.json` as the portable reference blueprint for MCP and LSP servers. Its main points:

- **Portability**: commands use binaries on `PATH` or `npx -y` rather than user- or OS-specific absolute paths.
- **Secrets**: values are injected with `{env:NAME}` syntax; the `magic` server reads `TWENTYFIRST_API_KEY` from the environment.
- **Activation**: optional servers carry `"disabled": true`. XcodeBuildMCP is disabled by default and may be enabled on macOS with Xcode CLI Tools. Local servers must keep `codemode: false`, because pipeline agents deny `execute`.
- **Remote Google Cloud servers**: seven remote MCP servers (BigQuery, Cloud Run, Cloud Logging, Cloud Monitoring, Cloud SQL, Cloud Storage, Cloud CLI) are disabled by default. The guide covers API enablement, required IAM roles, OAuth Client ID/Secret setup, and a short-lived ADC bearer-token alternative.
- **Enabling servers**: in `manage-agents`, press `u` on a focused agent or category folder to open the Resource Manager, toggle an MCP server with `x` (`draftMcpEnabled`), and save with Enter. The change is applied to the global `~/.config/opencode/opencode.json`: enabling removes `disabled`, disabling sets `disabled: true`, and a server not yet configured there is seeded from the repo's recommended entry.
- **LSP servers**: six language servers are listed (basedpyright, ruff, html, css, sql, markdown).

The guide also notes that the vendored files under `src/docs/docs-opencode/` are V1 reference excerpts, not the current contract.

## Usage Example

The command template `src/commands/edit-doc.md` gives the document editing sequence directly:

```text
1. View the current content with doc_view
2. Apply changes with doc_modify (prefer search_and_replace)
3. Re-export to DOCX with doc_convert if needed
```

Commands establish request-level routing and steps; the selected skill supplies detailed standards for carrying them out. Command workflows can invoke the repository's custom [OpenCode tools and plugin hooks](../api/opencode-tools-and-plugin.md).
