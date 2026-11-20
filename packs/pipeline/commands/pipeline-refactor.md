---
description: Behavior-preserving refactor
agent: pipeline-orchestrator
---

Request (refactor): $ARGUMENTS

## Preset
- Type is `refactor`. Use the Refactor Lane: explorer, planner, refactorer, tester, code reviewer.
- Behavior must be preserved exactly. The tester must show that the relevant tests pass before and after; if there is no meaningful coverage of the code being changed, say so and report the risk instead of assuming safety.
- No new features, no speculative abstractions.
