---
description: Operational diagnostics and runtime checks, no code changes
disable-model-invocation: true
arguments: request
---

Delegate this task to the decent-pipeline:orchestrator subagent (the plugin orchestrator), passing the brief below unchanged.

Task (operations): $request

## Preset
- Type is `ops`. Use the Ops Lane with `@pipeline-ops` in diagnostic mode: logs, infrastructure state, running services, runtime behavior.
- Ops never deploys or deletes, and it reports `UNVERIFIED` with a cause when a check cannot be completed (missing credentials, service down, port in use).
- If ops finds a code defect, report it and propose the fix lane (`/decent-pipeline:pipeline-bug`); do not fix it inside this command.
