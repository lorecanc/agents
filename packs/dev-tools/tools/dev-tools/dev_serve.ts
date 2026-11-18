import { tool } from "../toolkit/_tool.js"
import { repoInfo } from "./_repo.js"
import { rootRecordFor } from "./_sessions.js"
import { MAX_TTL_S, serviceStatus, startService, stopService } from "./_serve.js"

export default tool({
  description:
    "Run the project's local service (dev server) for a short, controlled time so a browser can inspect it. `.opencode/pipeline.json` is optional: pass `command` and optionally `workspace` to start a discovered app directly; otherwise `dev_serve` uses its `serve` (or `smoke`) section or autodetects a package.json `dev`/`start` script. It picks a free port, waits until ready and returns its localhost URL. Set `with_services: true` to start contract-declared backing services alongside it and stop them together on `stop`, when the owning session goes idle, when opencode exits (even if killed), or at the time limit. Call `stop` as soon as you are done. Returns a failure-class hint (`env` | `harness` | `unclassified`) when it cannot start. Never kills processes it did not start. Use this instead of starting servers by hand.",
  args: {
    action: tool.schema.enum(["start", "status", "stop"]).describe("start: run the service and return its URL; status: is it still running; stop: end it."),
    ttl_s: tool.schema.number().optional().describe(`Maximum lifetime in seconds for start (default 900, at most ${MAX_TTL_S}).`),
    with_services: tool.schema.boolean().optional().describe("When true, start and manage contract-declared backing services (e.g. Postgres, Redis, custom services) alongside the server and stop them together on stop or session idle."),
    workspace: tool.schema.string().optional().describe("Repo-relative app directory to serve, e.g. apps/web."),
    command: tool.schema.string().optional().describe("App start command discovered in the repository; receives PORT in its environment and expands ${PORT}."),
    ready_path: tool.schema.string().optional().describe("Readiness path on the local server, e.g. /health."),
    ready_url: tool.schema.string().optional().describe("Complete readiness URL; must use http(s) on localhost, 127.0.0.1 or ::1."),
    ready_timeout_s: tool.schema.number().optional().describe("Readiness timeout in seconds (clamped to 1–180; default from the contract or 60)."),
  },
  async execute(args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    const root = rootRecordFor(info, context.sessionID)
    const ownerRoot = root ? root.sessionId : context.sessionID
    let result: any
    if (args.action === "start") result = await startService({
      info, ownerRoot, ttlS: args.ttl_s, signal: context.abort, withServices: Boolean(args.with_services),
      workspace: args.workspace, command: args.command, readyPath: args.ready_path, readyUrl: args.ready_url, readyTimeoutS: args.ready_timeout_s,
    })
    else if (args.action === "stop") result = await stopService({ info, callerRoot: ownerRoot })
    else result = await serviceStatus(info)
    return JSON.stringify(result, null, 2)
  },
})
