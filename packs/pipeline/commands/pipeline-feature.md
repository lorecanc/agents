---
description: Implement a feature through the smallest effective lane
agent: pipeline-orchestrator
---

Request (feature): $ARGUMENTS

## Preset
- Type is `feature`. Choose the smallest lane that can implement and verify the requested behavior. Include the observable result and any unresolved design decision in the handoff.
- Add the modifiers the content calls for: frontend, swift, kotlin, docs grounding, external research (when the task needs knowledge from outside the repository), security.
- Resolve implementation details from repository evidence. Ask the user when different plausible interpretations would change the requested outcome.
