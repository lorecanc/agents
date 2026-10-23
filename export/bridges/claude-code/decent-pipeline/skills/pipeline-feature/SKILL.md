---
description: "Pipeline: implement a feature through the smallest effective lane"
disable-model-invocation: true
arguments: request
---

Delegate this task to the decent-pipeline:orchestrator subagent (the plugin orchestrator), passing the brief below unchanged.

Request (feature): $request

## Preset
- Type is `feature`. Choose the lane from your Phase 1 assessment: Standard for small, low-risk changes; Hard Reasoning for high risk, architecture, concurrency, or multi-file interactions.
- Add the modifiers the content calls for: frontend, swift, kotlin, docs grounding, external research (when the task needs knowledge from outside the repository), security.
- If the request is ambiguous or underspecified, ask before routing.

## Repository state at session start

Use this as the session baseline (`base_commit`, `baseline_dirty`). Files listed under "uncommitted" existed before this session and must not be mixed into its commits.

- Branch: 

```bash
git branch --show-current 2>/dev/null || echo "NO_GIT"
```


- HEAD: 

```bash
git rev-parse HEAD 2>/dev/null || echo "NO_GIT"
```


- Uncommitted or untracked files (first 60):



```bash
git status --porcelain=v1 -uall 2>/dev/null | head -60 || true
```
