import { tool } from "@opencode-ai/plugin"
import { repoInfo } from "./_pipeline_core.js"
import { runSmoke } from "./_pipeline_run.js"

export default tool({
  description:
    "Run the project's runtime smoke test as ONE bounded operation: take a cross-session lock, allocate a free port (${PORT}), start the service in the background, wait for readiness, run the checks, and ALWAYS stop the service and verify the port is free again. Configured in the `smoke` section of `.opencode/pipeline.json`. Returns status (pass | fail | blocked | inconclusive) and a failure-class hint (`code` | `env` | `harness` | `unclassified`). Never kills processes it did not start. Use this instead of starting servers by hand.",
  args: {},
  async execute(_args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    const result = await runSmoke({ info, signal: context.abort, owner: context.sessionID })
    return JSON.stringify(result, null, 2)
  },
})
