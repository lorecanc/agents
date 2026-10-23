import { tool } from "@opencode-ai/plugin"
import { repoInfo } from "./_pipeline_core.js"
import { CHECKS, runVerify } from "./_pipeline_run.js"

export default tool({
  description:
    "Run the project's verification checks (lint, typecheck, targeted tests, tests by name, fast tests, full tests, build) with hard timeouts, serialized across sessions, and return a structured result with a failure-class hint (`env` | `timeout` | `unclassified`). Commands come from `.opencode/pipeline.json` (verify.*, or workspaces.<dir>.verify) or are autodetected (pytest, vitest, jest, go, cargo, npm scripts). Use this instead of running test commands in bash: it handles the working directory, env vars and throwaway services for you. " +
    "`workspace` runs everything inside a subdirectory (e.g. `backend`) of a monorepo. `filter` runs only the tests whose name matches (check `test_filter`: pytest -k, vitest/jest -t, go -run, cargo test <name>), optionally limited to `files`. " +
    "`with_services` starts services declared in the contract's `services` section (e.g. a throwaway PostgreSQL: native initdb, else docker), exports their env (DATABASE_URL, PGHOST, PGPORT, PGUSER...) to every check, and ALWAYS stops them and deletes their data afterwards; if a service cannot run the result is `blocked` with the exact reason. " +
    "Missing commands are reported as skipped, never as passed. Stops at the first failure unless continue_on_fail is set.",
  args: {
    checks: tool.schema
      .array(tool.schema.enum(CHECKS as [string, ...string[]]))
      .optional()
      .describe(`Checks to run, in order. Valid: ${CHECKS.join(", ")}. Default: test_filter if filter is set, else test_targeted if files are set, else test_fast.`),
    files: tool.schema.array(tool.schema.string()).optional().describe("Repo-relative files (even with workspace) for test_targeted and test_filter."),
    filter: tool.schema.string().optional().describe("Test name or expression for the test_filter check (quoted safely)."),
    workspace: tool.schema.string().optional().describe("Repo-relative subdirectory to run the checks in (monorepos), e.g. `backend`."),
    with_services: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Names from the contract's `services` (top-level or workspaces.<dir>.services) to start before the checks, in order."),
    continue_on_fail: tool.schema.boolean().optional().describe("Keep running later checks after a failure."),
  },
  async execute(args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    const result = await runVerify({
      info,
      checks: args.checks,
      files: args.files || [],
      filter: args.filter,
      workspace: args.workspace,
      withServices: args.with_services || [],
      stopOnFail: !args.continue_on_fail,
      signal: context.abort,
      owner: context.sessionID,
    })
    return JSON.stringify(result, null, 2)
  },
})
