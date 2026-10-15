---
description: collector pipeline: behavior-preserving refactor
agent: collector-collector-pipeline-orchestrator
---

Request (refactor): $ARGUMENTS

## Preset
- Type is `refactor`. Use the Refactor Lane: explorer, planner, refactorer, tester, code reviewer.
- Behavior must be preserved exactly. The tester must show that the relevant tests pass before and after; if there is no meaningful coverage of the code being changed, say so and report the risk instead of assuming safety.
- No new features, no speculative abstractions.

## Repository state at session start

Use this as the session baseline (`base_commit`, `baseline_dirty`). Files listed under "uncommitted" existed before this session and must not be mixed into its commits.

- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted or untracked files (first 60):

!`git status --porcelain=v1 -uall 2>/dev/null | head -60 || true`
