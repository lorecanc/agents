---
description: mistral pipeline: operational diagnostics and runtime checks, no code changes
agent: mistral-mistral-pipeline-orchestrator
---

Task (operations): $ARGUMENTS

## Preset
- Type is `ops`. Use the Ops Lane with `@mistral-pipeline-ops` in diagnostic mode: logs, infrastructure state, running services, runtime behavior.
- Ops never deploys or deletes, and it reports `UNVERIFIED` with a cause when a check cannot be completed (missing credentials, service down, port in use).
- If ops finds a code defect, report it and propose the fix lane (`/mistral-bug`); do not fix it inside this command.

## Repository state at session start

Use this as the session baseline (`base_commit`, `baseline_dirty`). Files listed under "uncommitted" existed before this session and must not be mixed into its commits.

- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted or untracked files (first 60):

!`git status --porcelain=v1 -uall 2>/dev/null | head -60 || true`
