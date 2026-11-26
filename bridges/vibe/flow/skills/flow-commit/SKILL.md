---
name: flow-commit
description: "Flow: commit the current work safely (explicit files, conventional
  message, no push)"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Commit the current work. $request

Load `flow-commit` and follow it.
