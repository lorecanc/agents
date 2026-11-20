---
description: Research only, no code changes (internal explorer in parallel with external researcher)
agent: pipeline-orchestrator
---

Question (research only): $ARGUMENTS

## Preset
- Type is `research`. Use the Research Lane: launch `@pipeline-explorer` (what is in our repository) and `@pipeline-researcher` (what the outside world says) in the **same turn** when the question has both parts; drop the side that has nothing to answer. If the external question depends on an internal fact, run the explorer first.
- Write a self-contained question for the researcher; it does not see the explorer's output.
- Do not modify files, run HITL, or create commits. Compare the two reports and point out where they disagree.
