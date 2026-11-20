import { tool } from "../toolkit/_tool.js"
import { repoInfo } from "./_repo.js"
import { runSmoke } from "./_run.js"

export default tool({
  description:
    "Run the project's runtime smoke test as ONE bounded operation: take a cross-session lock, allocate a free port (${PORT}), start the service in the background, wait for readiness, run the checks, and ALWAYS stop the service and verify the port is free again. `.opencode/pipeline.json` is optional: `dev_smoke` uses its `smoke` section or autodetects a package.json `dev`/`start` script. Supply checks derived from the requested behavior to supplement the project checks. Readiness alone returns inconclusive. `smoke.services` names entries of the contract's `services` (e.g. a throwaway PostgreSQL) that are started first, injected as env, and always stopped after. Returns status (pass | fail | blocked | inconclusive) and a failure-class hint (`code` | `env` | `harness` | `unclassified`). Never kills processes it did not start. Use this instead of starting servers by hand.",
  args: {
    checks: tool.schema.array({
      type: "object",
      properties: {
        path: { type: "string", description: "Local path beginning with / on the started service, including any query." },
        name: { type: "string" },
        expect_status: { type: "integer", minimum: 100, maximum: 599, description: "Expected HTTP status (default 200)." },
        body_contains: { type: "string", description: "Literal text expected in the response body." },
      },
      required: ["path"],
      additionalProperties: false,
    }).optional().describe("Extra HTTP GET assertions for this run, appended to smoke.checks."),
  },
  async execute(args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    const result = await runSmoke({ info, checks: args.checks, signal: context.abort, owner: context.sessionID })
    return JSON.stringify(result, null, 2)
  },
})
