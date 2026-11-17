---
name: wiki-navigate
description: Consult the project wiki before exploring source files — use index.md to locate relevant pages, then source_files frontmatter to jump directly to the right code
---

Always consult the wiki **before** searching the codebase or reasoning about project structure.

1. Check wiki freshness before trusting its `source_files` paths. Compare `wiki/.last-updated-commit` with the current `HEAD`, and check for uncommitted changes when they could affect the files you need. The watermark records committed state only.
2. **If `wiki/.last-updated-commit` matches `HEAD` (or changes since it are only unrelated files):** start at `wiki/index.md`, find the relevant page, then use its `source_files` frontmatter to open the corresponding source files directly. If a relevant source file has uncommitted changes, inspect its current contents rather than treating the wiki as current for that change.
3. **Otherwise**—the watermark is missing or behind `HEAD`, or a referenced `source_files` path no longer exists—treat the wiki as an architectural orientation hint only. Verify current paths and symbols with `codebase-memory-mcp` (`search_graph`, `get_architecture`) or `glob`/`grep`; do not assume deleted or moved paths are authoritative.

The wiki covers project overview, architecture, module purposes and key files, public APIs, concepts and patterns, configuration, and a glossary of project-specific terms. If your question is about *what* something does, *where* it lives, or *how* pieces connect, use it to orient your investigation.
