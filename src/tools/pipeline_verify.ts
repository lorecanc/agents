import { tool } from "@opencode-ai/plugin"
import { repoInfo } from "./_pipeline_core.js"
import { CHECKS, runVerify } from "./_pipeline_run.js"

export default tool({
  description:
    "Run the project's verification checks (lint, typecheck, targeted tests, fast tests, full tests, build) with hard timeouts, serialized across sessions, and return a structured result with a failure-class hint (`env` | `timeout` | `unclassified`). Commands come from `.opencode/pipeline.json` (verify.*) or are autodetected. Missing commands are reported as skipped, never as passed. Stops at the first failure unless continue_on_fail is set.",
  args: {
    checks: tool.schema.array(tool.schema.enum(CHECKS as [string, ...string[]])).describe(`Checks to run, in order. Valid: ${CHECKS.join(", ")}.`),
    files: tool.schema.array(tool.schema.string()).optional().describe("Repo-relative files for test_targeted (replaces {files} in the command)."),
    continue_on_fail: tool.schema.boolean().optional().describe("Keep running later checks after a failure."),
  },
  async execute(args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    const result = await runVerify({
      info,
      checks: args.checks,
      files: args.files || [],
      stopOnFail: !args.continue_on_fail,
      signal: context.abort,
      owner: context.sessionID,
    })
    return JSON.stringify(result, null, 2)
  },
})
