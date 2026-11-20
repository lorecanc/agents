---
description: "Flow: plan a change in read-only mode; once you approve the plan, flow-build implements it"
agent: flow-plan
---

Plan this change: $ARGUMENTS

Reuse the branch, base commit and pre-existing changes already found by flow-build. Read current Git state when it matters to the plan.

Guidance:
- You are in plan mode: read, explore and ask, but do not modify the codebase.
- If the conversation already holds context from flow-build, reuse it instead of exploring again.
- Write the plan to `.opencode/plans/<slug>.md`, then ask for approval with `flow_plan_exit`.
