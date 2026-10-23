---
description: mistral pipeline: draft and validate the .opencode/pipeline.json verification contract
agent: mistral-pipeline-orchestrator
---

Task (pipeline setup): draft the repository's verification contract `.opencode/pipeline.json`. $ARGUMENTS

## Preset
- Goal: give `pipeline_verify`, `pipeline_smoke` and `pipeline_serve` explicit commands, so tester and ops never improvise starts, ports or test commands through raw bash.
- Phase 0: call `pipeline_env` and keep its `contract`, `workspaces_detected`, `binaries`, `docker` and `verification_outlook`.
- Delegate `@mistral-pipeline-explorer` to collect, with file evidence (README, `AGENTS.md`, `package.json`, `pyproject.toml`, `Makefile`, `docker-compose.yml`, CI workflows, `.env.example` variable names only): per sub-project the lint, typecheck, targeted-test, single-test-by-name, fast-test, full-test and build commands; the dev/start command, its port flag and health URL; the services tests need (databases, caches) and the env variable names they read.
- Draft the contract from that evidence only. If a command is not evidenced, leave it out (a missing check is reported as `skipped`, which is honest; a guessed one is not).
- Show the draft to the user with `question` (accept / edit / cancel). Only after acceptance, delegate `@mistral-pipeline-fast_lane` to write the file exactly as accepted. If the file already exists, show a diff-style summary of changes and never drop existing keys without asking.
- Then delegate `@mistral-pipeline-ops` (empirical-validation mode) to validate it: `pipeline_verify` with `checks: ["lint", "typecheck", "test_fast"]` (per workspace, with `with_services` where declared) and `pipeline_smoke` if a smoke section exists. Report per check: pass / fail / skipped / blocked with the class. A `blocked` (`env`) service is a host limit, not a contract error.
- Skip HITL. Offer a checkpoint commit of `.opencode/pipeline.json` only.

## Contract schema (keep only what applies)

```json
{
  "verify": {
    "lint": "npm run lint",
    "typecheck": "npx --no-install tsc --noEmit",
    "test_targeted": "npx --no-install vitest run {files}",
    "test_filter": "npx --no-install vitest run {files} -t {filter}",
    "test_fast": "npm test --silent",
    "test_full": "npm test --silent",
    "build": "npm run build"
  },
  "timeouts": { "test_full": 900 },
  "services": {
    "db": { "kind": "postgres", "version": "16", "env_var": "DATABASE_URL" },
    "cache": {
      "start": "redis-server --port ${PORT}",
      "ready": { "port": "${PORT}", "timeout_s": 30 },
      "env": { "REDIS_URL": "redis://127.0.0.1:${PORT}" }
    }
  },
  "workspaces": {
    "backend": {
      "verify": { "test_fast": "python3 -m pytest -q -x", "test_targeted": "python3 -m pytest -q {files}" },
      "services": { "db": { "kind": "postgres" } }
    }
  },
  "smoke": {
    "start": "npm run dev -- --port ${PORT}",
    "ready": { "port": "${PORT}", "timeout_s": 60 },
    "services": ["db"],
    "checks": [{ "name": "root responds", "url": "http://127.0.0.1:${PORT}/", "expect_status": 200 }]
  }
}
```

- Placeholders: `{files}` (repo- or workspace-relative test files), `{filter}` (test name expression; required in `test_filter`), `{packages}` (Go: `./dir` of the files), `${PORT}` (free port chosen by the tool).
- `kind: "postgres"` is a throwaway cluster: native `initdb`/`postgres` when installed, otherwise Docker when the daemon is reachable; exported env is `DATABASE_URL` (or `env_var`) plus `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`. Never put credentials or real connection strings in the contract.

## Repository state at session start

Use this as the session baseline (`base_commit`, `baseline_dirty`).

- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse HEAD 2>/dev/null || echo "NO_GIT"`
- Existing contract: !`test -f .opencode/pipeline.json && echo "present" || echo "absent"`
