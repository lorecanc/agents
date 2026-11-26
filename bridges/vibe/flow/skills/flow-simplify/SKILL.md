---
name: flow-simplify
description: "Flow: simplify the current change set without changing behavior"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Simplify the current changes. $request

Load `flow-simplify`. Inspect the full in-scope diff, including staged and untracked files.

Behavior must not change. Run the relevant tests before and after. Report the specific simplification and the evidence for preserved behavior.
