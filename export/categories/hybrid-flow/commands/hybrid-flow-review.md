---
description: "Flow: independent review of the current changes (correctness+security and quality, in parallel)"
agent: hybrid-flow-build
---

Review the current changes. Do not modify anything unless I ask. $ARGUMENTS

- Base: !`git rev-parse --short HEAD 2>/dev/null || echo "NO_GIT"` (uncommitted changes), unless a base or branch is given above.
- Changed files:
!`git status --short 2>/dev/null | head -60 || true`

Launch two `hybrid-flow-review` subagents **in the same message**: focus "correctness + security" and focus "quality". Then merge their findings. Remove duplicates, drop anything you can refute by reading the code, and rank by severity. Show the merged list with `path:line`, scenario and fix, then ask whether to apply the fixes.
