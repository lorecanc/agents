---
name: flow-plan
description: "Flow: plan a change in read-only mode; once you approve the plan,
  flow-build implements it"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Plan this change: $request

Reuse the branch, base commit and pre-existing changes already found by flow-build. Read current Git state when it matters to the plan.

Guidance:
- You are in plan mode: read, explore and ask, but do not modify the codebase.
- If the conversation already holds context from flow-build, reuse it instead of exploring again.
- Write the plan to `.opencode/plans/<slug>.md`, then ask for approval with `flow_plan_exit`.
