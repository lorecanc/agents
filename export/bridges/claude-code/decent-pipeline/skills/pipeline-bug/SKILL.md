---
description: "Pipeline: fix a bug with mandatory test-first (Red then Green)"
disable-model-invocation: true
arguments: request
---

Delegate this task to the decent-pipeline:orchestrator subagent (the plugin orchestrator), passing the brief below unchanged.

Request (bug fix): $request

## Preset
- Type is `bug`. Fast Lane is not allowed; use the Standard Lane, or the Hard Reasoning Lane when the cause is unclear, concurrent, or spans modules.
- The TDD Bug-Fix modifier is mandatory: reproduce with a failing test (Red) before the fix, confirm Green after it. If the plan declares an alternative verification instead of an automated test, follow it.
- Still perform the full Phase 1 assessment (Size, Risk, Clarity) and say so in your output.

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
