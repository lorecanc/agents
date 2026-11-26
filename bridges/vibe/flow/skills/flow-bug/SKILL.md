---
name: flow-bug
description: "Flow: fix a bug test-first (reproduce → fix → verify → review)"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Bug report: $request

Before editing in a Git repository, record the base commit (if present) and existing changes with `git status --short --untracked-files=all`. Pass the relevant baseline to review.

Guidance (load `flow-testing`):
1. Find the root cause, not just the symptom. Check whether the same mistake exists elsewhere.
2. For a clear, localized, reproducible bug, write and run a focused failing test before changing
   production code. If the bug is ambiguous, cross-cutting, or architectural enough to warrant
   `flow_plan_enter`, make this the first implementation step after `flow_plan_exit` approval. If
   automated testing is impossible, document the manual reproduction.
3. Fix with the smallest correct change, then make the test pass and run the neighboring tests.
4. Follow `flow-build`'s proportional Review gate, using correctness + security as the primary lens
   for bugs and adding the quality lens in parallel when the scope also crosses design. Report the
   root cause in one or two lines.
