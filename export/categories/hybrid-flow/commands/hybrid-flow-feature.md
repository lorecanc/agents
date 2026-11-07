---
description: "Flow: implement a feature (explore → build → verify → review)"
agent: hybrid-flow-build
---

Feature request: $ARGUMENTS

Repository state at start (base for the review and for "pre-existing" changes):
- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse --short HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted files (first 40):
!`git status --short 2>/dev/null | head -40 || true`

Guidance:
- Scale the process to the size of the feature. Explore in parallel only if it spans several areas.
- Search for existing helpers and components before writing new ones.
- Add or update tests for the new behavior. User-facing UI goes through `flow-frontend-design` and the visual loop.
- Unless the change is trivial, finish with the two parallel `hybrid-flow-review` passes (correctness+security, quality).
- Do not commit unless asked.
