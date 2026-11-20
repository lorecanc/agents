# Pipeline benchmark

Measures the pipeline (`pipeline-orchestrator`, or any primary agent such as `flow-build`) on small, offline tasks and compares runs, so changes to prompts,
permissions, or models can be judged with numbers instead of impressions.

Each task runs in a throwaway git repository built from `fixtures/` (in the system temp directory, removed
afterwards) with `opencode run --agent pipeline-orchestrator --auto`. Subagent models come from the installed model
routing configuration. Pass `--model` to pin the primary agent's model. Live runs need a working model and the
agents and their required packs installed in the OpenCode config. Run the examples from `bench/`
after `npm run merge` at the repository root. Set `OPENCODE_BIN` to select the OpenCode executable.
V2 runs use a private local server in the fixture directory, so each run sees its selected config and environment.

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
| `bug-average-empty` | bug fix, regression-test file change and preserved behavior |
| `feature-median` | generalization over input lengths, offsets, ordering and ties, through the exported function |
| `refactor-validate` | behavior preservation and scope |
| `security-sql-search` | secure by default: user input must travel as a query parameter (hidden injection test) |
| `frontend-pricing` | UI quality proxies: semantic plan cards, design tokens, responsive rules, focus styles, no generic gradient (judge the screenshots by hand too) |
| `smoke-missing-env` | verification honesty with `DATABASE_URL` absent during the model run. Hidden tests then check startup refusal and exercise the HTTP endpoint with a fixture-only value. Text checks look for the reported prerequisite and verification limit. |

Hidden tests (`hidden/<task>/`) are copied in only after the agent finishes, so the agent cannot see them.
Check types: `command`, `file_changed`, `regex_count`, `text_contains`, `delegated`. A check with
`"pipeline_only": true` (for example "the tester was used") describes the pipeline's lanes rather than the
outcome: it counts as n/a when the agent under test is not a `pipeline-*` agent.

## What a result contains

Pass/fail with the failed checks, and per run: steps, tokens, cost, wall time, delegations per agent, the
largest number of agents launched in one message (`max_parallel`: parallel discovery shows up here), tool
errors, guard blocks, permission denials, and safety facts: new branches/worktrees/stashes, a changed
branch, and tool calls that wrote outside the repository (attempted vs executed). A run fails if the process exits unsuccessfully, a session export is incomplete, the run is unsafe,
it times out, or it is degenerate (mostly steps with no text and no tool call; zero tokens alone is not enough,
some providers report no usage).

Metrics sum the root and its delegated sessions. On V2 the runner uses `opencode session export`
and resolves completed subagent calls through the session API's parent relation. On V1 it uses
`opencode export` and child IDs from delegation metadata. Both read unsanitized exports in memory
to score actual tool inputs and the final answer. Final-answer text is not persisted in result files.

## Limits

- V2 fixtures follow the local OpenCode 2.3.2 export schema. A synthetic tool-using session was
  imported and exported with that CLI. The offline runner tests use a fake executable for both
  command sets and do not measure a provider's model quality.
- One model run per task is noisy. Repeat runs before drawing conclusions from small differences.
- Outcomes depend on the installed config, so record it: results include the opencode version, agent,
  config dir, and model.
