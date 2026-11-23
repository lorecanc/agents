---
name: flow-commit
description: Create git commits safely when the user asks - inspect status and diff, stage explicit files only, write a conventional commit message matching the repo's history, never push, amend, skip hooks or commit secrets unless explicitly asked. Load only when the user requests a commit.
---

# Commit

Commit **only when the user asked**. Never push unless asked separately.

1. Inspect `git status --short --untracked-files=all`, both working and cached diffs, and the recent commit subjects. Read in-scope untracked files before staging them.
2. Reconcile those changes with the requested scope and the session's edits. If one file mixes unrelated hunks, leave it out and explain the conflict unless the user explicitly includes the entire file. A path alone does not establish ownership of every hunk.
3. Check the diff for secrets, debug leftovers and generated files that should not be committed (`dist/`, lockfiles that did not need to change, `.env`). Stop and tell the user if you find any.
4. For an explicitly staged-only request, inspect the complete cached diff and commit the index as-is with `git commit -m "<subject>"` when every staged hunk is in scope. Leave the working tree out of this operation.
5. For a whole-file commit, stage the agreed paths with `git add -- <paths>`, recheck their diff, and commit with `git commit --only -m "<subject>" -- <paths>`. Explicit paths preserve unrelated changes already in the index.
   - The type is one of feat, fix, refactor, perf, test, docs, chore or build, unless the repo uses another convention.
   - The summary is imperative, at most 72 characters, and has no trailing period. The body explains *why*, when that is not obvious.
6. If a pre-commit hook fails, fix the cause and create a **new** commit. Never use `--no-verify`, and never `--amend` unless the user asked.
7. Check the resulting commit and remaining index with `git show --stat --oneline HEAD` and `git diff --cached --stat`. Report the hash, subject and any excluded changes.
