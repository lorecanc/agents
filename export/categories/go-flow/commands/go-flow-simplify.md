---
description: "Flow: simplify the current change set without changing behavior"
agent: go-flow-build
---

Simplify the current changes. $ARGUMENTS

Load `flow-simplify` and apply it to the diff against HEAD (plus untracked files):
!`git status --short 2>/dev/null | head -60 || true`

Behavior must not change. Run the relevant tests before and after. Report what you reused, removed or inlined, and the net line count.
