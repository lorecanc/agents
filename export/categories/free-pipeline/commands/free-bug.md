---
description: free pipeline: fix a bug with mandatory test-first (Red then Green)
agent: free-pipeline-orchestrator
---

Request (bug fix): $ARGUMENTS

## Preset
- Type is `bug`. Fast Lane is not allowed; use the Standard Lane, or the Hard Reasoning Lane when the cause is unclear, concurrent, or spans modules.
- The TDD Bug-Fix modifier is mandatory: reproduce with a failing test (Red) before the fix, confirm Green after it. If the plan declares an alternative verification instead of an automated test, follow it.
- Still perform the full Phase 1 assessment (Size, Risk, Clarity) and say so in your output.

## Repository state at session start

Use this as the session baseline (`base_commit`, `baseline_dirty`). Files listed under "uncommitted" existed before this session and must not be mixed into its commits.

- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted or untracked files (first 60):

!`git status --porcelain=v1 -uall 2>/dev/null | head -60 || true`
