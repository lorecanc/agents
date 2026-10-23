import { tool } from "@opencode-ai/plugin"
import { collectEnv } from "./_pipeline_env.js"

export default tool({
  description:
    "Read-only probe of what this machine can verify, to call ONCE at session start (Phase 0) before planning verification: Docker (CLI, socket, daemon reachable), database/runtime binaries on PATH (psql, pg_ctl, redis-server, python3, go, ...), the `.opencode/pipeline.json` contract (verify checks defined vs autodetected, declared services, smoke/serve, workspaces), detected sub-projects, whether the pipeline-guard plugin registered this session and which pipeline_* tools are installed, configured MCP servers (names only), whether variables named in .env.example/.env.sample are set (never their values), and a derived `verification_outlook` (unit tests, db-backed tests, runtime smoke, browser: feasible or why not). Bounded (~5 s), never modifies anything.",
  args: {
    workspace: tool.schema.string().optional().describe("Optional repo-relative sub-project directory (monorepo) to autodetect checks and read .env.example from."),
  },
  async execute(args, context) {
    try {
      const out = await collectEnv({ directory: context.directory || context.worktree, workspace: args.workspace, sessionId: context.sessionID })
      return JSON.stringify(out, null, 2)
    } catch (e: any) {
      return JSON.stringify({ status: "unknown", error: `pipeline_env failed: ${e && e.message}` })
    }
  },
})
