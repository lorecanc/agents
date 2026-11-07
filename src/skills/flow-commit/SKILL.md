---
name: flow-commit
description: Create git commits safely when the user asks - inspect status and diff, stage explicit files only, write a conventional commit message matching the repo's history, never push, amend, skip hooks or commit secrets unless explicitly asked. Load only when the user requests a commit.
---

# Commit

Commit **only when the user asked**. Never push unless asked separately.

1. Run `git status --short`, `git diff --stat` and `git log --oneline -8`. The log shows the message style to follow.
2. Decide which files belong to this task. Leave unrelated pre-existing changes alone and mention them.
3. Check the diff for secrets, debug leftovers and generated files that should not be committed (`dist/`, lockfiles that did not need to change, `.env`). Stop and tell the user if you find any.
4. Stage **explicit paths**: `git add path/a path/b`. Never use `git add .` or `-A`.
5. Commit non-interactively: `git commit -m "<type>(<scope>): <summary>" [-m "<body>"]`.
   - The type is one of feat, fix, refactor, perf, test, docs, chore or build, unless the repo uses another convention.
   - The summary is imperative, at most 72 characters, and has no trailing period. The body explains *why*, when that is not obvious.
6. If a pre-commit hook fails, fix the cause and create a **new** commit. Never use `--no-verify`, and never `--amend` unless the user asked.
7. Report the commit hash and subject with `git log -1 --oneline`.
