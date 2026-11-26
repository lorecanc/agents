---
name: pipeline-feature
description: Implement a feature through the smallest effective lane
user-invocable: true
disable-model-invocation: true
---

This command runs under the pipeline-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent pipeline-orchestrator` (or switch a live session with `/agent pipeline-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Request (feature): $request

## Preset
- Type is `feature`. Choose the smallest lane that can implement and verify the requested behavior. Include the observable result and any unresolved design decision in the handoff.
- Add the modifiers the content calls for: frontend, swift, kotlin, docs grounding, external research (when the task needs knowledge from outside the repository), security.
- Resolve implementation details from repository evidence. Ask the user when different plausible interpretations would change the requested outcome.
