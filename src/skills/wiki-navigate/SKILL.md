---
name: wiki-navigate
description: Consult the project wiki before exploring source files — use index.md to locate relevant pages, then source_files frontmatter to jump directly to the right code
---

Always consult the wiki **before** searching the codebase or reasoning about project structure.
1. **Start at `wiki/index.md`** — it catalogs every wiki page with a one-line description. Find the page that matches your question.
2. **Read that page** — each page's `source_files` frontmatter lists the exact source files it documents. Go directly to those files.
3. **Done** — no glob, no grep, no guesswork.
The wiki covers: project overview, architecture, module purposes and key files, public APIs, concepts and patterns, configuration, and a glossary of project-specific terms. If your question is about *what* something does, *where* it lives, or *how* pieces connect, the wiki already has the answer.