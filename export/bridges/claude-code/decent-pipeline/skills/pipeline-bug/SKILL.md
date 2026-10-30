---
description: "Pipeline: fix a bug with risk-proportionate regression verification"
disable-model-invocation: true
arguments: request
---

Delegate this task to the decent-pipeline:orchestrator subagent (the plugin orchestrator), passing the brief below unchanged.

Request (bug fix): $request

## Preset
- Type is `bug`. A trivial or small, clear, low-risk local bug whose root cause is already identified or immediately obvious may use Fast Lane, which must run targeted regression verification (`pipeline_verify` or a targeted test command) before returning.
- Non-trivial, multi-module, ambiguous, or medium/high-risk bugs must use at least Standard Lane with the TDD Bug-Fix Modifier; use Hard Reasoning Lane when the cause is unclear, concurrent, or spans modules.
- For non-trivial, ambiguous, or medium/high-risk bugs (and Hard Reasoning Lane), run the full `@pipeline-tester (Red) → @pipeline-executor → @pipeline-tester (Green)` protocol. For a small, clear, low-risk bug in Standard Lane, `@pipeline-executor` may add or update the regression test alongside the fix, then `@pipeline-tester` or `pipeline_verify` confirms Green.
- If the plan declares an alternative verification instead of an automated test, follow it.
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
