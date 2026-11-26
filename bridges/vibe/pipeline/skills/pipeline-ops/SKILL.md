---
name: pipeline-ops
description: Operational diagnostics and runtime checks, no code changes
user-invocable: true
disable-model-invocation: true
---

This command runs under the pipeline-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent pipeline-orchestrator` (or switch a live session with `/agent pipeline-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Task (operations): $request

## Preset
- Type is `ops`. Use the Ops Lane with `@pipeline-ops` in diagnostic mode: logs, infrastructure state, running services, runtime behavior.
- Ops never deploys or deletes, and it reports `UNVERIFIED` with a cause when a check cannot be completed (missing credentials, service down, port in use).
- If ops finds a code defect, report it and propose the fix lane (`/pipeline-bug`); do not fix it inside this command.
