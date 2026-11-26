---
name: flow-review
description: "Flow: independent review of the current changes with risk-specific focus"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Review the current changes. Do not modify anything unless I ask. $request

Use the base the user named, or inspect the working tree and index against HEAD. Include in-scope untracked files from `git status --short --untracked-files=all`.

Delegate the review to `flow-review` with the intended behavior, base and in-scope files. Choose the focus from the change and the user's request. Launch independent lenses together when each addresses a distinct risk. Then merge their findings. Remove duplicates, drop anything you can refute by reading the code, and rank by severity. Show the merged list with `path:line`, scenario and fix, then ask whether to apply the fixes.
