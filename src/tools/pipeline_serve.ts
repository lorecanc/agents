import { tool } from "@opencode-ai/plugin"
import { repoInfo, rootRecordFor } from "./_pipeline_core.js"
import { MAX_TTL_S, serviceStatus, startService, stopService } from "./_pipeline_serve.js"

export default tool({
  description:
    "Run the project's local service (dev server) for a short, controlled time so a browser can inspect it. `start` picks a free port, starts the service from the `serve` (or `smoke`) section of `.opencode/pipeline.json`, waits until it is ready and returns its localhost URL. The service ALWAYS ends: on `stop`, when the owning session goes idle, when opencode exits (even if killed), or at the time limit. Call `stop` as soon as you are done. Returns a failure-class hint (`env` | `harness` | `unclassified`) when it cannot start. Never kills processes it did not start. Use this instead of starting servers by hand.",
  args: {
    action: tool.schema.enum(["start", "status", "stop"]).describe("start: run the service and return its URL; status: is it still running; stop: end it."),
    ttl_s: tool.schema.number().optional().describe(`Maximum lifetime in seconds for start (default 900, at most ${MAX_TTL_S}).`),
  },
  async execute(args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    const root = rootRecordFor(info, context.sessionID)
    const ownerRoot = root ? root.sessionId : context.sessionID
    let result: any
    if (args.action === "start") result = await startService({ info, ownerRoot, ttlS: args.ttl_s, signal: context.abort })
    else if (args.action === "stop") result = await stopService({ info, callerRoot: ownerRoot })
    else result = await serviceStatus(info)
    return JSON.stringify(result, null, 2)
  },
})
