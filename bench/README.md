# Pipeline benchmark

Measures the pipeline (`pipeline-orchestrator`, or any primary agent such as `flow-build`) on small, offline tasks and compares runs, so changes to prompts,
permissions, or models can be judged with numbers instead of impressions.

Each task runs in a throwaway git repository built from `fixtures/` (in the system temp directory, removed
afterwards) with `opencode run --agent pipeline-orchestrator --auto`. Subagent models come from the installed model
configurations (see `ARCHETIPI.md`); pass `--model` to pin the orchestrator's model. Needs a working model and the
agents (and ideally the pipeline plugin and tools) installed in the OpenCode config.

```bash
node bench.mjs list
node bench.mjs run --out results-a.json                            # all tasks
node bench.mjs run --task bug-average-empty --keep                  # keep the workspace for inspection
node bench.mjs run --dry-run                                        # print the commands, no model call
node bench.mjs run --config-dir ~/cfg-variant --out results-b.json  # a variant: separate OPENCODE_CONFIG_DIR
node bench.mjs run --agent flow-build --out results-flow.json       # another primary agent (flow family)
node bench.mjs compare results-a.json results-b.json                # regressions, improvements, deltas
```

## Tasks (`tasks.json`)

| Task | Measures |
|------|----------|
| `bug-average-empty` | bug fix with test-first, tester used |
| `feature-median` | small feature, hidden tests |
| `refactor-validate` | behavior preservation and scope |
| `security-sql-search` | secure by default: user input must travel as a query parameter (hidden injection test) |
| `frontend-pricing` | UI quality proxies: semantic plan cards, design tokens, responsive rules, focus styles, no generic gradient (judge the screenshots by hand too) |
| `smoke-missing-env` | verification honesty: the runtime check cannot start (`DATABASE_URL` missing), so the right answer is `UNVERIFIED` and the guard must not be weakened |

Hidden tests (`hidden/<task>/`) are copied in only after the agent finishes, so the agent cannot see them.
Check types: `command`, `file_changed`, `regex_count`, `text_contains`, `delegated`. A check with
`"pipeline_only": true` (for example "the tester was used") describes the pipeline's lanes rather than the
outcome: it counts as n/a when the agent under test is not a `pipeline-*` agent.

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
- Outcomes depend on the installed config, so record it: results include the opencode version, agent,
  config dir, and model.
