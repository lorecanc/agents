---
name: flow-feature
description: "Flow: implement a feature (explore → build → verify → review)"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Feature request: $request

Before editing in a Git repository, record the base commit (if present) and existing changes with `git status --short --untracked-files=all`. Pass the relevant baseline to review.

Guidance:
- Scale the process to the size of the feature. Explore in parallel only if it spans several areas.
- Search for existing helpers and components before writing new ones.
- Add or update tests for the new behavior. Exercise web UI through the visual loop and native UI with the platform workflow.
- Apply the Review gate in `flow-build` to the risks introduced by this feature.
- Do not commit unless asked.
