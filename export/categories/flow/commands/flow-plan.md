---
description: "Flow: plan a change in read-only mode, then switch back to flow-build (Tab) to execute it"
agent: flow-plan
---

Plan this change: $ARGUMENTS

Repository state at start:
- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse --short HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted files (first 40):
!`git status --short 2>/dev/null | head -40 || true`

Guidance:
- You are in plan mode: read, explore and ask, but do not modify the codebase.
- If the conversation already holds context from flow-build, reuse it instead of exploring again.
- Write the plan to `.opencode/plans/<slug>.md` and end with the path and how to execute it.
