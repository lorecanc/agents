---
name: pipeline-init
description: Draft and validate the .opencode/pipeline.json verification contract
user-invocable: true
disable-model-invocation: true
---

This command runs under the pipeline-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent pipeline-orchestrator` (or switch a live session with `/agent pipeline-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Task (pipeline setup): optionally draft the repository's verification contract `.opencode/pipeline.json`. The pipeline works out of the box in any workspace; this file is useful for projects that want to declare supporting services (for example Postgres or Redis) or persist custom commands. $request

## Preset
- Goal: where useful, give `dev_verify`, `dev_smoke` and `dev_serve` explicit commands, so tester and ops never improvise starts, ports or test commands through raw bash.
- Phase 0: call `dev_env` and keep its `contract`, `workspaces_detected`, `binaries`, `docker` and `verification_outlook`.
- Delegate `@pipeline-explorer` to collect, with file evidence (README, `AGENTS.md`, `package.json`, `pyproject.toml`, `Makefile`, `docker-compose.yml`, CI workflows, `.env.example` variable names only): per sub-project the lint, typecheck, targeted-test, single-test-by-name, fast-test, full-test and build commands; the dev/start command, its port flag and health URL; the services tests need (databases, caches) and the env variable names they read.
- Draft the contract from that evidence only. If a command is not evidenced, leave it out (the tools can still autodetect checks from project files).
- Show the draft to the user with `question` (accept / edit / cancel). Only after acceptance, delegate `@pipeline-fast_lane` to write the file exactly as accepted. If the file already exists, show a diff-style summary of changes and never drop existing keys without asking.
- Then delegate `@pipeline-ops` (empirical-validation mode) to validate the entries actually drafted. For `dev_verify`, select check names from the draft and pass the repo-relative workspace, test files, filter and required service names when the check needs them. Use `dev_smoke` for root smoke checks and `dev_serve` for scoped startup/readiness. Report per check: pass / fail / skipped / blocked with the class. A `blocked` (`env`) service is a host limit, not a contract error.
- Skip HITL. Offer a checkpoint commit of `.opencode/pipeline.json` only.

## Contract fields

- Use the current repository's commands for the applicable keys under `verify` (`lint`, `typecheck`, `test_targeted`, `test_filter`, `test_fast`, `test_full`, `build`). For a sub-project, put its settings under `workspaces` keyed by its actual repo-relative directory. Each command runs from its configured workspace.
- Use `{files}` for selected test paths, `{filter}` for a test-name expression (required in `test_filter`), or `{packages}` for Go package selection. Add `timeouts` in seconds only where the project needs an override.
- For backing services, use `services` keyed by a local name. A PostgreSQL entry supports `kind` set to `postgres`, optional `version` and `env_var`. A custom entry uses `start`, `ready` and an `env` mapping. Derive versions and variable names from the project. Keep credentials out of the draft.
- A `smoke` section describes the app's `start` command, `ready` probe, any required service names and `checks`. Use `${PORT}` for the tool-selected port. Choose a request and expected response that exercise the app's actual behavior. A browser-only `serve` section can declare the same startup and readiness information without smoke checks.
