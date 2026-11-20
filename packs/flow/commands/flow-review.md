---
description: "Flow: independent review of the current changes with risk-specific focus"
agent: flow-build
---

Review the current changes. Do not modify anything unless I ask. $ARGUMENTS

Use the base the user named, or inspect the working tree and index against HEAD. Include in-scope untracked files from `git status --short --untracked-files=all`.

Delegate the review to `flow-review` with the intended behavior, base and in-scope files. Choose the focus from the change and the user's request. Launch independent lenses together when each addresses a distinct risk. Then merge their findings. Remove duplicates, drop anything you can refute by reading the code, and rank by severity. Show the merged list with `path:line`, scenario and fix, then ask whether to apply the fixes.
