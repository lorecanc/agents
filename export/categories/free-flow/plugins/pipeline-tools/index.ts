import { Plugin } from "@opencode/plugin"

import { toV2Tool, type ToolDef } from "../../tools/_tool.js"
import pipelineCommit from "../../tools/pipeline_commit.js"
import pipelineEnv from "../../tools/pipeline_env.js"
import pipelineServe from "../../tools/pipeline_serve.js"
import pipelineSmoke from "../../tools/pipeline_smoke.js"
import pipelineState from "../../tools/pipeline_state.js"
import pipelineVerify from "../../tools/pipeline_verify.js"

const NAMESPACE = "pipeline"

const definitions: Array<[string, ToolDef]> = [
  ["state", pipelineState],
  ["env", pipelineEnv],
  ["commit", pipelineCommit],
  ["verify", pipelineVerify],
  ["smoke", pipelineSmoke],
  ["serve", pipelineServe],
]

export default Plugin.define({
  id: "pipeline-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const tools = definitions.map(([name, def]) =>
      toV2Tool(def, {
        name,
        namespace: NAMESPACE,
        permission: `${NAMESPACE}_${name}`,
        directory,
        worktree: directory,
      }),
    )
    await ctx.tool.transform((editor) => {
      for (const t of tools) editor.add(t)
    })
  },
})
