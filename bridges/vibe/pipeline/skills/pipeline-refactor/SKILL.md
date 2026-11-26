---
name: pipeline-refactor
description: Behavior-preserving refactor
user-invocable: true
disable-model-invocation: true
---

This command runs under the pipeline-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent pipeline-orchestrator` (or switch a live session with `/agent pipeline-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Request (refactor): $request

## Preset
- Type is `refactor`. Use the Refactor Lane: explorer, planner, refactorer, tester, code reviewer.
- Behavior must be preserved exactly. The tester must show that the relevant tests pass before and after; if there is no meaningful coverage of the code being changed, say so and report the risk instead of assuming safety.
- No new features, no speculative abstractions.
