---
description: "Flow: commit the current work safely (explicit files, conventional message, no push)"
agent: mistral-flow-build
---

Commit the current work. $ARGUMENTS

Load `flow-commit` and follow it.
- Status:
!`git status --short 2>/dev/null | head -60 || true`
- Recent messages (style to match):
!`git log --oneline -8 2>/dev/null || true`
