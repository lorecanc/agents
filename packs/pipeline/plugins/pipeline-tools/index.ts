import { Plugin } from "@opencode/plugin"

import { toV2Tool, type ToolDef } from "../../tools/toolkit/_tool.js"
import pipelineCommit from "../../tools/pipeline/pipeline_commit.js"
import pipelineState from "../../tools/pipeline/pipeline_state.js"

const NAMESPACE = "pipeline"

const definitions: Array<[string, ToolDef]> = [
  ["state", pipelineState],
  ["commit", pipelineCommit],
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
