---
description: Behavior-preserving refactor
disable-model-invocation: true
arguments: request
---

Delegate this task to the decent-pipeline:orchestrator subagent (the plugin orchestrator), passing the brief below unchanged.

Request (refactor): $request

## Preset
- Type is `refactor`. Use the Refactor Lane: explorer, planner, refactorer, tester, code reviewer.
- Behavior must be preserved exactly. The tester must show that the relevant tests pass before and after; if there is no meaningful coverage of the code being changed, say so and report the risk instead of assuming safety.
- No new features, no speculative abstractions.
