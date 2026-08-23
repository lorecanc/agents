---
name: wiki-conventions
description: Conventions and rules for the project wiki structure, naming, and formatting
---

## Wiki Structure

The wiki lives in `wiki/` at the project root. Structure:

- `wiki/.last-updated-commit` — SHA watermark (plain text, no markdown)
- `wiki/index.md` — Page catalog (owner: wiki-indexer ONLY)
- `wiki/log.md` — Operation log (owner: wiki-indexer ONLY)
- `wiki/glossary.md` — Term definitions (owner: wiki-indexer ONLY)
- `wiki/overview.md` — Project overview
- `wiki/architecture.md` — Architecture documentation
- `wiki/getting-started.md` — Setup guide
- `wiki/modules/*.md` — One page per module/package
- `wiki/components/*.md` — Key component documentation
- `wiki/api/*.md` — API documentation
- `wiki/concepts/*.md` — Patterns and concepts
- `wiki/config/*.md` — Configuration reference
- `wiki/dependencies/*.md` — Key dependency documentation

Subdirectories are created ONLY if they have content. A small project may only have root pages.

## Naming Rules

- File names: kebab-case, lowercase, `.md` extension
- Examples: `auth-service.md`, `database-config.md`, `react-hooks.md`
- No spaces, no underscores, no uppercase

## Page Frontmatter

Every wiki page (except .last-updated-commit) MUST start with YAML frontmatter:

```yaml
---
title: "Page Title"
description: "One-line description of what this page covers"
category: "modules|components|api|concepts|config|dependencies|root"
source_files:
  - "src/auth/index.ts"
  - "src/auth/middleware.ts"
created: "2026-04-27"
last_updated: "2026-04-27"
---
```

## Language

- All wiki content in English
- language: en
- Use technical terminology consistently
- Reference glossary terms on first use in each page

## Cross-References

- Use relative markdown links: `[Page Title](../path/to/page.md)`
- Link on first mention per section only
- No circular chains

## Mermaid Diagrams

Use Mermaid diagrams to visualize relationships that are hard to convey in text. Rules:

- **overview.md**: include a `graph TD` showing the high-level system components
- **architecture.md**: include a `graph TD` for component diagram and a `sequenceDiagram` for data flow
- **modules/*.md**: include a `graph LR` showing the module's internal and external dependencies
- Use fenced code blocks with language `mermaid`
- Quote node labels containing special characters: `id["Label (info)"]`
- Keep diagrams focused — max ~10 nodes per diagram. Split into multiple if larger.
- Prefer `graph TD` (top-down) for hierarchies, `graph LR` (left-right) for flows
- Do NOT use Mermaid for simple lists or tables — use markdown tables instead

## Ownership Rules

- `index.md`, `log.md`, `glossary.md` → ONLY wiki-indexer writes these
- All other pages → ONLY wiki-writer writes these
- Never violate ownership boundaries
