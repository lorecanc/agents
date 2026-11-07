---
description: "Flow: fix a bug test-first (reproduce → fix → verify → review)"
agent: hybrid-flow-build
---

Bug report: $ARGUMENTS

Repository state at start:
- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse --short HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted files (first 40):
!`git status --short 2>/dev/null | head -40 || true`

Guidance (load `flow-testing`):
1. Find the root cause, not just the symptom. Check whether the same mistake exists elsewhere.
2. Reproduce with a failing test first, and confirm it fails for the reported reason. If a test is impossible, write down the manual reproduction.
3. Fix with the smallest correct change, then make the test pass and run the neighboring tests.
4. Unless the fix is trivial, run the `hybrid-flow-review` pass (correctness+security). Report the root cause in one or two lines.
