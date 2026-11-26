---
name: pipeline-research
description: Research only, no code changes (internal explorer in parallel with
  external researcher)
user-invocable: true
disable-model-invocation: true
---

This command runs under the pipeline-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent pipeline-orchestrator` (or switch a live session with `/agent pipeline-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Question (research only): $request

## Preset
- Type is `research`. Use the Research Lane: launch `@pipeline-explorer` (what is in our repository) and `@pipeline-researcher` (what the outside world says) in the **same turn** when the question has both parts; drop the side that has nothing to answer. If the external question depends on an internal fact, run the explorer first.
- Write a self-contained question for the researcher; it does not see the explorer's output.
- Do not modify files, run HITL, or create commits. Compare the two reports and point out where they disagree.
