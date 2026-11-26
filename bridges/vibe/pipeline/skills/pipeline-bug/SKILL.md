---
name: pipeline-bug
description: Fix a bug with risk-proportionate regression verification
user-invocable: true
disable-model-invocation: true
---

This command runs under the pipeline-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent pipeline-orchestrator` (or switch a live session with `/agent pipeline-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Request (bug fix): $request

## Preset
- Type is `bug`. A trivial or small, clear, low-risk local bug whose root cause is already identified or immediately obvious may use Fast Lane, which must run targeted regression verification (`dev_verify` or a targeted test command) before returning.
- Non-trivial, multi-module, ambiguous, or medium/high-risk bugs must use at least Standard Lane with the TDD Bug-Fix Modifier; use Hard Reasoning Lane when the cause is unclear, concurrent, or spans modules.
- For non-trivial, ambiguous, or medium/high-risk bugs (and Hard Reasoning Lane), run the full `@pipeline-tester (Red) → @pipeline-executor → @pipeline-tester (Green)` protocol. For a small, clear, low-risk bug in Standard Lane, `@pipeline-executor` may add or update the regression test alongside the fix, then `@pipeline-tester` or `dev_verify` confirms Green.
- If the plan declares an alternative verification instead of an automated test, follow it.
- Still perform the full Phase 1 assessment (Size, Risk, Clarity) and say so in your output.
