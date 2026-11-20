---
description: "Flow: implement a feature (explore → build → verify → review)"
agent: flow-build
---

Feature request: $ARGUMENTS

Before editing in a Git repository, record the base commit (if present) and existing changes with `git status --short --untracked-files=all`. Pass the relevant baseline to review.

Guidance:
- Scale the process to the size of the feature. Explore in parallel only if it spans several areas.
- Search for existing helpers and components before writing new ones.
- Add or update tests for the new behavior. Exercise web UI through the visual loop and native UI with the platform workflow.
- Apply the Review gate in `flow-build` to the risks introduced by this feature.
- Do not commit unless asked.
