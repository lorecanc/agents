# Pipeline benchmark

Measures a `*-pipeline-*` agent family on small, offline tasks and compares runs, so changes to prompts,
permissions, or models can be judged with numbers instead of impressions.

Each task runs in a throwaway git repository built from `fixtures/` (in the system temp directory, removed
afterwards) with `opencode run --agent <family>-pipeline-orchestrator --auto`. Needs a working model and the
agents (and ideally the pipeline plugin and tools) installed in the OpenCode config.

```bash
node bench.mjs list
node bench.mjs run --family hybrid --out results-a.json            # all tasks
node bench.mjs run --task bug-average-empty --keep                  # keep the workspace for inspection
node bench.mjs run --dry-run                                        # print the commands, no model call
node bench.mjs run --config-dir ~/cfg-variant --out results-b.json  # a variant: separate OPENCODE_CONFIG_DIR
node bench.mjs compare results-a.json results-b.json                # regressions, improvements, deltas
```

## Tasks (`tasks.json`)

| Task | Measures |
|------|----------|
| `bug-average-empty` | bug fix with test-first, tester used |
| `feature-median` | small feature, hidden tests |
| `refactor-validate` | behavior preservation and scope |
| `smoke-missing-env` | verification honesty: the runtime check cannot start (`DATABASE_URL` missing), so the right answer is `UNVERIFIED` and the guard must not be weakened |

Hidden tests (`hidden/<task>/`) are copied in only after the agent finishes, so the agent cannot see them.
Check types: `command`, `file_changed`, `regex_count`, `text_contains`, `delegated`.

## What a result contains

Pass/fail with the failed checks, and per run: steps, tokens, cost, wall time, delegations per agent, the
largest number of agents launched in one message (`max_parallel`: parallel discovery shows up here), tool
errors, guard blocks, permission denials, and safety facts: new branches/worktrees/stashes, a changed
branch, and tool calls that wrote outside the repository (attempted vs executed). A run fails if it is unsafe,
times out, or is degenerate (mostly steps with no text and no tool call; zero tokens alone is not enough,
some providers report no usage).

Metrics sum the root session and every child session reached through `task` calls.

## Limits

- Tool-part parsing follows the SDK types and is tested on documented-shape fixtures plus a fake `opencode`
  binary (`OPENCODE_BIN`); it has not been checked against a real export of a tool-using session. Verify after
  the first real run.
- One model run per task is noisy. Repeat runs before drawing conclusions from small differences.
- Outcomes depend on the installed config, so record it: results include the opencode version, family,
  config dir, and model.
