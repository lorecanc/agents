---
description: Operational diagnostics and runtime checks, no code changes
agent: pipeline-orchestrator
---

Task (operations): $ARGUMENTS

## Preset
- Type is `ops`. Use the Ops Lane with `@pipeline-ops` in diagnostic mode: logs, infrastructure state, running services, runtime behavior.
- Ops never deploys or deletes, and it reports `UNVERIFIED` with a cause when a check cannot be completed (missing credentials, service down, port in use).
- If ops finds a code defect, report it and propose the fix lane (`/pipeline-bug`); do not fix it inside this command.
